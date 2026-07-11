/**
 * resolution.test.ts — DB-Integrationstests der ECHTEN Region-Auflösung (ADR-015):
 * resolveRegionByPlz / resolveRegionByCoords / getOrtsteileForTenant /
 * ortsteilCodeGehoertZuTenant.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, set: () => {} }),
  headers: () => ({ get: () => null }),
}));

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import {
  resolveRegionByPlz,
  resolveRegionByCoords,
  getOrtsteileForTenant,
  ortsteilCodeGehoertZuTenant,
} from "@/lib/region/queries";

const { tenants, ortsteile, plzRegionen } = schema;

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

describe("region/queries (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let andererTenantId: string;

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

    const [t] = await db
      .insert(tenants)
      .values({ slug: `region-${Date.now()}`, name: "Region-Test" })
      .returning();
    tenantId = t.id;
    const [t2] = await db
      .insert(tenants)
      .values({ slug: `region2-${Date.now()}`, name: "Region2" })
      .returning();
    andererTenantId = t2.id;

    await db.insert(ortsteile).values([
      { tenantId, code: "wehen", name: "Wehen" },
      { tenantId, code: "hahn", name: "Hahn" },
      { tenantId, code: "bleidenstadt", name: "Bleidenstadt" },
    ]);

    await db.insert(plzRegionen).values([
      // Stadt-Ebene (kein Ortsteil) + Zentrum.
      { tenantId, plz: "65232", ortsteilCode: null, lat: "50.1466", lon: "8.1505" },
      // Eine PLZ mit zusätzlicher feiner Ortsteil-Zeile (Stadt-Zeile wird bevorzugt).
      { tenantId, plz: "65232", ortsteilCode: "hahn", lat: "50.16", lon: "8.16" },
    ]);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("resolveRegionByPlz findet die Region und bevorzugt die Stadt-Ebene (ortsteilCode null)", async () => {
    const r = await resolveRegionByPlz(db as never, "65232");
    expect(r).not.toBeNull();
    expect(r!.tenantId).toBe(tenantId);
    expect(r!.ortsteilCode).toBeNull();
  });

  it.skipIf(SKIP)("resolveRegionByPlz normalisiert die Eingabe (Leerzeichen)", async () => {
    const r = await resolveRegionByPlz(db as never, " 65 232 ");
    expect(r?.tenantId).toBe(tenantId);
  });

  it.skipIf(SKIP)("resolveRegionByPlz → null für unbekannte PLZ", async () => {
    expect(await resolveRegionByPlz(db as never, "00000")).toBeNull();
    expect(await resolveRegionByPlz(db as never, "")).toBeNull();
  });

  it.skipIf(SKIP)("resolveRegionByCoords ordnet einen nahen Standort zu", async () => {
    const r = await resolveRegionByCoords(db as never, 50.147, 8.151);
    expect(r).not.toBeNull();
    expect(r!.tenantId).toBe(tenantId);
    expect(r!.distanceKm).toBeLessThan(5);
  });

  it.skipIf(SKIP)("resolveRegionByCoords → null wenn nichts in Reichweite (Berlin)", async () => {
    const r = await resolveRegionByCoords(db as never, 52.52, 13.405);
    expect(r).toBeNull();
  });

  it.skipIf(SKIP)("resolveRegionByCoords → null bei ungültigen Koordinaten", async () => {
    expect(await resolveRegionByCoords(db as never, NaN, 8)).toBeNull();
  });

  it.skipIf(SKIP)("getOrtsteileForTenant liefert die Ortsteile alphabetisch nach Name", async () => {
    const os = await getOrtsteileForTenant(db as never, tenantId);
    expect(os.map((o) => o.name)).toEqual(["Bleidenstadt", "Hahn", "Wehen"]);
  });

  it.skipIf(SKIP)("ortsteilCodeGehoertZuTenant respektiert Tenant-Isolation", async () => {
    expect(await ortsteilCodeGehoertZuTenant(db as never, tenantId, "wehen")).toBe(true);
    expect(await ortsteilCodeGehoertZuTenant(db as never, tenantId, "gibtsnicht")).toBe(false);
    // Ortsteil des einen Tenants gehört NICHT zum anderen.
    expect(await ortsteilCodeGehoertZuTenant(db as never, andererTenantId, "wehen")).toBe(false);
  });
});
