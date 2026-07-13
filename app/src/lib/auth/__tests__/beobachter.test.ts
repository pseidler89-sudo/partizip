/**
 * beobachter.test.ts — Integrationstest der View-Only-Rolle (Rollen-Governance).
 *
 * Gegen echte Postgres-Test-DB, mit ECHTEN Funktionen (kein Spiegel-Code):
 *   1. Migration: der Enum-Wert 'beobachter' ist vergeb- und ladbar.
 *   2. Mutations-Guards: JEDER Guard lehnt die aus der DB geladenen Rollen
 *      eines Beobachters ab (tabellarisch).
 *   3. Rollen-Verwaltung: kommune_admin/super_admin können beobachter
 *      vergeben/entziehen (auditiert, PII-frei); ein beobachter kann
 *      selbst KEINE Rollen vergeben/entziehen.
 *   4. Sichtbarkeit: Beobachter sieht Abstimmungen NUR im eigenen Scope
 *      (echte Admin-Lese-Query + beobachterDarfSehen-Filter, wie die Seite).
 *   5. Tenant-Isolation: keine Rollen/Sicht im fremden Tenant.
 *   6. Gesperrtes Konto verliert die Beobachter-Sicht (fail-closed).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst skip).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import type { Db } from "@/db/client";
import {
  getUserRoleTypes,
  getUserRolesMitScope,
  canRedaktion,
  canFreigeben,
  isAdmin,
  canVerify,
  canBeobachten,
  canManageRole,
  beobachterDarfSehen,
  ALL_ROLE_TYPES,
} from "../roles";
import { assignRoleCore, revokeRoleCore } from "@/lib/admin/role-actions.js";
import { getAllPollsForAdmin } from "@/lib/polls/queries";

const { tenants, users, roles, polls, auditEvents } = schema;

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

describe("beobachter — View-Only-Rolle (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let tenant2Id: string;
  let kommuneAdminId: string;
  let beobachterStadtId: string;
  let beobachterStadtEmail: string;
  let beobachterNordId: string;

  let counter = 0;
  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@beobachter-test.de`;
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
      .values({ slug: `beob-${Date.now()}`, name: "Beobachter-Test-Tenant" })
      .returning();
    tenantId = tenant.id;

    const [tenant2] = await db
      .insert(tenants)
      .values({ slug: `beob-t2-${Date.now()}`, name: "Beobachter-Test-Tenant-2" })
      .returning();
    tenant2Id = tenant2.id;

    const [admin] = await db
      .insert(users)
      .values({ tenantId, email: nextEmail("admin") })
      .returning();
    kommuneAdminId = admin.id;
    await db.insert(roles).values({
      tenantId,
      userId: kommuneAdminId,
      roleType: "kommune_admin",
      scopeLevel: "stadt",
    });

    beobachterStadtEmail = nextEmail("beob-stadt");
    const [beobStadt] = await db
      .insert(users)
      .values({ tenantId, email: beobachterStadtEmail })
      .returning();
    beobachterStadtId = beobStadt.id;

    const [beobNord] = await db
      .insert(users)
      .values({ tenantId, email: nextEmail("beob-nord") })
      .returning();
    beobachterNordId = beobNord.id;
    await db.insert(roles).values({
      tenantId,
      userId: beobachterNordId,
      roleType: "beobachter",
      scopeLevel: "ortsteil",
      scopeCode: "nord",
    });

    // Abstimmungen: stadtweit + ortsteil nord + ortsteil sued (Tenant 1),
    // stadtweit (Tenant 2 — Isolation).
    await db.insert(polls).values([
      { tenantId, scopeLevel: "stadt", scopeCode: null, frage: "Stadtweite Frage?", status: "aktiv" },
      { tenantId, scopeLevel: "ortsteil", scopeCode: "nord", frage: "Nord-Frage?", status: "aktiv" },
      { tenantId, scopeLevel: "ortsteil", scopeCode: "sued", frage: "Sued-Frage?", status: "entwurf" },
      { tenantId: tenant2Id, scopeLevel: "stadt", scopeCode: null, frage: "Fremder Tenant?", status: "aktiv" },
    ]);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 1. Migration + Vergabe über die ECHTE Rollen-Verwaltung
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("1. kommune_admin vergibt beobachter (Enum-Wert nutzbar) — auditiert, PII-frei", async () => {
    const result = await assignRoleCore(db, tenantId, ["kommune_admin"], kommuneAdminId, {
      targetEmail: beobachterStadtEmail,
      roleType: "beobachter",
      scopeLevel: "stadt",
    });
    expect(result.ok).toBe(true);

    const roleTypes = await getUserRoleTypes(db, tenantId, beobachterStadtId);
    expect(roleTypes).toContain("beobachter");

    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "role.granted"), eq(auditEvents.targetId, beobachterStadtId)),
      );
    expect(audits.length).toBe(1);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.roleType).toBe("beobachter");
    expect(JSON.stringify(meta)).not.toContain("@");
    expect(audits[0].actorRef).toBe(kommuneAdminId);
  });

  // -------------------------------------------------------------------------
  // 2. Mutations-Guards — tabellarisch, mit ECHT aus der DB geladenen Rollen
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("2. JEDER Mutations-Guard lehnt den Beobachter ab; canBeobachten = true", async () => {
    const roleTypes = await getUserRoleTypes(db, tenantId, beobachterStadtId);
    expect(roleTypes).toEqual(["beobachter"]);

    const MUTATION_GUARDS: Array<[string, (rt: string[]) => boolean]> = [
      ["canRedaktion", canRedaktion],
      ["canFreigeben", canFreigeben],
      ["isAdmin", isAdmin],
      ["canVerify", canVerify],
    ];
    for (const [name, guard] of MUTATION_GUARDS) {
      expect(guard(roleTypes), `${name} muss beobachter ablehnen`).toBe(false);
    }
    expect(canBeobachten(roleTypes)).toBe(true);

    // Rollen-Verwaltung: für JEDEN Rollentyp verboten.
    for (const r of ALL_ROLE_TYPES) {
      expect(canManageRole(roleTypes, r)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Beobachter kann über die ECHTEN Actions keine Rollen vergeben/entziehen
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("3. assignRoleCore/revokeRoleCore mit Beobachter-Rollen → abgelehnt, nichts geschrieben", async () => {
    const beobachterRollen = await getUserRoleTypes(db, tenantId, beobachterStadtId);

    const assign = await assignRoleCore(db, tenantId, beobachterRollen, beobachterStadtId, {
      targetEmail: beobachterStadtEmail,
      roleType: "user",
      scopeLevel: "stadt",
    });
    expect(assign.ok).toBe(false);
    expect(assign.error).toMatch(/Admin erforderlich/);

    // Eine existierende Rolle als Entzugs-Ziel suchen (die eigene beobachter-Rolle).
    const [eigeneRolle] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, beobachterStadtId)))
      .limit(1);

    const revoke = await revokeRoleCore(db, tenantId, beobachterRollen, beobachterStadtId, {
      roleId: eigeneRolle.id,
    });
    expect(revoke.ok).toBe(false);
    expect(revoke.error).toMatch(/Admin erforderlich/);

    // Rolle existiert weiterhin.
    const nachher = await getUserRoleTypes(db, tenantId, beobachterStadtId);
    expect(nachher).toContain("beobachter");
  });

  // -------------------------------------------------------------------------
  // 4. Sichtbarkeit im eigenen Scope (echte Lese-Query + Seiten-Filter)
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("4. stadt-Beobachter sieht alle Abstimmungen des Tenants (inkl. Entwürfe)", async () => {
    const rollen = await getUserRolesMitScope(db, tenantId, beobachterStadtId);
    const alle = await getAllPollsForAdmin(db, tenantId);
    const sichtbar = alle.filter((p) => beobachterDarfSehen(rollen, p.scopeLevel, p.scopeCode));

    const fragen = sichtbar.map((p) => p.frage).sort();
    expect(fragen).toEqual(["Nord-Frage?", "Sued-Frage?", "Stadtweite Frage?"].sort());
    // Tenant-Isolation: die fremde Umfrage ist NIE in der tenant-scoped Query.
    expect(alle.some((p) => p.frage === "Fremder Tenant?")).toBe(false);
  });

  it.skipIf(SKIP)("4b. ortsteil-Beobachter sieht NUR den eigenen Ortsteil — außerhalb nichts", async () => {
    const rollen = await getUserRolesMitScope(db, tenantId, beobachterNordId);
    const alle = await getAllPollsForAdmin(db, tenantId);
    const sichtbar = alle.filter((p) => beobachterDarfSehen(rollen, p.scopeLevel, p.scopeCode));

    expect(sichtbar.map((p) => p.frage)).toEqual(["Nord-Frage?"]);
    // Insbesondere: KEINE stadtweiten und KEINE fremden Ortsteil-Umfragen.
    expect(sichtbar.some((p) => p.frage === "Stadtweite Frage?")).toBe(false);
    expect(sichtbar.some((p) => p.frage === "Sued-Frage?")).toBe(false);
    // Digest-Sicht (Digests sind stadtweit): ortsteil-Beobachter → false.
    expect(beobachterDarfSehen(rollen, "stadt", null)).toBe(false);
  });

  it.skipIf(SKIP)("5. Tenant-Isolation: im fremden Tenant keine Rollen, keine Sicht", async () => {
    const rollenImFremdenTenant = await getUserRolesMitScope(db, tenant2Id, beobachterStadtId);
    expect(rollenImFremdenTenant).toEqual([]);
    expect(await getUserRoleTypes(db, tenant2Id, beobachterStadtId)).toEqual([]);
    expect(beobachterDarfSehen(rollenImFremdenTenant, "stadt", null)).toBe(false);
  });

  it.skipIf(SKIP)("6. Gesperrtes Konto verliert die Beobachter-Sicht sofort (fail-closed)", async () => {
    await db
      .update(users)
      .set({ accountStatus: "locked" })
      .where(eq(users.id, beobachterNordId));
    try {
      expect(await getUserRoleTypes(db, tenantId, beobachterNordId)).toEqual([]);
      expect(await getUserRolesMitScope(db, tenantId, beobachterNordId)).toEqual([]);
    } finally {
      await db
        .update(users)
        .set({ accountStatus: "active" })
        .where(eq(users.id, beobachterNordId));
    }
  });

  it.skipIf(SKIP)("7. kommune_admin kann beobachter wieder entziehen (auditiert)", async () => {
    const [beobRolle] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.tenantId, tenantId),
          eq(roles.userId, beobachterStadtId),
          eq(roles.roleType, "beobachter"),
        ),
      )
      .limit(1);

    const result = await revokeRoleCore(db, tenantId, ["kommune_admin"], kommuneAdminId, {
      roleId: beobRolle.id,
    });
    expect(result.ok).toBe(true);
    expect(await getUserRoleTypes(db, tenantId, beobachterStadtId)).toEqual([]);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "role.revoked"), eq(auditEvents.targetId, beobachterStadtId)),
      );
    expect(audits.length).toBe(1);
    expect((audits[0].metadata as Record<string, unknown>).roleType).toBe("beobachter");
    expect(JSON.stringify(audits[0].metadata)).not.toContain("@");
  });
});
