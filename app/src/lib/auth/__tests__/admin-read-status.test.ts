/**
 * admin-read-status.test.ts — MINOR 1: Admin-LESE-Sichten sind account-status-
 * gefiltert.
 *
 * Die Admin-Lese-Seiten (admin, admin/abstimmungen, admin/digests,
 * admin/digests/[id], admin/rollen) laden ihre Rollen NICHT mehr direkt aus
 * `roles`, sondern über getUserRolesMitScope / getUserRoleTypes (innerer JOIN auf
 * users.account_status = 'active'). Ein gesperrtes/gelöschtes Konto verliert damit
 * bei noch gültiger Session SOFORT den Lese-Zugang — genau wie es die
 * Mutations-Achsen (getUserRoleTypes) schon taten.
 *
 * Getestet werden die ECHTEN Guard-Bausteine der Seiten (kein Spiegel-Code):
 *   - getUserRolesMitScope / getUserRoleTypes (account-status-Filter)
 *   - die reinen Prädikate isAdmin / canRedaktion / canBeobachten / beobachterDarfSehen,
 *     mit denen die Seiten den Zugriff entscheiden.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst skip).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import type { Db } from "@/db/client";
import {
  getUserRoleTypes,
  getUserRolesMitScope,
  isAdmin,
  canRedaktion,
  canBeobachten,
  beobachterDarfTenantweitSehen,
} from "../roles";

const { tenants, users, roles } = schema;

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

/** Bildet die Zugriffs-Entscheidung der Admin-Lese-Seiten nach (aus den echten Prädikaten). */
function darfAdminLeseSicht(
  roleTypes: string[],
  roleRows: { roleType: string; regionTyp: string; regionPath: string }[],
): { dashboard: boolean; digests: boolean; rollen: boolean; protokoll: boolean; anliegen: boolean } {
  const admin = isAdmin(roleTypes);
  return {
    // admin/page.tsx + admin/abstimmungen: Admin ODER (stadtweiter) Beobachter.
    dashboard: admin || beobachterDarfTenantweitSehen(roleRows),
    // admin/digests + admin/digests/[id]: Redaktion ODER (stadtweiter) Beobachter.
    digests: canRedaktion(roleTypes) || beobachterDarfTenantweitSehen(roleRows),
    // admin/rollen: strikt Admin.
    rollen: admin,
    // admin/protokoll (Audit-Log): strikt Admin.
    protokoll: admin,
    // admin/anliegen + admin/anliegen/[id] (ggf. PII): strikt Admin.
    anliegen: admin,
  };
}

describe("Admin-Lese-Sichten — account-status-gefiltert (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let adminId: string;
  let redakteurId: string;

  beforeAll(async () => {
    if (SKIP) return;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_, { schema }) as unknown as Db;
    await migrate(db, { migrationsFolder });

    const [tenant] = await db
      .insert(tenants)
      .values({ slug: `ars-${Date.now()}`, name: "Admin-Read-Status-Tenant" })
      .returning();
    tenantId = tenant.id;

    const [admin] = await db
      .insert(users)
      .values({ tenantId, email: `admin-${Date.now()}@ars-test.de` })
      .returning();
    adminId = admin.id;
    const [red] = await db
      .insert(users)
      .values({ tenantId, email: `red-${Date.now()}@ars-test.de` })
      .returning();
    redakteurId = red.id;

    const stadtRegion = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    await db.insert(roles).values([
      { tenantId, userId: adminId, roleType: "kommune_admin", regionId: stadtRegion },
      { tenantId, userId: redakteurId, roleType: "redakteur", regionId: stadtRegion },
    ]);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  it.skipIf(SKIP)("aktiver kommune_admin: voller Lese-Zugang (unverändert)", async () => {
    const roleTypes = await getUserRoleTypes(db, tenantId, adminId);
    const roleRows = await getUserRolesMitScope(db, tenantId, adminId);
    expect(roleTypes).toContain("kommune_admin");
    const zugang = darfAdminLeseSicht(roleTypes, roleRows);
    expect(zugang).toEqual({
      dashboard: true,
      digests: true,
      rollen: true,
      protokoll: true,
      anliegen: true,
    });
  });

  it.skipIf(SKIP)("aktiver redakteur: Digest-Lese-Zugang, aber keine Admin-Sichten (unverändert)", async () => {
    const roleTypes = await getUserRoleTypes(db, tenantId, redakteurId);
    const roleRows = await getUserRolesMitScope(db, tenantId, redakteurId);
    const zugang = darfAdminLeseSicht(roleTypes, roleRows);
    expect(zugang.digests).toBe(true);
    expect(zugang.rollen).toBe(false);
    // Protokoll + Anliegen sind strikt Admin — redakteur hat KEINEN Zugang.
    expect(zugang.protokoll).toBe(false);
    expect(zugang.anliegen).toBe(false);
  });

  it.skipIf(SKIP)("gesperrter kommune_admin: KEIN Lese-Zugang auf Admin-Sichten (fail-closed)", async () => {
    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, adminId));
    try {
      const roleTypes = await getUserRoleTypes(db, tenantId, adminId);
      const roleRows = await getUserRolesMitScope(db, tenantId, adminId);
      // Der account-status-Filter liefert []; alle Prädikate der Seiten kippen auf false.
      expect(roleTypes).toEqual([]);
      expect(roleRows).toEqual([]);
      expect(isAdmin(roleTypes)).toBe(false);
      expect(canRedaktion(roleTypes)).toBe(false);
      expect(canBeobachten(roleTypes)).toBe(false);
      const zugang = darfAdminLeseSicht(roleTypes, roleRows);
      expect(zugang).toEqual({
        dashboard: false,
        digests: false,
        rollen: false,
        protokoll: false,
        anliegen: false,
      });
    } finally {
      await db.update(users).set({ accountStatus: "active" }).where(eq(users.id, adminId));
    }
  });

  it.skipIf(SKIP)("gelöschtes Konto: ebenfalls kein Lese-Zugang", async () => {
    await db.update(users).set({ accountStatus: "deleted" }).where(eq(users.id, redakteurId));
    try {
      const roleTypes = await getUserRoleTypes(db, tenantId, redakteurId);
      const roleRows = await getUserRolesMitScope(db, tenantId, redakteurId);
      expect(roleTypes).toEqual([]);
      const zugang = darfAdminLeseSicht(roleTypes, roleRows);
      expect(zugang).toEqual({
        dashboard: false,
        digests: false,
        rollen: false,
        protokoll: false,
        anliegen: false,
      });
    } finally {
      await db.update(users).set({ accountStatus: "active" }).where(eq(users.id, redakteurId));
    }
  });

  it.skipIf(SKIP)("nach Entsperren: Lese-Zugang kehrt sofort zurück (keine Regression)", async () => {
    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, adminId));
    await db.update(users).set({ accountStatus: "active" }).where(eq(users.id, adminId));
    const roleTypes = await getUserRoleTypes(db, tenantId, adminId);
    const roleRows = await getUserRolesMitScope(db, tenantId, adminId);
    expect(darfAdminLeseSicht(roleTypes, roleRows)).toEqual({
      dashboard: true,
      digests: true,
      rollen: true,
      protokoll: true,
      anliegen: true,
    });
  });
});
