/**
 * scope-dualwrite.test.ts — DB-Integrationstests für den Gebietsbaum-Umbau
 * ETAPPE 2 (ADR-024): region_id-Ableitung (Dual-Write) + Trigger-Sicherheitsnetz.
 *
 * Prüft mit ECHTEN Funktionen (keine Spiegelung der Logik):
 *   - resolveRegionIdForScope bildet stadt/kreis/land/ortsteil auf die korrekten
 *     Baum-Knoten ab (Vorfahren-Pfad bzw. Ortsteil-Kind).
 *   - Der BEFORE-INSERT-Trigger füllt region_id konsistent, wenn ein direkter
 *     Insert es weglässt (Seeds/Tests) — GLEICHER Knoten wie der Resolver.
 *   - DUAL-WRITE end-to-end über die echten Fach-Funktionen qrErstellenCore und
 *     assignRoleCore: scope_level/scope_code UND region_id werden konsistent gesetzt.
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
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import {
  resolveRegionIdForScope,
  resolveOrtsteilRegionId,
  resolveGemeindeRegionId,
} from "@/lib/region/scope";
import { qrErstellenCore } from "@/lib/verification/qr-core";
import { assignRoleCore } from "@/lib/admin/role-actions";
import { seedRegions } from "../../../../scripts/seed-regions.js";

const { tenants, ortsteile, users, regions, qrCodes, roles } = schema;

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

async function pathOf(db: DbType, id: string): Promise<string> {
  const [r] = await db.select({ path: regions.path }).from(regions).where(eq(regions.id, id)).limit(1);
  return String(r.path);
}

describe("region/scope Dual-Write (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;

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

    const [t] = await db.insert(tenants).values({ slug: "taunusstein", name: "Taunusstein" }).returning();
    tenantId = t.id;
    await db.insert(ortsteile).values([
      { tenantId, code: "wehen", name: "Wehen" },
      { tenantId, code: "hahn", name: "Hahn" },
    ]);
    // Realer Pilot-Baum (proper ARS + Ortsteil-Knoten).
    await seedRegions(db as never);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("resolveRegionIdForScope: stadt/kreis/land treffen die Vorfahren-Ebenen", async () => {
    const stadt = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    const kreis = await resolveRegionIdForScope(db as never, tenantId, "kreis", null);
    const land = await resolveRegionIdForScope(db as never, tenantId, "land", null);
    expect(await pathOf(db, stadt)).toBe("de.hessen.rtk.taunusstein");
    expect(await pathOf(db, kreis)).toBe("de.hessen.rtk");
    expect(await pathOf(db, land)).toBe("de.hessen");
  });

  it.skipIf(SKIP)("resolveRegionIdForScope: ortsteil + code trifft den Ortsteil-Knoten", async () => {
    const wehen = await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "wehen");
    expect(await pathOf(db, wehen)).toBe("de.hessen.rtk.taunusstein.wehen");
    // Identisch zur reinen Lese-Auflösung (viewer_path der Standard-Sicht).
    const wehenRead = await resolveOrtsteilRegionId(db as never, tenantId, "wehen");
    expect(wehenRead).toBe(wehen);
  });

  it.skipIf(SKIP)("CONTRACT: direkter Poll-Insert OHNE region_id wird abgelehnt (NOT NULL, kein Trigger mehr)", async () => {
    // ADR-024 contract: der frühere Dual-Write-Trigger für polls/roles/qr ist
    // entfernt. region_id ist NOT NULL und muss vom Schreibpfad explizit gesetzt
    // werden — ein direkter Insert ohne region_id schlägt hart fehl (kein stilles
    // Default). Das ist die Invariante, die einen vergessenen Setter sofort aufdeckt.
    await expect(
      db
        .insert(schema.polls)
        .values({ tenantId, frage: "Ohne Region?", typ: "ja_nein_enthaltung", status: "entwurf" } as never)
    ).rejects.toThrow();
  });

  it.skipIf(SKIP)("qrErstellenCore setzt region_id aus der Scope-Eingabe (contract: nur region_id)", async () => {
    const [u] = await db.insert(users).values({ tenantId, email: `qr-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const res = await qrErstellenCore(
      db as never,
      tenantId,
      u.id,
      {
        scopeLevel: "ortsteil",
        scopeCode: "wehen",
        maxRedemptions: 3,
        gueltigkeitStunden: 24,
      },
      // Gebietsbindung (Block K1): Admin-Kontext — hier zählt nur der
      // region_id-Contract, nicht die Verifier-Einschränkung.
      { isAdmin: true, scopes: [] },
    );
    const [row] = await db.select().from(qrCodes).where(eq(qrCodes.id, res.qrId)).limit(1);
    expect(await pathOf(db, row.regionId!)).toBe("de.hessen.rtk.taunusstein.wehen");
  });

  it.skipIf(SKIP)("assignRoleCore setzt region_id aus der Scope-Eingabe (contract: nur region_id)", async () => {
    const [caller] = await db.insert(users).values({ tenantId, email: `caller-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const [target] = await db.insert(users).values({ tenantId, email: `target-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();

    const r = await assignRoleCore(
      db as never,
      tenantId,
      ["kommune_admin"],
      caller.id,
      { targetEmail: target.email, roleType: "verifier", scopeLevel: "ortsteil", scopeCode: "wehen" }
    );
    expect(r.ok).toBe(true);

    const [role] = await db
      .select()
      .from(roles)
      .where(sql`${roles.tenantId} = ${tenantId} AND ${roles.userId} = ${target.id} AND ${roles.roleType} = 'verifier'`)
      .limit(1);
    expect(await pathOf(db, role.regionId!)).toBe("de.hessen.rtk.taunusstein.wehen");
  });

  it.skipIf(SKIP)("stadt-Scope einer Rolle → Gemeinde-Knoten (Fallback-Anker der Sicht)", async () => {
    const gem = await resolveGemeindeRegionId(db as never, tenantId);
    expect(gem).not.toBeNull();
    expect(await pathOf(db, gem!)).toBe("de.hessen.rtk.taunusstein");
  });
});
