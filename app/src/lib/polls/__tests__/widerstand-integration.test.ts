/**
 * widerstand-integration.test.ts — DB-Integration für die Widerstandsabfrage:
 * Schema-Constraints (UNIQUE je Wähler+Option, CHECK 0 ≤ wert ≤ 10, wert=0 WIRD
 * gespeichert) + die echten Query-Funktionen (getWiderstandsErgebnis
 * Zurückhaltung/Aggregation/Gewinner, hatBereitsWiderstandAbgestimmt).
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
import { getWiderstandsErgebnis, hatBereitsWiderstandAbgestimmt } from "@/lib/polls/queries";
import { K_ANONYMITY_SCHWELLE } from "@/lib/polls/ergebnis";
import { computeVoterRefForUserWithSalt } from "@/lib/polls/voter-ref";

const { tenants, polls, pollOptions, voteResistances } = schema;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");
const TEST_DB_URL = process.env.DATABASE_URL_TEST;
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}"`);
}
const SKIP = !TEST_DB_URL;
type DbType = ReturnType<typeof drizzle>;

describe("Widerstandsabfrage (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let regionId: string;
  let optA: string;
  let optB: string;
  let counter = 0;
  const nextId = () => `wid-${Date.now()}-${++counter}`;

  async function createWiderstandsPoll(opts?: { status?: "aktiv" | "geschlossen" }) {
    const [poll] = await db.insert(polls).values({
      tenantId, regionId,
      frage: `Konsens ${nextId()}?`,
      typ: "widerstandsabfrage",
      // punkteBudget bleibt dot-only → NULL bei widerstandsabfrage.
      status: opts?.status ?? "geschlossen",
    }).returning();
    const [a] = await db.insert(pollOptions).values({ pollId: poll.id, tenantId, label: "A", position: 0 }).returning();
    const [b] = await db.insert(pollOptions).values({ pollId: poll.id, tenantId, label: "B", position: 1 }).returning();
    optA = a.id; optB = b.id;
    return poll;
  }

  /** Vollständige Abgabe eines Wählers (beide Optionen — die Invariante). */
  async function abgabe(pollId: string, voterRef: string, wertA: number, wertB: number, verif = false) {
    await db.insert(voteResistances).values([
      { pollId, tenantId, optionId: optA, voterRef, wert: wertA, warVerifiziert: verif },
      { pollId, tenantId, optionId: optB, voterRef, wert: wertB, warVerifiziert: verif },
    ]);
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
    const [t] = await db.insert(tenants).values({ slug: `wid-${Date.now()}`, name: "Widerstand-Test" }).returning();
    tenantId = t.id;
    regionId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("Schema: wert=0 WIRD gespeichert (vollständige Abgabe, keine Einwände)", async () => {
    const poll = await createWiderstandsPoll();
    await abgabe(poll.id, "v0", 0, 0);
    const rows = await db.select().from(voteResistances);
    expect(rows.filter((r) => r.pollId === poll.id)).toHaveLength(2);
  });

  it.skipIf(SKIP)("Schema: UNIQUE verhindert zwei Werte desselben Wählers auf dieselbe Option", async () => {
    const poll = await createWiderstandsPoll();
    await db.insert(voteResistances).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: "v1", wert: 3 });
    await expect(
      db.insert(voteResistances).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: "v1", wert: 2 }),
    ).rejects.toThrow();
  });

  it.skipIf(SKIP)("Schema: CHECK verbietet wert < 0 und wert > 10", async () => {
    const poll = await createWiderstandsPoll();
    await expect(
      db.insert(voteResistances).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: "v1", wert: -1 }),
    ).rejects.toThrow();
    await expect(
      db.insert(voteResistances).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: "v1", wert: 11 }),
    ).rejects.toThrow();
  });

  it.skipIf(SKIP)("getWiderstandsErgebnis hält zurück bei laufender Umfrage; Teilnahme sichtbar", async () => {
    const poll = await createWiderstandsPoll({ status: "aktiv" });
    for (let i = 0; i < K_ANONYMITY_SCHWELLE; i++) {
      await abgabe(poll.id, `v${i}`, 2, 8);
    }
    const e = await getWiderstandsErgebnis(db, tenantId, poll.id);
    expect(e!.gesamtWaehler).toBe(K_ANONYMITY_SCHWELLE);
    expect(e!.aufschluesselungZurueckgehalten).toBe(true);
    expect(e!.zurueckhaltungsGrund).toBe("laeuft_noch");
    expect(e!.optionen.every((o) => o.widerstandsSumme === null && o.mittelwert === null)).toBe(true);
  });

  it.skipIf(SKIP)("getWiderstandsErgebnis zeigt Summen/Ø/Gewinner nach Ende ab k Teilnehmenden", async () => {
    const poll = await createWiderstandsPoll({ status: "geschlossen" });
    for (let i = 0; i < K_ANONYMITY_SCHWELLE; i++) {
      await abgabe(poll.id, `w${i}`, 2, 8, i === 0);
    }
    const e = await getWiderstandsErgebnis(db, tenantId, poll.id);
    expect(e!.aufschluesselungZurueckgehalten).toBe(false);
    expect(e!.verifizierteWaehler).toBe(1);
    // Aufsteigend nach Gesamtwiderstand: A (geringster) zuerst.
    expect(e!.optionen.map((o) => o.label)).toEqual(["A", "B"]);
    const a = e!.optionen[0];
    const b = e!.optionen[1];
    expect(a.widerstandsSumme).toBe(2 * K_ANONYMITY_SCHWELLE);
    expect(a.mittelwert).toBe(2);
    expect(a.geringsterWiderstand).toBe(true);
    expect(b.widerstandsSumme).toBe(8 * K_ANONYMITY_SCHWELLE);
    expect(b.geringsterWiderstand).toBe(false);
  });

  it.skipIf(SKIP)("getWiderstandsErgebnis hält zurück bei < k Teilnehmenden trotz Ende", async () => {
    const poll = await createWiderstandsPoll({ status: "geschlossen" });
    for (let i = 0; i < K_ANONYMITY_SCHWELLE - 1; i++) {
      await abgabe(poll.id, `x${i}`, 0, 10);
    }
    const e = await getWiderstandsErgebnis(db, tenantId, poll.id);
    expect(e!.zurueckhaltungsGrund).toBe("zu_wenige_teilnehmende");
    expect(e!.optionen.every((o) => o.widerstandsSumme === null)).toBe(true);
    expect(e!.optionen.every((o) => o.geringsterWiderstand === false)).toBe(true);
  });

  it.skipIf(SKIP)("hatBereitsWiderstandAbgestimmt erkennt einen vorhandenen Widerstandswert", async () => {
    const poll = await createWiderstandsPoll({ status: "aktiv" });
    const salt = "wid-test-salt-aaaaaaaaaaaaaaaaaaaaaa";
    process.env.ANLIEGEN_REF_SALT = salt;
    const userId = "22222222-2222-2222-2222-222222222222";
    const ref = computeVoterRefForUserWithSalt(salt, userId);
    expect(await hatBereitsWiderstandAbgestimmt(db, { id: tenantId } as never, poll.id, { userId })).toBe(false);
    await db.insert(voteResistances).values({ pollId: poll.id, tenantId, optionId: optA, voterRef: ref, wert: 0 });
    expect(await hatBereitsWiderstandAbgestimmt(db, { id: tenantId } as never, poll.id, { userId })).toBe(true);
  });

  it.skipIf(SKIP)("Tenant-Isolation: getWiderstandsErgebnis liefert null für fremden Tenant", async () => {
    const poll = await createWiderstandsPoll({ status: "geschlossen" });
    const [fremd] = await db.insert(tenants).values({ slug: `wid-f-${Date.now()}`, name: "Fremd" }).returning();
    expect(await getWiderstandsErgebnis(db, fremd.id, poll.id)).toBeNull();
  });
});
