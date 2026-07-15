/**
 * role-actions.test.ts — Integrationstest Rollen-Verwaltung (Achse B, Gate B).
 *
 * Getestete Szenarien (gegen echte Postgres-Test-DB):
 *   1. assignRole schreibt Rolle + Audit (role.granted), PII-frei (kein '@').
 *   2. assignRole idempotent: zweite identische Vergabe → ok, kein Crash, kein
 *      doppeltes Audit.
 *   3. ESKALATION: kommune_admin kann super_admin NICHT vergeben.
 *   4. ESKALATION: kommune_admin kann Reserve-Rolle NICHT vergeben.
 *   5. ESKALATION: kommune_admin kann super_admin-Rolle NICHT entziehen.
 *   6. Tenant-Isolation: Ziel-E-Mail aus fremdem Tenant → nicht gefunden.
 *   7. revokeRole schreibt Audit (role.revoked), PII-frei.
 *   8. LETZTER-ADMIN-SCHUTZ: Entzug der letzten Admin-Rolle wird abgelehnt.
 *   9. Letzter Admin: Entzug erlaubt, sobald ein zweiter Admin existiert.
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
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import {
  assignRoleCore,
  revokeRoleCore,
} from "@/lib/admin/role-actions.js";
import { getUserRoleTypes } from "@/lib/auth/roles.js";
import type { Db } from "@/db/client";

const { tenants, users, roles, auditEvents } = schema;

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

const KOMMUNE = ["kommune_admin"];
const SUPER = ["super_admin"];

describe("Rollen-Verwaltung (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let tenant2Id: string;
  let callerAdminId: string; // kommune_admin im Tenant 1 (Audit-Akteur)

  let counter = 0;
  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@rollen-test.de`;
  }

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
      .values({ slug: `rollen-${Date.now()}`, name: "Rollen-Test-Tenant" })
      .returning();
    tenantId = tenant.id;

    const [tenant2] = await db
      .insert(tenants)
      .values({ slug: `rollen-t2-${Date.now()}`, name: "Rollen-Test-Tenant-2" })
      .returning();
    tenant2Id = tenant2.id;

    const [caller] = await db
      .insert(users)
      .values({ tenantId, email: nextEmail("caller") })
      .returning();
    callerAdminId = caller.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  /** Legt einen User im Tenant 1 an und gibt {id, email} zurück. */
  async function createUser(prefix: string, tId: string = tenantId) {
    const email = nextEmail(prefix);
    const [u] = await db.insert(users).values({ tenantId: tId, email }).returning();
    return { id: u.id, email };
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SICHERHEIT (SIA Loop 2): gesperrte/gelöschte Konten verlieren Rollen sofort
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("getUserRoleTypes liefert für gesperrte/gelöschte Konten KEINE Rollen (Eskalationsgrenze)", async () => {
    const u = await createUser("locked-admin");
    await assignRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      targetEmail: u.email,
      roleType: "kommune_admin",
    });
    // aktiv → Rolle sichtbar
    expect(await getUserRoleTypes(db, tenantId, u.id)).toContain("kommune_admin");

    // gesperrt → KEINE Rollen (Admin-Rechte sofort entzogen, auch bei gültiger Session)
    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, u.id));
    expect(await getUserRoleTypes(db, tenantId, u.id)).toEqual([]);

    // gelöscht → ebenfalls keine Rollen
    await db.update(users).set({ accountStatus: "deleted" }).where(eq(users.id, u.id));
    expect(await getUserRoleTypes(db, tenantId, u.id)).toEqual([]);

    // wieder aktiv → Rolle zurück
    await db.update(users).set({ accountStatus: "active" }).where(eq(users.id, u.id));
    expect(await getUserRoleTypes(db, tenantId, u.id)).toContain("kommune_admin");
  });

  // -------------------------------------------------------------------------
  // 1. assignRole schreibt Rolle + Audit, PII-frei
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("1. assignRole schreibt Rolle + role.granted-Audit (PII-frei)", async () => {
    const target = await createUser("ziel1");

    const res = await assignRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      targetEmail: target.email,
      roleType: "redakteur",
    });
    expect(res.ok).toBe(true);

    const rts = await getUserRoleTypes(db, tenantId, target.id);
    expect(rts).toContain("redakteur");

    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "role.granted"),
          eq(auditEvents.targetId, target.id),
        ),
      );
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(callerAdminId);
    expect(audit[0].actorType).toBe("admin");
    // PII-Freiheit: weder targetId noch metadata enthalten eine E-Mail.
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
    expect(audit[0].targetId).not.toContain("@");
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.roleType).toBe("redakteur");
  });

  // -------------------------------------------------------------------------
  // 2. Idempotenz
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("2. assignRole ist idempotent (zweite Vergabe ok, kein Doppel-Audit)", async () => {
    const target = await createUser("ziel2");

    const r1 = await assignRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      targetEmail: target.email,
      roleType: "verifier",
    });
    expect(r1.ok).toBe(true);

    const r2 = await assignRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      targetEmail: target.email,
      roleType: "verifier",
    });
    expect(r2.ok).toBe(true);
    expect(r2.message).toMatch(/bereits/i);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "role.granted"),
          eq(auditEvents.targetId, target.id),
        ),
      );
    expect(audit.length).toBe(1); // nur die erste echte Vergabe ist auditiert
  });

  // -------------------------------------------------------------------------
  // 3./4. Eskalation bei Vergabe
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("3. kommune_admin kann super_admin NICHT vergeben", async () => {
    const target = await createUser("ziel3");

    const res = await assignRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      targetEmail: target.email,
      roleType: "super_admin",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Keine Berechtigung/i);

    const rts = await getUserRoleTypes(db, tenantId, target.id);
    expect(rts).not.toContain("super_admin");
  });

  it.skipIf(SKIP)("4. kommune_admin kann Reserve-Rolle NICHT vergeben", async () => {
    const target = await createUser("ziel4");

    const res = await assignRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      targetEmail: target.email,
      roleType: "kreis_admin",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Keine Berechtigung/i);
  });

  it.skipIf(SKIP)("4b. super_admin DARF super_admin vergeben", async () => {
    const target = await createUser("ziel4b");

    const res = await assignRoleCore(db, tenantId, SUPER, callerAdminId, {
      targetEmail: target.email,
      roleType: "super_admin",
    });
    expect(res.ok).toBe(true);
    const rts = await getUserRoleTypes(db, tenantId, target.id);
    expect(rts).toContain("super_admin");
  });

  // -------------------------------------------------------------------------
  // 5. Eskalation bei Entzug
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("5. kommune_admin kann super_admin-Rolle NICHT entziehen", async () => {
    // super_admin-Rolle anlegen (über super_admin-Caller).
    const target = await createUser("ziel5");
    await assignRoleCore(db, tenantId, SUPER, callerAdminId, {
      targetEmail: target.email,
      roleType: "super_admin",
    });
    const [roleRow] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.tenantId, tenantId),
          eq(roles.userId, target.id),
          eq(roles.roleType, "super_admin"),
        ),
      );

    const res = await revokeRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      roleId: roleRow.id,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Keine Berechtigung/i);

    // Rolle existiert noch.
    const stillThere = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleRow.id));
    expect(stillThere.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. Tenant-Isolation
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("6. Ziel-E-Mail aus fremdem Tenant → nicht gefunden", async () => {
    const fremder = await createUser("fremd", tenant2Id);

    const res = await assignRoleCore(db, tenantId, SUPER, callerAdminId, {
      targetEmail: fremder.email,
      roleType: "redakteur",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/kein Konto/i);
  });

  // -------------------------------------------------------------------------
  // 7. revokeRole schreibt Audit, PII-frei
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("7. revokeRole schreibt role.revoked-Audit (PII-frei)", async () => {
    const target = await createUser("ziel7");
    await assignRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      targetEmail: target.email,
      roleType: "redakteur",
    });
    const [roleRow] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, target.id), eq(roles.roleType, "redakteur")));

    const res = await revokeRoleCore(db, tenantId, KOMMUNE, callerAdminId, {
      roleId: roleRow.id,
    });
    expect(res.ok).toBe(true);

    const gone = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleRow.id));
    expect(gone.length).toBe(0);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.revoked"), eq(auditEvents.targetId, target.id)));
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
    expect((audit[0].metadata as Record<string, unknown>).roleType).toBe("redakteur");
  });

  // -------------------------------------------------------------------------
  // 8./9. Letzter-Admin-Schutz
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("8. Entzug der letzten Admin-Rolle wird abgelehnt", async () => {
    // Eigener, frischer Tenant mit genau EINEM Admin.
    const [t] = await db
      .insert(tenants)
      .values({ slug: `rollen-letzt-${Date.now()}-${++counter}`, name: "Letzt-Admin" })
      .returning();
    const [onlyAdmin] = await db
      .insert(users)
      .values({ tenantId: t.id, email: nextEmail("only-admin") })
      .returning();
    const [adminRole] = await db
      .insert(roles)
      .values({ tenantId: t.id, userId: onlyAdmin.id, roleType: "kommune_admin", regionId: await resolveRegionIdForScope(db, t.id, "stadt", null) })
      .returning();

    const res = await revokeRoleCore(db, t.id, SUPER, callerAdminId, {
      roleId: adminRole.id,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/letzte Administrator/i);

    // Rolle bleibt erhalten.
    const stillThere = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, adminRole.id));
    expect(stillThere.length).toBe(1);
  });

  it.skipIf(SKIP)("9. Entzug erlaubt, sobald ein zweiter Admin existiert", async () => {
    const [t] = await db
      .insert(tenants)
      .values({ slug: `rollen-zwei-${Date.now()}-${++counter}`, name: "Zwei-Admins" })
      .returning();
    const [adminA] = await db
      .insert(users)
      .values({ tenantId: t.id, email: nextEmail("admin-a") })
      .returning();
    const [adminB] = await db
      .insert(users)
      .values({ tenantId: t.id, email: nextEmail("admin-b") })
      .returning();
    const zweiAdminRegion = await resolveRegionIdForScope(db, t.id, "stadt", null);
    const [roleA] = await db
      .insert(roles)
      .values({ tenantId: t.id, userId: adminA.id, roleType: "kommune_admin", regionId: zweiAdminRegion })
      .returning();
    await db
      .insert(roles)
      .values({ tenantId: t.id, userId: adminB.id, roleType: "kommune_admin", regionId: zweiAdminRegion });

    const res = await revokeRoleCore(db, t.id, SUPER, callerAdminId, { roleId: roleA.id });
    expect(res.ok).toBe(true);

    const gone = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleA.id));
    expect(gone.length).toBe(0);
  });
});
