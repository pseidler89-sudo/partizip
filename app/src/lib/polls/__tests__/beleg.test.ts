/**
 * beleg.test.ts — Beleg-Code (D4, ADR-016): receipt-freier Aufnahme-Beleg.
 *
 * Ruft die ECHTEN Funktionen auf (generateBelegCode / insertBelegCode /
 * getBelegListe), keine gespiegelte Logik. Unit-Teil läuft immer; der
 * Integrations-Teil nur mit DATABASE_URL_TEST.
 *
 * Getestete Eigenschaften:
 *   - Format/Alphabet + CSPRNG-Streuung (keine Kollisionen über viele Codes).
 *   - 1 Beleg je Stimme, in derselben Transaktion (Invariante #Belege == #Stimmen).
 *   - getBelegListe: null vor Poll-Ende (kein Leak), sortierte Liste nach Schluss.
 *   - Tenant-Isolation.
 *   - SECRET BALLOT (Schema): vote_receipts kennt KEINE Spalte voter_ref/choice/user.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import {
  generateBelegCode,
  insertBelegCode,
  getBelegListe,
  BELEG_PATTERN,
} from "@/lib/polls/beleg";

const { tenants, polls, votes, voteReceipts } = schema;

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

type DbType = ReturnType<typeof drizzle>;

describe("Beleg-Code Format (Unit)", () => {
  it("entspricht dem Muster BELEG-XXXX-XXXX", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateBelegCode()).toMatch(BELEG_PATTERN);
    }
  });

  it("enthält keine mehrdeutigen Zeichen (I, L, O, U)", () => {
    for (let i = 0; i < 200; i++) {
      const body = generateBelegCode().replace(/^BELEG-/, "");
      expect(body).not.toMatch(/[ILOU]/);
    }
  });

  it("streut breit (CSPRNG) — keine Kollisionen über 5000 Codes", () => {
    const set = new Set<string>();
    for (let i = 0; i < 5000; i++) set.add(generateBelegCode());
    expect(set.size).toBe(5000);
  });
});

describe("Beleg-Code Persistenz (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let tenant2Id: string;

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

    const [t1] = await db
      .insert(tenants)
      .values({ slug: `beleg-${Date.now()}`, name: "Beleg-Test" })
      .returning();
    tenantId = t1.id;
    const [t2] = await db
      .insert(tenants)
      .values({ slug: `beleg2-${Date.now()}`, name: "Beleg-Test-2" })
      .returning();
    tenant2Id = t2.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  async function createPoll(tid: string, status: "aktiv" | "geschlossen" = "aktiv") {
    const regionId = await resolveRegionIdForScope(db as never, tid, "stadt", null);
    const [p] = await db
      .insert(polls)
      .values({ tenantId: tid, regionId, frage: "Beleg-Frage?", status })
      .returning();
    return p;
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  it.skipIf(SKIP)("vote_receipts kennt KEINE Person/Wahl-Spalte (Secret Ballot)", async () => {
    const cols = await sql_`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'vote_receipts'`;
    const names = cols.map((c) => (c as { column_name: string }).column_name).sort();
    expect(names).toEqual(["code", "id", "poll_id", "tenant_id"]);
    // Keine Brücke zu Person oder Wahl — auch kein created_at (Zeit-Korrelation).
    expect(names).not.toContain("voter_ref");
    expect(names).not.toContain("choice");
    expect(names).not.toContain("user_id");
    expect(names).not.toContain("created_at");
  });

  it.skipIf(SKIP)("1 Beleg je Stimme; getBelegListe erst nach Schluss, sortiert", async () => {
    const poll = await createPoll(tenantId, "aktiv");

    // Drei Stimmen mit jeweils einem Beleg in DERSELBEN Transaktion wie die Stimme.
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const code = await db.transaction(async (tx) => {
        await tx.insert(votes).values({
          pollId: poll.id,
          tenantId,
          voterRef: `ref-${i}-${Date.now()}`,
          choice: i === 0 ? "ja" : "nein",
          warVerifiziert: false,
        });
        return insertBelegCode(tx as unknown as DbType, tenantId, poll.id);
      });
      codes.push(code);
    }

    // #Belege == #Stimmen
    const rcount = await db
      .select({ code: voteReceipts.code })
      .from(voteReceipts)
      .where(and(eq(voteReceipts.pollId, poll.id), eq(voteReceipts.tenantId, tenantId)));
    expect(rcount.length).toBe(3);

    // Vor Schluss: kein Leak.
    expect(await getBelegListe(db, tenantId, poll.id)).toBeNull();

    // Nach Schluss: sortierte, vollständige Liste.
    await db.update(polls).set({ status: "geschlossen" }).where(eq(polls.id, poll.id));
    const liste = await getBelegListe(db, tenantId, poll.id);
    expect(liste).not.toBeNull();
    expect(liste!.length).toBe(3);
    expect([...liste!].sort()).toEqual(liste); // bereits aufsteigend sortiert
    expect(new Set(liste)).toEqual(new Set(codes));
    for (const c of liste!) expect(c).toMatch(BELEG_PATTERN);
  });

  it.skipIf(SKIP)("Tenant-Isolation: fremder Tenant sieht die Belege nicht", async () => {
    const poll = await createPoll(tenantId, "geschlossen");
    await db.transaction(async (tx) => {
      await tx.insert(votes).values({
        pollId: poll.id,
        tenantId,
        voterRef: `iso-${Date.now()}`,
        choice: "ja",
        warVerifiziert: false,
      });
      await insertBelegCode(tx as unknown as DbType, tenantId, poll.id);
    });

    // Unter dem fremden Tenant-Scope: Umfrage nicht gefunden → null.
    expect(await getBelegListe(db, tenant2Id, poll.id)).toBeNull();
    // Eigener Scope: ein Beleg.
    const eigen = await getBelegListe(db, tenantId, poll.id);
    expect(eigen?.length).toBe(1);
  });

  it.skipIf(SKIP)("Belege prüfbar nach Ablauf der Schlusszeit, auch wenn status noch 'aktiv'", async () => {
    // Schlusszeit in der Vergangenheit, aber (noch) kein harter Status-Wechsel.
    const [poll] = await db
      .insert(polls)
      .values({
        tenantId,
        regionId: await resolveRegionIdForScope(db as never, tenantId, "stadt", null),
        frage: "Abgelaufen, aber noch aktiv?",
        status: "aktiv",
        closesAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning();

    await db.transaction(async (tx) => {
      await tx.insert(votes).values({
        pollId: poll.id,
        tenantId,
        voterRef: `expired-${Date.now()}`,
        choice: "ja",
        warVerifiziert: false,
      });
      await insertBelegCode(tx as unknown as DbType, tenantId, poll.id);
    });

    // Trotz status='aktiv' ist die Abstimmung beendet (closesAt<=now) → Belege sichtbar.
    const liste = await getBelegListe(db, tenantId, poll.id);
    expect(liste).not.toBeNull();
    expect(liste!.length).toBe(1);
  });
});
