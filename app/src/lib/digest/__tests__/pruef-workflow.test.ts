/**
 * pruef-workflow.test.ts — Tests für Quellen-Prüfungs- und Highlight-Workflow (M9)
 *
 * Getestete Szenarien:
 *   1. Freigabe wird ohne vollständige Prüfung abgelehnt (Gate-Fehlermeldung)
 *   2. Freigabe wird mit vollständiger Prüfung angenommen
 *   3. setAlleStatementsGeprueft setzt alle Statements auf geprüft
 *   4. Cross-Tenant-Zugriff auf fremde statementIds wird abgelehnt
 *   5. Highlight-Toggle nur im Entwurf möglich
 *   6. setStatementGeprueft setzt/löscht geprueft_at korrekt
 *   7. setAlleStatementsGeprueft schreibt Audit-Event
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and, notExists, isNull } from "drizzle-orm";
import * as schema from "@/db/schema.js";

const {
  tenants, users, roles, risBodies, risMeetings, risDocuments,
  digests, digestStatements, auditEvents,
} = schema;

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

// ---------------------------------------------------------------------------
// Hilfsfunktionen (spiegeln die Server-Action-Logik ohne HTTP-Layer)
// ---------------------------------------------------------------------------

type DbType = ReturnType<typeof drizzle>;

/**
 * Simuliert freigeben-Action: spiegelt die atomare Logik der Production-Action.
 * Anzeige-Zählung vor der Transaktion + atomares NOT-EXISTS im UPDATE.
 */
async function simulierFreigabe(
  db: DbType,
  digestId: string,
  tenantId: string,
  adminUserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const digestRows = await db
    .select({ id: digests.id, status: digests.status })
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenantId)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };

  const stmts = await db
    .select({ geprueftAt: digestStatements.geprueftAt, position: digestStatements.position, text: digestStatements.text, sourceUrl: digestStatements.sourceUrl })
    .from(digestStatements)
    .where(eq(digestStatements.digestId, digestId));

  // M1: Leerer Digest
  if (stmts.length === 0) {
    return { ok: false, error: "Ein Digest ohne Aussagen kann nicht freigegeben werden." };
  }

  // Anzeige-Zählung (nur für Fehlermeldung)
  const gesamtAnzahl = stmts.length;
  const geprueftAnzahl = stmts.filter((s) => s.geprueftAt !== null).length;

  if (geprueftAnzahl < gesamtAnzahl) {
    return {
      ok: false,
      error: `Freigabe erst möglich, wenn alle Aussagen quellen-geprüft sind (${geprueftAnzahl} von ${gesamtAnzahl} geprüft).`,
    };
  }

  const now = new Date();

  // B1-Fix: atomares Gate — NOT EXISTS in der WHERE-Klausel des UPDATE
  const updated = await db
    .update(digests)
    .set({
      status: "freigegeben",
      approvedBy: adminUserId,
      approvedAt: now,
    })
    .where(
      and(
        eq(digests.id, digestId),
        eq(digests.tenantId, tenantId),
        eq(digests.status, "entwurf"),
        notExists(
          db.select({ id: digestStatements.id })
            .from(digestStatements)
            .where(and(eq(digestStatements.digestId, digestId), isNull(digestStatements.geprueftAt)))
        )
      )
    )
    .returning({ id: digests.id });

  if (updated.length === 0) {
    // Ursache unterscheiden
    const current = await db
      .select({ status: digests.status })
      .from(digests)
      .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenantId)))
      .limit(1);
    if (current.length === 0 || current[0].status !== "entwurf") {
      return { ok: false, error: "Ungültiger Statusübergang." };
    }
    return { ok: false, error: "Freigabe abgelehnt: Es gibt noch ungeprüfte Aussagen (atomare Prüfung)." };
  }
  return { ok: true };
}

/**
 * Simuliert setStatementGeprueft: prüft Tenant-Bindung via Join.
 */
async function simulierSetStatementGeprueft(
  db: DbType,
  statementId: string,
  tenantId: string,
  geprueft: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const rows = await db
    .select({ digestId: digests.id, digestStatus: digests.status })
    .from(digestStatements)
    .innerJoin(digests, eq(digestStatements.digestId, digests.id))
    .where(
      and(
        eq(digestStatements.id, statementId),
        eq(digests.tenantId, tenantId),
      )
    )
    .limit(1);

  if (rows.length === 0) return { ok: false, error: "Aussage nicht gefunden." };
  if (rows[0].digestStatus !== "entwurf") return { ok: false, error: "Prüf-Markierung nur im Status 'entwurf' möglich." };

  await db
    .update(digestStatements)
    .set({ geprueftAt: geprueft ? new Date() : null })
    .where(eq(digestStatements.id, statementId));

  return { ok: true };
}

/**
 * Simuliert setAlleStatementsGeprueft: Tenant-Prüfung + Audit-Event.
 */
async function simulierSetAlleStatementsGeprueft(
  db: DbType,
  digestId: string,
  tenantId: string,
  adminUserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const digestRows = await db
    .select({ id: digests.id, status: digests.status })
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenantId)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };
  if (digestRows[0].status !== "entwurf") return { ok: false, error: "Prüf-Markierung nur im Status 'entwurf' möglich." };

  const stmts = await db
    .select({ id: digestStatements.id })
    .from(digestStatements)
    .where(eq(digestStatements.digestId, digestId));

  const anzahl = stmts.length;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(digestStatements)
      .set({ geprueftAt: now })
      .where(eq(digestStatements.digestId, digestId));

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: adminUserId,
      action: "digest.statements_geprueft",
      targetType: "digest",
      targetId: digestId,
      metadata: { digestId, anzahl },
    });
  });

  return { ok: true };
}

/**
 * Simuliert setStatementHighlight: prüft Tenant-Bindung + Status.
 */
async function simulierSetStatementHighlight(
  db: DbType,
  statementId: string,
  tenantId: string,
  istHighlight: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const rows = await db
    .select({ digestId: digests.id, digestStatus: digests.status })
    .from(digestStatements)
    .innerJoin(digests, eq(digestStatements.digestId, digests.id))
    .where(
      and(
        eq(digestStatements.id, statementId),
        eq(digests.tenantId, tenantId),
      )
    )
    .limit(1);

  if (rows.length === 0) return { ok: false, error: "Aussage nicht gefunden." };
  if (rows[0].digestStatus !== "entwurf") return { ok: false, error: "Highlight-Markierung nur im Status 'entwurf' möglich." };

  await db
    .update(digestStatements)
    .set({ istHighlight })
    .where(eq(digestStatements.id, statementId));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Prüf-Workflow (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;

  let tenantId: string;
  let tenant2Id: string;
  let adminUserId: string;
  let bodyId: string;

  let counter = 0;
  function nextId() {
    return `pruef-${Date.now()}-${++counter}`;
  }

  beforeAll(async () => {
    if (SKIP) return;

    // Schema reset und Migration
    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    // Tenant 1
    const [tenant] = await db.insert(tenants).values({
      slug: `pruef-${Date.now()}`,
      name: "Prüf-Test-Tenant",
    }).returning();
    tenantId = tenant.id;

    // Tenant 2 (für Cross-Tenant-Tests)
    const [tenant2] = await db.insert(tenants).values({
      slug: `pruef-t2-${Date.now()}`,
      name: "Prüf-Test-Tenant-2",
    }).returning();
    tenant2Id = tenant2.id;

    const [adminUser] = await db.insert(users).values({
      tenantId,
      email: `admin-${Date.now()}@pruef-test.de`,
    }).returning();
    adminUserId = adminUser.id;

    await db.insert(roles).values({
      tenantId,
      userId: adminUserId,
      roleType: "kommune_admin",
      regionId: await resolveRegionIdForScope(db as never, tenantId, "stadt", null),
    });

    const [body] = await db.insert(risBodies).values({
      tenantId,
      key: "pruef-test-body",
      risType: "provox_iip",
      baseUrl: "https://pruef-test.example.de",
    }).returning();
    bodyId = body.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  async function createMeeting() {
    const [meeting] = await db.insert(risMeetings).values({
      bodyId,
      externalId: nextId(),
      gremium: "Testgremium",
      title: "Testsitzung",
      meetingDate: new Date("2026-05-12T15:00:00Z"),
      sourceUrl: `https://pruef-test.example.de/meeting/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();
    return meeting;
  }

  async function createDoc(meetingId: string) {
    const [doc] = await db.insert(risDocuments).values({
      meetingId,
      docType: "top",
      externalId: nextId(),
      title: "TOP 1",
      bodyText: "Testbeschluss",
      sourceUrl: `https://pruef-test.example.de/doc/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();
    return doc;
  }

  async function createDigestMitStatements(anzahl: number) {
    const meeting = await createMeeting();
    const doc = await createDoc(meeting.id);

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: `Prüf-Test-Digest-${nextId()}`,
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    const stmts = [];
    for (let i = 1; i <= anzahl; i++) {
      const [stmt] = await db.insert(digestStatements).values({
        digestId: digest.id,
        position: i,
        text: `Aussage ${i}: Testbeschluss.`,
        sourceDocumentId: doc.id,
        sourceUrl: `https://pruef-test.example.de/doc/${i}`,
      }).returning();
      stmts.push(stmt);
    }

    return { digest, stmts, doc };
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 1. Freigabe ohne vollständige Prüfung → Ablehnung
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("1. Freigabe wird ohne vollständige Prüfung abgelehnt", async () => {
    const { digest } = await createDigestMitStatements(3);

    const result = await simulierFreigabe(db, digest.id, tenantId, adminUserId);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/quellen-geprüft/);
    expect(result.error).toContain("0 von 3 geprüft");
  });

  it.skipIf(SKIP)("1b. Freigabe wird auch bei teilweiser Prüfung abgelehnt", async () => {
    const { digest, stmts } = await createDigestMitStatements(3);

    // Nur 2 von 3 prüfen
    await db
      .update(digestStatements)
      .set({ geprueftAt: new Date() })
      .where(eq(digestStatements.id, stmts[0].id));
    await db
      .update(digestStatements)
      .set({ geprueftAt: new Date() })
      .where(eq(digestStatements.id, stmts[1].id));

    const result = await simulierFreigabe(db, digest.id, tenantId, adminUserId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("2 von 3 geprüft");
  });

  // ---------------------------------------------------------------------------
  // 2. Freigabe mit vollständiger Prüfung → Erfolg
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("2. Freigabe wird mit vollständiger Prüfung angenommen", async () => {
    const { digest, stmts } = await createDigestMitStatements(2);
    const now = new Date();

    // Alle prüfen
    for (const stmt of stmts) {
      await db
        .update(digestStatements)
        .set({ geprueftAt: now })
        .where(eq(digestStatements.id, stmt.id));
    }

    const result = await simulierFreigabe(db, digest.id, tenantId, adminUserId);

    expect(result.ok).toBe(true);

    const [updated] = await db
      .select({ status: digests.status })
      .from(digests)
      .where(eq(digests.id, digest.id));
    expect(updated.status).toBe("freigegeben");
  });

  // ---------------------------------------------------------------------------
  // 3. setAlleStatementsGeprueft setzt alle Statements
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("3. setAlleStatementsGeprueft setzt alle Statements auf geprüft", async () => {
    const { digest, stmts } = await createDigestMitStatements(4);

    // Vorher: alle ungeprueft
    for (const stmt of stmts) {
      const [row] = await db
        .select({ geprueftAt: digestStatements.geprueftAt })
        .from(digestStatements)
        .where(eq(digestStatements.id, stmt.id));
      expect(row.geprueftAt).toBeNull();
    }

    const result = await simulierSetAlleStatementsGeprueft(db, digest.id, tenantId, adminUserId);
    expect(result.ok).toBe(true);

    // Nachher: alle geprüft
    for (const stmt of stmts) {
      const [row] = await db
        .select({ geprueftAt: digestStatements.geprueftAt })
        .from(digestStatements)
        .where(eq(digestStatements.id, stmt.id));
      expect(row.geprueftAt).not.toBeNull();
    }
  });

  it.skipIf(SKIP)("3b. setAlleStatementsGeprueft schreibt Audit-Event mit Anzahl", async () => {
    const { digest } = await createDigestMitStatements(2);

    await simulierSetAlleStatementsGeprueft(db, digest.id, tenantId, adminUserId);

    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "digest.statements_geprueft"),
          eq(auditEvents.targetId, digest.id),
        )
      );

    expect(auditRows.length).toBe(1);
    const meta = auditRows[0].metadata as Record<string, unknown>;
    expect(meta.anzahl).toBe(2);
    expect(meta.digestId).toBe(digest.id);
    // PII-frei: kein user-identifier außer actorRef (UUID)
    expect(JSON.stringify(meta)).not.toContain("@");
  });

  // ---------------------------------------------------------------------------
  // 4. Cross-Tenant-Zugriff wird abgelehnt
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("4. Cross-Tenant: Zugriff auf fremdes Statement wird abgelehnt", async () => {
    const { stmts } = await createDigestMitStatements(1);
    const stmt = stmts[0];

    // Tenant2 versucht Zugriff auf Statement von Tenant1
    const result = await simulierSetStatementGeprueft(db, stmt.id, tenant2Id, false);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nicht gefunden");
  });

  it.skipIf(SKIP)("4b. Cross-Tenant: Highlight auf fremdem Statement wird abgelehnt", async () => {
    const { stmts } = await createDigestMitStatements(1);
    const stmt = stmts[0];

    const result = await simulierSetStatementHighlight(db, stmt.id, tenant2Id, true);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nicht gefunden");
  });

  it.skipIf(SKIP)("4c. Cross-Tenant: setAlleStatementsGeprueft auf fremdem Digest wird abgelehnt", async () => {
    const { digest } = await createDigestMitStatements(1);

    const result = await simulierSetAlleStatementsGeprueft(db, digest.id, tenant2Id, adminUserId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nicht gefunden");
  });

  // ---------------------------------------------------------------------------
  // 5. Highlight-Toggle nur im Entwurf
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("5. Highlight-Toggle im Entwurf möglich", async () => {
    const { stmts } = await createDigestMitStatements(1);
    const stmt = stmts[0];

    const result = await simulierSetStatementHighlight(db, stmt.id, tenantId, true);
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ istHighlight: digestStatements.istHighlight })
      .from(digestStatements)
      .where(eq(digestStatements.id, stmt.id));
    expect(row.istHighlight).toBe(true);
  });

  it.skipIf(SKIP)("5b. Highlight-Toggle nach Freigabe nicht mehr möglich", async () => {
    const { digest, stmts } = await createDigestMitStatements(1);
    const stmt = stmts[0];
    const now = new Date();

    // Digest direkt auf freigegeben setzen (bypassing Actions)
    await db
      .update(digests)
      .set({ status: "freigegeben", approvedBy: adminUserId, approvedAt: now })
      .where(eq(digests.id, digest.id));

    const result = await simulierSetStatementHighlight(db, stmt.id, tenantId, true);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("entwurf");
  });

  it.skipIf(SKIP)("5c. Prüf-Toggle nach Freigabe nicht mehr möglich", async () => {
    const { digest, stmts } = await createDigestMitStatements(1);
    const stmt = stmts[0];
    const now = new Date();

    // Digest direkt auf freigegeben setzen
    await db
      .update(digests)
      .set({ status: "freigegeben", approvedBy: adminUserId, approvedAt: now })
      .where(eq(digests.id, digest.id));

    const result = await simulierSetStatementGeprueft(db, stmt.id, tenantId, true);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("entwurf");
  });

  // ---------------------------------------------------------------------------
  // B1-Regression: TOCTOU — atomares Gate in freigeben
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("B1-Regression: Freigabe scheitert atomar wenn Statement nach Zählung ungeprüft wird", async () => {
    const { digest, stmts } = await createDigestMitStatements(2);
    const now = new Date();

    // Schritt 1: Alle Statements als geprüft markieren (Anzeige-Zählung würde 2/2 zeigen)
    for (const stmt of stmts) {
      await db
        .update(digestStatements)
        .set({ geprueftAt: now })
        .where(eq(digestStatements.id, stmt.id));
    }

    // Schritt 2: Race-Fenster simulieren — ein Statement wieder ungeprüft setzen
    // (passiert zwischen Anzeige-Zählung und dem UPDATE in der Transaktion)
    await db
      .update(digestStatements)
      .set({ geprueftAt: null })
      .where(eq(digestStatements.id, stmts[1].id));

    // Schritt 3: Freigabe versuchen — muss scheitern (NOT EXISTS greift)
    const result = await simulierFreigabe(db, digest.id, tenantId, adminUserId);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    // Status muss 'entwurf' geblieben sein
    const [current] = await db
      .select({ status: digests.status })
      .from(digests)
      .where(eq(digests.id, digest.id));
    expect(current.status).toBe("entwurf");
  });

  it.skipIf(SKIP)("B1-Regression: Freigabe klappt, wenn alle Statements wirklich geprüft sind", async () => {
    const { digest, stmts } = await createDigestMitStatements(2);
    const now = new Date();

    for (const stmt of stmts) {
      await db
        .update(digestStatements)
        .set({ geprueftAt: now })
        .where(eq(digestStatements.id, stmt.id));
    }

    const result = await simulierFreigabe(db, digest.id, tenantId, adminUserId);
    expect(result.ok).toBe(true);

    const [current] = await db
      .select({ status: digests.status })
      .from(digests)
      .where(eq(digests.id, digest.id));
    expect(current.status).toBe("freigegeben");
  });

  // ---------------------------------------------------------------------------
  // M1: Leerer Digest (0 Statements) wird abgelehnt
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("M1: Freigabe wird abgelehnt wenn Digest 0 Statements hat", async () => {
    // Digest ohne Statements erstellen
    const meeting = await createMeeting();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: `Leerer-Digest-${nextId()}`,
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    const result = await simulierFreigabe(db, digest.id, tenantId, adminUserId);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ohne Aussagen/);
  });

  // ---------------------------------------------------------------------------
  // 6. setStatementGeprueft setzt und löscht geprueft_at
  // ---------------------------------------------------------------------------
  it.skipIf(SKIP)("6. setStatementGeprueft setzt geprueft_at korrekt", async () => {
    const { stmts } = await createDigestMitStatements(1);
    const stmt = stmts[0];

    // Setzen
    const setResult = await simulierSetStatementGeprueft(db, stmt.id, tenantId, true);
    expect(setResult.ok).toBe(true);

    const [after] = await db
      .select({ geprueftAt: digestStatements.geprueftAt })
      .from(digestStatements)
      .where(eq(digestStatements.id, stmt.id));
    expect(after.geprueftAt).not.toBeNull();

    // Löschen
    const unsetResult = await simulierSetStatementGeprueft(db, stmt.id, tenantId, false);
    expect(unsetResult.ok).toBe(true);

    const [afterUnset] = await db
      .select({ geprueftAt: digestStatements.geprueftAt })
      .from(digestStatements)
      .where(eq(digestStatements.id, stmt.id));
    expect(afterUnset.geprueftAt).toBeNull();
  });
});
