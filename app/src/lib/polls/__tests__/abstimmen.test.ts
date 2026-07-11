/**
 * abstimmen.test.ts — DB-Integrationstests für die Mitmach-Schleife (M3, ADR-014).
 *
 * Spiegelt die Kern-Logik von abstimmen() OHNE HTTP/Cookie-Layer (wie das
 * Muster in digest/__tests__/pruef-workflow.test.ts). Der voter_ref/Insert/
 * Audit-Pfad ist identisch zur Production-Action; nur Tenant/Session werden als
 * Parameter übergeben statt aus Request-Kontext gelesen.
 *
 * ADR-014: Mitstimmen erfordert Stufe ≥ 1 (Konto). Anonymes Abstimmen entfällt
 *   → nicht eingeloggt = needLogin (keine Stimme). voter_ref immer user-Domain.
 *
 * Getestete Sicherheits-Eigenschaften (Vertrauensprodukt):
 *   0. Nicht eingeloggt → needLogin, keine Stimme.
 *   1. Doppelstimme → nur 1 gezählt (UNIQUE + onConflictDoNothing).
 *   2. Verbindlich: Stufe1 abgelehnt, Stufe2 zugelassen.
 *   3. Stufe-1 kann unverbindlich abstimmen (war_verifiziert=false).
 *   4. Tenant-Isolation: Stimme/Ergebnis fremder Tenant unsichtbar.
 *   5. Secret Ballot: Audit poll.voted enthält KEINE choice.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { computeVoterRefForUserWithSalt } from "@/lib/polls/voter-ref";
import { aggregateVotes } from "@/lib/polls/ergebnis";

const { tenants, users, polls, votes, auditEvents } = schema;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");

const TEST_DB_URL = process.env.DATABASE_URL_TEST;

if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test"`);
  }
}

const SKIP = !TEST_DB_URL;
const SALT = "test-vote-salt-aaaaaaaaaaaaaaaaaaaaaaaa";

type DbType = ReturnType<typeof drizzle>;

interface SimVoter {
  /** null ⇒ nicht eingeloggt (ADR-014: needLogin, keine Stimme). */
  userId: string | null;
  // Stufe des Wählers (für verbindlich-Gating + war_verifiziert-Snapshot)
  stufe: 0 | 1 | 2;
}

/**
 * Spiegelt abstimmen() (ADR-014): Stufe-1-Pflicht, Poll-Status/Zeitfenster,
 * verbindlich-Gating, voter_ref (user-Domain), Insert mit onConflictDoNothing +
 * Audit OHNE choice — alles in derselben Transaktion. Rückgabe wie die Action.
 */
async function simulierAbstimmen(
  db: DbType,
  tenantId: string,
  pollId: string,
  choice: string,
  voter: SimVoter,
): Promise<{ ok: boolean; alreadyVoted?: boolean; needLogin?: boolean; error?: string }> {
  // Stufe-1-Pflicht: ohne Konto KEINE Stimme.
  if (!voter.userId) {
    return { ok: false, needLogin: true, error: "Bitte melden Sie sich an, um mitzustimmen." };
  }

  const pollRows = await db
    .select({
      id: polls.id,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
    })
    .from(polls)
    .where(and(eq(polls.id, pollId), eq(polls.tenantId, tenantId)))
    .limit(1);

  const poll = pollRows[0];
  if (!poll) return { ok: false, error: "Diese Frage gibt es nicht." };

  const now = new Date();
  if (poll.status !== "aktiv") return { ok: false, error: "nicht offen" };
  if (poll.opensAt && poll.opensAt > now) return { ok: false, error: "noch nicht begonnen" };
  if (poll.closesAt && poll.closesAt <= now) return { ok: false, error: "beendet" };

  if (!["ja", "nein", "enthaltung"].includes(choice)) {
    return { ok: false, error: "Ungültige Auswahl." };
  }

  const warVerifiziert = voter.stufe >= 2;

  if (poll.verbindlich && voter.stufe < 2) {
    return {
      ok: false,
      error: "Diese verbindliche Abstimmung ist verifizierten Bürger:innen vorbehalten.",
    };
  }

  const voterRef = computeVoterRefForUserWithSalt(SALT, voter.userId);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(votes)
      .values({
        pollId: poll.id,
        tenantId,
        voterRef,
        choice,
        warVerifiziert,
        ipHash: null,
      })
      .onConflictDoNothing({ target: [votes.pollId, votes.voterRef] })
      .returning({ id: votes.id });

    if (inserted.length === 0) {
      return { ok: true, alreadyVoted: true };
    }

    // SECRET BALLOT: keine choice ins Audit.
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: voterRef,
      action: "poll.voted",
      targetType: "poll",
      targetId: poll.id,
      metadata: { pollId: poll.id, warVerifiziert },
    });

    return { ok: true, alreadyVoted: false };
  });
}

async function ergebnisVon(db: DbType, tenantId: string, pollId: string) {
  const rows = await db
    .select({ choice: votes.choice, warVerifiziert: votes.warVerifiziert })
    .from(votes)
    .where(and(eq(votes.pollId, pollId), eq(votes.tenantId, tenantId)));
  return aggregateVotes(rows);
}

describe("Abstimmen (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;

  let tenantId: string;
  let tenant2Id: string;
  let stufe2UserId: string;
  let stufe1UserId: string;
  // Zweiter Stufe-2-User im Fremd-Tenant für Kollisionsfreiheit.
  let stufe1UserBId: string;

  let counter = 0;
  function nextId() {
    return `vote-${Date.now()}-${++counter}`;
  }

  async function createPoll(opts: {
    tenantId: string;
    verbindlich?: boolean;
    status?: "entwurf" | "aktiv" | "geschlossen";
  }) {
    const [poll] = await db
      .insert(polls)
      .values({
        tenantId: opts.tenantId,
        scopeLevel: "stadt",
        frage: `Testfrage ${nextId()}?`,
        verbindlich: opts.verbindlich ?? false,
        status: opts.status ?? "aktiv",
      })
      .returning();
    return poll;
  }

  beforeAll(async () => {
    if (SKIP) return;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [tenant] = await db
      .insert(tenants)
      .values({ slug: `vote-${Date.now()}`, name: "Vote-Test-Tenant" })
      .returning();
    tenantId = tenant.id;

    const [tenant2] = await db
      .insert(tenants)
      .values({ slug: `vote-t2-${Date.now()}`, name: "Vote-Test-Tenant-2" })
      .returning();
    tenant2Id = tenant2.id;

    // Stufe-2-User (wohnsitz-verifiziert)
    const [u2] = await db
      .insert(users)
      .values({
        tenantId,
        email: `s2-${Date.now()}@vote-test.de`,
        minAgeConfirmedAt: new Date(),
        verificationStatus: "verified",
        residencyVerifiedAt: new Date(),
      })
      .returning();
    stufe2UserId = u2.id;

    // Stufe-1-User (eingeloggt, nicht verifiziert)
    const [u1] = await db
      .insert(users)
      .values({
        tenantId,
        email: `s1-${Date.now()}@vote-test.de`,
        minAgeConfirmedAt: new Date(),
        verificationStatus: "pending",
      })
      .returning();
    stufe1UserId = u1.id;

    const [u1b] = await db
      .insert(users)
      .values({
        tenantId,
        email: `s1b-${Date.now()}@vote-test.de`,
        minAgeConfirmedAt: new Date(),
        verificationStatus: "pending",
      })
      .returning();
    stufe1UserBId = u1b.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // 0. Nicht eingeloggt → needLogin, keine Stimme (ADR-014).
  it.skipIf(SKIP)("0. Nicht eingeloggt → needLogin, zählt nicht", async () => {
    const poll = await createPoll({ tenantId });
    const r = await simulierAbstimmen(db, tenantId, poll.id, "ja", { userId: null, stufe: 0 });
    expect(r.ok).toBe(false);
    expect(r.needLogin).toBe(true);

    const erg = await ergebnisVon(db, tenantId, poll.id);
    expect(erg.gesamt).toBe(0);
  });

  // 1. Doppelstimme → nur 1 gezählt
  it.skipIf(SKIP)("1. Doppelstimme desselben Wählers zählt nur einmal", async () => {
    const poll = await createPoll({ tenantId });

    const r1 = await simulierAbstimmen(db, tenantId, poll.id, "ja", {
      userId: stufe2UserId,
      stufe: 2,
    });
    expect(r1.ok).toBe(true);
    expect(r1.alreadyVoted).toBe(false);

    // Zweiter Versuch mit ANDERER Wahl — darf nicht überschreiben/zählen.
    const r2 = await simulierAbstimmen(db, tenantId, poll.id, "nein", {
      userId: stufe2UserId,
      stufe: 2,
    });
    expect(r2.ok).toBe(true);
    expect(r2.alreadyVoted).toBe(true);

    const erg = await ergebnisVon(db, tenantId, poll.id);
    expect(erg.gesamt).toBe(1);
    // Ursprüngliche Wahl 'ja' bleibt erhalten — direkt in der DB geprüft,
    // weil das Aggregat kleine Gruppen serverseitig maskiert (k-Anonymität).
    const voteRows = await db
      .select({ choice: schema.votes.choice })
      .from(schema.votes)
      .where(
        and(
          eq(schema.votes.pollId, poll.id),
          eq(schema.votes.tenantId, tenantId)
        )
      );
    expect(voteRows).toHaveLength(1);
    expect(voteRows[0].choice).toBe("ja");
    // k-Anonymität: bei 1 Stimme ist die Aufschlüsselung vollständig maskiert.
    expect(erg.optionen.every((o) => o.maskiert && o.count === null)).toBe(true);
  });

  // 2. Verbindlich-Gating
  it.skipIf(SKIP)("2a. Verbindlich lehnt Stufe-1 (eingeloggt, unverifiziert) ab", async () => {
    const poll = await createPoll({ tenantId, verbindlich: true });
    const r = await simulierAbstimmen(db, tenantId, poll.id, "ja", {
      userId: stufe1UserId,
      stufe: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verifizierten/);

    const erg = await ergebnisVon(db, tenantId, poll.id);
    expect(erg.gesamt).toBe(0);
  });

  it.skipIf(SKIP)("2b. Verbindlich lässt Stufe-2 zu, Snapshot war_verifiziert=true", async () => {
    const poll = await createPoll({ tenantId, verbindlich: true });
    const r = await simulierAbstimmen(db, tenantId, poll.id, "ja", {
      userId: stufe2UserId,
      stufe: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.alreadyVoted).toBe(false);

    const erg = await ergebnisVon(db, tenantId, poll.id);
    expect(erg.gesamt).toBe(1);
    expect(erg.verifiziert).toBe(1);
  });

  // 3. Stufe-1 kann unverbindlich abstimmen (war_verifiziert=false)
  it.skipIf(SKIP)("3. Stufe-1 kann unverbindlich abstimmen (war_verifiziert=false)", async () => {
    const poll = await createPoll({ tenantId, verbindlich: false });
    const r = await simulierAbstimmen(db, tenantId, poll.id, "enthaltung", {
      userId: stufe1UserId,
      stufe: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.alreadyVoted).toBe(false);

    const erg = await ergebnisVon(db, tenantId, poll.id);
    expect(erg.gesamt).toBe(1);
    expect(erg.verifiziert).toBe(0);
  });

  it.skipIf(SKIP)("3b. Zwei verschiedene User zählen als zwei Stimmen", async () => {
    const poll = await createPoll({ tenantId });
    await simulierAbstimmen(db, tenantId, poll.id, "ja", { userId: stufe1UserId, stufe: 1 });
    await simulierAbstimmen(db, tenantId, poll.id, "nein", { userId: stufe1UserBId, stufe: 1 });
    const erg = await ergebnisVon(db, tenantId, poll.id);
    expect(erg.gesamt).toBe(2);
  });

  // 4. Tenant-Isolation
  it.skipIf(SKIP)("4. Tenant-Isolation: fremder Tenant sieht/erreicht die Stimme nicht", async () => {
    const poll = await createPoll({ tenantId });
    await simulierAbstimmen(db, tenantId, poll.id, "ja", { userId: stufe1UserId, stufe: 1 });

    // Tenant2 versucht über dieselbe pollId abzustimmen → Poll nicht gefunden.
    const fremd = await simulierAbstimmen(db, tenant2Id, poll.id, "ja", {
      userId: stufe2UserId,
      stufe: 2,
    });
    expect(fremd.ok).toBe(false);
    expect(fremd.error).toMatch(/gibt es nicht/);

    // Ergebnis unter Tenant2-Scope ist leer.
    const ergFremd = await ergebnisVon(db, tenant2Id, poll.id);
    expect(ergFremd.gesamt).toBe(0);

    // Eigenes Ergebnis hat die Stimme.
    const ergEigen = await ergebnisVon(db, tenantId, poll.id);
    expect(ergEigen.gesamt).toBe(1);
  });

  // 5. Secret Ballot: Audit enthält KEINE choice
  it.skipIf(SKIP)("5. Audit poll.voted enthält weder die Wahl noch PII", async () => {
    const poll = await createPoll({ tenantId });
    const choice = "nein";
    const r = await simulierAbstimmen(db, tenantId, poll.id, choice, {
      userId: stufe2UserId,
      stufe: 2,
    });
    expect(r.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.voted"), eq(auditEvents.targetId, poll.id)));

    expect(auditRows.length).toBe(1);
    const meta = auditRows[0].metadata as Record<string, unknown>;
    // Keine Wahl im Audit
    expect(JSON.stringify(meta)).not.toContain("nein");
    expect(meta).not.toHaveProperty("choice");
    // actorRef ist das Pseudonym, NICHT die userId.
    const expectedRef = computeVoterRefForUserWithSalt(SALT, stufe2UserId);
    expect(auditRows[0].actorRef).toBe(expectedRef);
    expect(auditRows[0].actorRef).not.toBe(stufe2UserId);
    // PII-frei
    expect(JSON.stringify(meta)).not.toContain("@");
  });

  // Zusatz: Entwurf/geschlossen kann nicht beworben werden
  it.skipIf(SKIP)("6. Abstimmen auf nicht-aktive Umfrage wird abgelehnt", async () => {
    const entwurf = await createPoll({ tenantId, status: "entwurf" });
    const r = await simulierAbstimmen(db, tenantId, entwurf.id, "ja", {
      userId: stufe1UserId,
      stufe: 1,
    });
    expect(r.ok).toBe(false);
  });
});
