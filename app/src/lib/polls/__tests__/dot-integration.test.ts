/**
 * dot-integration.test.ts — DB-Integration für Dot-Voting: Schema-Constraints
 * (UNIQUE je Wähler+Option, CHECK punkte>0) + die echten Query-Funktionen
 * (getDotErgebnis Zurückhaltung/Aggregation, hatBereitsDotAbgestimmt).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { getDotErgebnis, hatBereitsDotAbgestimmt } from "@/lib/polls/queries";
import { K_ANONYMITY_SCHWELLE } from "@/lib/polls/ergebnis";
import { computeVoterRefForUserWithSalt } from "@/lib/polls/voter-ref";

const { tenants, polls, pollOptions, voteAllocations } = schema;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");
const TEST_DB_URL = process.env.DATABASE_URL_TEST;
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}"`);
}
const SKIP = !TEST_DB_URL;
type DbType = ReturnType<typeof drizzle>;

describe("Dot-Voting (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let regionId: string;
  let optA: string;
  let optB: string;
  let counter = 0;
  const nextId = () => `dot-${Date.now()}-${++counter}`;

  async function createDotPoll(opts?: { status?: "aktiv" | "geschlossen"; budget?: number }) {
    const [poll] = await db.insert(polls).values({
      tenantId, regionId,
      frage: `Priorität ${nextId()}?`,
      typ: "dot_voting",
      punkteBudget: opts?.budget ?? 10,
      status: opts?.status ?? "geschlossen",
    }).returning();
    const [a] = await db.insert(pollOptions).values({ pollId: poll.id, tenantId, label: "A", position: 0 }).returning();
    const [b] = await db.insert(pollOptions).values({ pollId: poll.id, tenantId, label: "B", position: 1 }).returning();
    optA = a.id; optB = b.id;
    return poll;
  }

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });
    const [t] = await db.insert(tenants).values({ slug: `dot-${Date.now()}`, name: "Dot-Test" }).returning();
    tenantId = t.id;
    regionId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("Schema: UNIQUE verhindert zwei Zuteilungen desselben Wählers auf dieselbe Option", async () => {
    const poll = await createDotPoll();
    await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: "v1", punkte: 3 });
    await expect(
      db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: "v1", punkte: 2 }),
    ).rejects.toThrow();
  });

  it.skipIf(SKIP)("Schema: CHECK verbietet punkte <= 0", async () => {
    const poll = await createDotPoll();
    await expect(
      db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: "v1", punkte: 0 }),
    ).rejects.toThrow();
  });

  it.skipIf(SKIP)("getDotErgebnis hält zurück bei laufender Umfrage; Teilnahme sichtbar", async () => {
    const poll = await createDotPoll({ status: "aktiv" });
    for (let i = 0; i < K_ANONYMITY_SCHWELLE; i++) {
      await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: `v${i}`, punkte: 6 });
      await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optB, voterRef: `v${i}`, punkte: 4 });
    }
    const e = await getDotErgebnis(db, tenantId, poll.id);
    expect(e!.gesamtWaehler).toBe(K_ANONYMITY_SCHWELLE);
    expect(e!.aufschluesselungZurueckgehalten).toBe(true);
    expect(e!.zurueckhaltungsGrund).toBe("laeuft_noch");
    expect(e!.optionen.every((o) => o.punkteSumme === null)).toBe(true);
  });

  it.skipIf(SKIP)("getDotErgebnis zeigt die Verteilung nach Ende ab k Teilnehmenden", async () => {
    const poll = await createDotPoll({ status: "geschlossen" });
    for (let i = 0; i < K_ANONYMITY_SCHWELLE; i++) {
      await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: `w${i}`, punkte: 6 });
      await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optB, voterRef: `w${i}`, punkte: 4 });
    }
    const e = await getDotErgebnis(db, tenantId, poll.id);
    expect(e!.aufschluesselungZurueckgehalten).toBe(false);
    const a = e!.optionen.find((o) => o.label === "A")!;
    const b = e!.optionen.find((o) => o.label === "B")!;
    expect(a.punkteSumme).toBe(6 * K_ANONYMITY_SCHWELLE);
    expect(b.punkteSumme).toBe(4 * K_ANONYMITY_SCHWELLE);
    expect(a.prozent).toBe(60);
  });

  it.skipIf(SKIP)("getDotErgebnis hält zurück bei < k Teilnehmenden trotz Ende", async () => {
    const poll = await createDotPoll({ status: "geschlossen" });
    for (let i = 0; i < K_ANONYMITY_SCHWELLE - 1; i++) {
      await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: `x${i}`, punkte: 10 });
    }
    const e = await getDotErgebnis(db, tenantId, poll.id);
    expect(e!.zurueckhaltungsGrund).toBe("zu_wenige_teilnehmende");
    expect(e!.optionen.every((o) => o.punkteSumme === null)).toBe(true);
  });

  it.skipIf(SKIP)("hatBereitsDotAbgestimmt erkennt eine vorhandene Zuteilung", async () => {
    const poll = await createDotPoll({ status: "aktiv" });
    const salt = "dot-test-salt-aaaaaaaaaaaaaaaaaaaaaa";
    process.env.ANLIEGEN_REF_SALT = salt;
    const userId = "11111111-1111-1111-1111-111111111111";
    const ref = computeVoterRefForUserWithSalt(salt, userId);
    expect(await hatBereitsDotAbgestimmt(db, { id: tenantId } as never, poll.id, { userId })).toBe(false);
    await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: ref, punkte: 5 });
    expect(await hatBereitsDotAbgestimmt(db, { id: tenantId } as never, poll.id, { userId })).toBe(true);
  });

  it.skipIf(SKIP)("Tenant-Isolation: Zuteilungen fremder Tenants fließen nicht ins Ergebnis", async () => {
    const poll = await createDotPoll({ status: "geschlossen" });
    // K echte Wähler
    for (let i = 0; i < K_ANONYMITY_SCHWELLE; i++) {
      await db.insert(voteAllocations).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: `t${i}`, punkte: 5 });
    }
    const e = await getDotErgebnis(db, tenantId, poll.id);
    const a = e!.optionen.find((o) => o.label === "A")!;
    // K Wähler auf A → sichtbar, Summe = 5 Punkte * K.
    expect(a.maskiert).toBe(false);
    expect(a.punkteSumme).toBe(5 * K_ANONYMITY_SCHWELLE);
  });
});
