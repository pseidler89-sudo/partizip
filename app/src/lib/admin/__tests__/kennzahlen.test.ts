/**
 * kennzahlen.test.ts — Admin-Dashboard-Kennzahlen (P2 §Empf. 5).
 *
 * 1) maskTeilnahme: Re-Identifikationsschutz (privacy-kritisch) — ohne DB.
 * 2) getAdminKennzahlen: ECHTE Aggregat-Query gegen PG16 — zählt aktive Polls,
 *    Stimmen laufender Polls, aktive QR-Codes, offene Anliegen; tenant-scoped.
 *    Läuft NUR mit DATABASE_URL_TEST.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { getAdminKennzahlen, maskTeilnahme, TEILNAHME_SCHWELLE } from "@/lib/admin/kennzahlen";

const { tenants, polls, votes, qrCodes, anliegen } = schema;

describe("maskTeilnahme (Re-Identifikationsschutz)", () => {
  it("0 bleibt exakt (niemand hat teilgenommen)", () => {
    expect(maskTeilnahme(0)).toBe("0");
  });
  it("1..Schwelle-1 werden zu '<Schwelle' maskiert", () => {
    expect(maskTeilnahme(1)).toBe("<5");
    expect(maskTeilnahme(2)).toBe("<5");
    expect(maskTeilnahme(4)).toBe("<5");
  });
  it("ab der Schwelle wird die exakte Zahl gezeigt", () => {
    expect(maskTeilnahme(5)).toBe("5");
    expect(maskTeilnahme(42)).toBe("42");
  });
  it("Schwelle ist konfigurierbar", () => {
    expect(maskTeilnahme(9, 10)).toBe("<10");
    expect(maskTeilnahme(10, 10)).toBe("10");
  });
  it("Default-Schwelle ist 5", () => {
    expect(TEILNAHME_SCHWELLE).toBe(5);
  });
});

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

describe("getAdminKennzahlen (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql_ = postgres(TEST_DB_URL!, { max: 4 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("zählt aktive Polls/Stimmen/QR/Anliegen korrekt und tenant-scoped", async () => {
    const [tA] = await db.insert(tenants).values({ slug: `kz-a-${Date.now()}`, name: "KZ-A" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: `kz-b-${Date.now()}`, name: "KZ-B" }).returning();
    const past = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 3_600_000);
    // ADR-024 contract: Fach-Inserts setzen region_id explizit (Trigger entfernt).
    const regA = await resolveRegionIdForScope(db as never, tA.id, "stadt", null);
    const regB = await resolveRegionIdForScope(db as never, tB.id, "stadt", null);

    // Polls in Tenant A: 2 aktiv-offen, sonst nicht sichtbar (entwurf/zu/künftig).
    const [a1] = await db.insert(polls).values({ tenantId: tA.id, regionId: regA, frage: "a1", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past }).returning();
    const [a2] = await db.insert(polls).values({ tenantId: tA.id, regionId: regA, frage: "a2", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past }).returning();
    await db.insert(polls).values([
      { tenantId: tA.id, regionId: regA, frage: "entwurf", typ: "ja_nein_enthaltung", status: "entwurf" },
      { tenantId: tA.id, regionId: regA, frage: "zu", typ: "ja_nein_enthaltung", status: "aktiv", closesAt: past },
      { tenantId: tA.id, regionId: regA, frage: "künftig", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: future },
    ]);
    // Fremd-Tenant: aktiver Poll (darf NICHT in A zählen).
    const [b1] = await db.insert(polls).values({ tenantId: tB.id, regionId: regB, frage: "b1", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past }).returning();

    // Stimmen: 3 auf a1, 4 auf a2 (= 7 laufend). Eine im Fremd-Tenant (zählt nicht).
    await db.insert(votes).values([
      ...["r1", "r2", "r3"].map((r) => ({ pollId: a1.id, tenantId: tA.id, voterRef: r, choice: "ja" as const, warVerifiziert: false })),
      ...["s1", "s2", "s3", "s4"].map((r) => ({ pollId: a2.id, tenantId: tA.id, voterRef: r, choice: "nein" as const, warVerifiziert: false })),
      { pollId: b1.id, tenantId: tB.id, voterRef: "x1", choice: "ja" as const, warVerifiziert: false },
    ]);

    // QR-Codes in A: 1 aktiv + 3 inaktiv (abgelaufen / widerrufen / aufgebraucht).
    await db.insert(qrCodes).values([
      { tenantId: tA.id, regionId: regA, tokenHash: `h-aktiv-${Date.now()}`, maxRedemptions: 10, expiresAt: future },
      { tenantId: tA.id, regionId: regA, tokenHash: `h-abgelaufen-${Date.now()}`, maxRedemptions: 10, expiresAt: past },
      { tenantId: tA.id, regionId: regA, tokenHash: `h-widerrufen-${Date.now()}`, maxRedemptions: 10, expiresAt: future, revokedAt: past },
      { tenantId: tA.id, regionId: regA, tokenHash: `h-aufgebraucht-${Date.now()}`, maxRedemptions: 3, redemptionCount: 3, expiresAt: future },
    ]);
    // Fremd-Tenant: aktiver QR (zählt nicht in A).
    await db.insert(qrCodes).values({ tenantId: tB.id, regionId: regB, tokenHash: `h-fremd-${Date.now()}`, maxRedemptions: 10, expiresAt: future });

    // Anliegen in A: 2 offen (eingegangen default + in_pruefung), 1 abgeschlossen (beantwortet).
    await db.insert(anliegen).values([
      { tenantId: tA.id, trackingCode: `TC-1-${Date.now()}`, creatorRef: "c1", titel: "offen 1" },
      { tenantId: tA.id, trackingCode: `TC-2-${Date.now()}`, creatorRef: "c2", titel: "offen 2", status: "in_pruefung" },
      { tenantId: tA.id, trackingCode: `TC-3-${Date.now()}`, creatorRef: "c3", titel: "zu", status: "beantwortet" },
    ]);

    const k = await getAdminKennzahlen(db as never, tA.id);
    expect(k.aktiveAbstimmungen).toBe(2);
    expect(k.stimmenLaufend).toBe(7);
    expect(k.aktiveQrCodes).toBe(1);
    expect(k.offeneAnliegen).toBe(2);

    // Tenant-Isolation gegenprobe: Tenant B sieht nur seine eigenen Zahlen.
    const kB = await getAdminKennzahlen(db as never, tB.id);
    expect(kB.aktiveAbstimmungen).toBe(1);
    expect(kB.stimmenLaufend).toBe(1);
    expect(kB.aktiveQrCodes).toBe(1);
    expect(kB.offeneAnliegen).toBe(0);
  });
});
