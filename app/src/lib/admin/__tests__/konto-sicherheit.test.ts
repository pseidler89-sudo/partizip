/**
 * konto-sicherheit.test.ts — Integrationstest Konto-Sicherheit (Block K2).
 * Ruft die ECHTEN Core-Funktionen gegen echte Postgres, keine gespiegelte Logik.
 *
 * Getestete Szenarien:
 *   1. Nicht-Admin-Caller ⇒ alle Aktionen verweigert.
 *   2. Selbst-Ziel ⇒ verweigert (kein Selbst-Aussperren/-Offboarding).
 *   3. Tenant-Isolation: Ziel in fremdem Tenant ⇒ „Konto nicht gefunden.";
 *      Sessions eines fremden Tenants bleiben bei gleicher userId unangetastet.
 *   4. ESKALATIONSGRENZE über Ziel-Rollen: kommune_admin vs. super_admin-Ziel ⇒
 *      verweigert (sperren/sessions/offboarding/entsperren — auch bei GESPERRTEM
 *      Ziel, dessen Rollen ungefiltert zählen); super_admin-Caller ⇒ erlaubt.
 *   5. LETZTER-AKTIVER-ADMIN (dokumentiertes Verhalten): Sperren erlaubt,
 *      solange mindestens ein anderer aktiver Admin (inkl. Caller) übrig bleibt;
 *      ohne verbleibenden aktiven Admin ⇒ verweigert und ALLES unverändert
 *      (Tiefenverteidigung — das Selbst-Ziel-Verbot deckt den Normalfall ab).
 *   6. Atomik: doppeltes Sperren ⇒ „nicht aktiv"; Entsperren nur aus locked.
 *   7. sessionsBeenden: revoziert nur revoked_at-IS-NULL-Zeilen, zählt korrekt,
 *      bereits revozierte bleiben; 0 aktive Sessions ⇒ ok:true.
 *   8. Sperren beendet Sessions in derselben Tx (+ Audit sessionsBeendet).
 *   9. Offboarding: all-or-nothing, Erfolgsfall (Rollen weg + Sessions revoziert
 *      + Konto bleibt AKTIV), 0-Rollen-Fall, Letzter-Admin-Guard.
 *  10. kontoSperrenPerEmail: case-insensitive Treffer, fremder Tenant nicht.
 *  11. Audit-Events vorhanden, metadata OHNE E-Mail (PII-frei).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst skip).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import {
  sessionsBeendenCore,
  kontoSperrenCore,
  kontoEntsperrenCore,
  offboardingCore,
  kontoSperrenPerEmailCore,
} from "@/lib/admin/konto-sicherheit-core.js";
import type { RoleType } from "@/lib/auth/roles";
import type { Db } from "@/db/client";

const { tenants, users, roles, sessions, auditEvents } = schema;

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
const KEIN_ADMIN = ["verifier", "redakteur", "beobachter"];

describe("Konto-Sicherheit (Block K2, Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let tenant2Id: string;
  let callerAdminId: string; // Admin-Caller im Tenant 1 (Audit-Akteur)
  let regionT1: string;
  let regionT2: string;

  let counter = 0;
  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@konto-test.de`;
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
      .values({ slug: `konto-${Date.now()}`, name: "Konto-Test-Tenant" })
      .returning();
    tenantId = tenant.id;

    const [tenant2] = await db
      .insert(tenants)
      .values({ slug: `konto-t2-${Date.now()}`, name: "Konto-Test-Tenant-2" })
      .returning();
    tenant2Id = tenant2.id;

    regionT1 = await resolveRegionIdForScope(db, tenantId, "stadt", null);
    regionT2 = await resolveRegionIdForScope(db, tenant2Id, "stadt", null);

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

  /** Legt einen User an (Default: Tenant 1, aktiv). */
  async function createUser(
    prefix: string,
    tId: string = tenantId,
    accountStatus: "active" | "locked" | "deleted" = "active",
  ) {
    const email = nextEmail(prefix);
    const [u] = await db
      .insert(users)
      .values({ tenantId: tId, email, accountStatus })
      .returning();
    return { id: u.id, email };
  }

  /** Legt eine Rolle direkt an (regionId aus dem Tenant-Baum). */
  async function addRole(userId: string, roleType: string, tId: string = tenantId) {
    const regionId = tId === tenantId ? regionT1 : regionT2;
    const [r] = await db
      .insert(roles)
      .values({ tenantId: tId, userId, roleType: roleType as RoleType, regionId })
      .returning();
    return r;
  }

  /** Legt eine Session an (Default: Tenant 1, aktiv, 1 h gültig). */
  async function createSession(
    userId: string,
    tId: string = tenantId,
    revoked = false,
    abgelaufen = false,
  ) {
    const [s] = await db
      .insert(sessions)
      .values({
        userId,
        tenantId: tId,
        tokenHash: `hash-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2)}`,
        expiresAt: abgelaufen
          ? new Date(Date.now() - 60 * 60 * 1000)
          : new Date(Date.now() + 60 * 60 * 1000),
        ...(revoked ? { revokedAt: new Date(Date.now() - 1000) } : {}),
      })
      .returning();
    return s;
  }

  async function aktiveSessions(userId: string, tId: string = tenantId) {
    return db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.tenantId, tId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
      );
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 1. Nicht-Admin-Caller
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("1. Nicht-Admin-Caller ⇒ alle Aktionen verweigert", async () => {
    const ziel = await createUser("na-ziel");

    for (const core of [sessionsBeendenCore, kontoSperrenCore, kontoEntsperrenCore, offboardingCore]) {
      const res = await core(db, tenantId, KEIN_ADMIN, callerAdminId, ziel.id);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Admin erforderlich/i);
    }
    const perEmail = await kontoSperrenPerEmailCore(db, tenantId, KEIN_ADMIN, callerAdminId, ziel.email);
    expect(perEmail.ok).toBe(false);
    expect(perEmail.error).toMatch(/Admin erforderlich/i);
  });

  // -------------------------------------------------------------------------
  // 2. Selbst-Ziel
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("2. Selbst-Ziel ⇒ verweigert (alle Aktionen)", async () => {
    for (const core of [sessionsBeendenCore, kontoSperrenCore, kontoEntsperrenCore, offboardingCore]) {
      const res = await core(db, tenantId, SUPER, callerAdminId, callerAdminId);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/eigenes Konto/i);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Tenant-Isolation
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("3. Ziel-User in Tenant B ⇒ Konto nicht gefunden", async () => {
    const fremd = await createUser("fremd", tenant2Id);
    const res = await sessionsBeendenCore(db, tenantId, SUPER, callerAdminId, fremd.id);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Konto nicht gefunden.");
  });

  it.skipIf(SKIP)("3b. sessionsBeenden lässt Sessions des fremden Tenants unangetastet", async () => {
    // User in Tenant A mit je einer Session in A UND (konstruiert) in B —
    // der tenant-scoped UPDATE darf NUR die A-Session treffen.
    const ziel = await createUser("iso-ziel");
    await createSession(ziel.id, tenantId);
    const fremdeSession = await createSession(ziel.id, tenant2Id);

    const res = await sessionsBeendenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/1 aktive Sitzung beendet/);

    expect((await aktiveSessions(ziel.id, tenantId)).length).toBe(0);
    const fremdNoch = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, fremdeSession.id));
    expect(fremdNoch[0].revokedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Eskalationsgrenze über die Ziel-Rollen
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("4. kommune_admin vs. super_admin-Ziel ⇒ verweigert; super_admin ⇒ erlaubt", async () => {
    const ziel = await createUser("esk-ziel");
    await addRole(ziel.id, "super_admin");
    // Zweiter aktiver Admin, damit NICHT der Letzter-Admin-Guard greift.
    const zweitAdmin = await createUser("esk-zweit");
    await addRole(zweitAdmin.id, "super_admin");
    await createSession(ziel.id);

    for (const core of [sessionsBeendenCore, kontoSperrenCore, offboardingCore]) {
      const res = await core(db, tenantId, KOMMUNE, callerAdminId, ziel.id);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Keine Berechtigung für dieses Konto.");
    }
    // Nichts verändert: Rolle da, Session aktiv, Konto aktiv.
    expect((await aktiveSessions(ziel.id)).length).toBe(1);
    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("active");

    // super_admin-Caller darf: Sperren geht durch.
    const res = await kontoSperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(true);
  });

  it.skipIf(SKIP)("4b. Entsperren eines GESPERRTEN super_admin-Ziels: kommune_admin verweigert (Rollen ungefiltert), super_admin erlaubt", async () => {
    const ziel = await createUser("esk-locked", tenantId, "locked");
    await addRole(ziel.id, "super_admin");

    // Die super_admin-Rolle des gesperrten Ziels MUSS zählen (direkte roles-
    // Lesung, nicht getUserRoleTypes) — sonst könnte ein kommune_admin einen
    // gesperrten super_admin entsperren.
    const verboten = await kontoEntsperrenCore(db, tenantId, KOMMUNE, callerAdminId, ziel.id);
    expect(verboten.ok).toBe(false);
    expect(verboten.error).toBe("Keine Berechtigung für dieses Konto.");

    const erlaubt = await kontoEntsperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(erlaubt.ok).toBe(true);
    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("active");
  });

  it.skipIf(SKIP)("4c. gelöschtes Ziel wird NIE angefasst", async () => {
    const ziel = await createUser("del-ziel", tenantId, "deleted");
    for (const core of [sessionsBeendenCore, kontoSperrenCore, kontoEntsperrenCore, offboardingCore]) {
      const res = await core(db, tenantId, SUPER, callerAdminId, ziel.id);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Dieses Konto wurde gelöscht.");
    }
  });

  // -------------------------------------------------------------------------
  // 5. Letzter-aktiver-Admin (Tiefenverteidigung, dokumentiertes Verhalten)
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("5. Sperren erlaubt, solange ein anderer aktiver Admin (inkl. Caller) übrig bleibt", async () => {
    // Frischer Tenant: Caller (aktiver kommune_admin in der DB) + Ziel-Admin +
    // ein bereits gesperrter Dritt-Admin (zählt NICHT als aktiv).
    const [t] = await db
      .insert(tenants)
      .values({ slug: `konto-letzt-a-${Date.now()}-${++counter}`, name: "Letzt-A" })
      .returning();
    const region = await resolveRegionIdForScope(db, t.id, "stadt", null);
    const caller = await createUser("la-caller", t.id);
    const ziel = await createUser("la-ziel", t.id);
    const gesperrt = await createUser("la-locked", t.id, "locked");
    await db.insert(roles).values([
      { tenantId: t.id, userId: caller.id, roleType: "kommune_admin", regionId: region },
      { tenantId: t.id, userId: ziel.id, roleType: "kommune_admin", regionId: region },
      { tenantId: t.id, userId: gesperrt.id, roleType: "kommune_admin", regionId: region },
    ]);

    // Der CALLER zählt als anderer aktiver Admin ⇒ Sperren des Ziels erlaubt.
    const res = await kontoSperrenCore(db, t.id, KOMMUNE, caller.id, ziel.id);
    expect(res.ok).toBe(true);
    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("locked");
  });

  it.skipIf(SKIP)("5b. KEIN verbleibender aktiver Admin ⇒ Sperren verweigert, ALLES unverändert", async () => {
    // Konstruierter Tiefenverteidigungs-Fall: das Ziel ist der EINZIGE Admin des
    // Tenants; der Caller ist kein (aktiver) Admin dieses Tenants in der DB
    // (z. B. gesperrtes Caller-Konto bei noch gültiger Session / Race).
    const [t] = await db
      .insert(tenants)
      .values({ slug: `konto-letzt-b-${Date.now()}-${++counter}`, name: "Letzt-B" })
      .returning();
    const region = await resolveRegionIdForScope(db, t.id, "stadt", null);
    const ziel = await createUser("lb-ziel", t.id);
    await db
      .insert(roles)
      .values({ tenantId: t.id, userId: ziel.id, roleType: "kommune_admin", regionId: region });
    await createSession(ziel.id, t.id);

    const res = await kontoSperrenCore(db, t.id, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/letzte aktive Administrator-Rolle/i);

    // Fehler im Guard ⇒ die GESAMTE Tx bleibt wirkungslos: Konto aktiv,
    // Session aktiv, Rolle vorhanden.
    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("active");
    expect((await aktiveSessions(ziel.id, t.id)).length).toBe(1);
    const rollen = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, t.id), eq(roles.userId, ziel.id)));
    expect(rollen.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. Atomik Sperren/Entsperren
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("6. doppeltes Sperren ⇒ nicht aktiv; Entsperren nur aus locked", async () => {
    const ziel = await createUser("atomik");

    // Entsperren eines AKTIVEN Kontos ⇒ Fehler.
    const nichtGesperrt = await kontoEntsperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(nichtGesperrt.ok).toBe(false);
    expect(nichtGesperrt.error).toBe("Konto ist nicht gesperrt.");

    const erste = await kontoSperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(erste.ok).toBe(true);

    const zweite = await kontoSperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(zweite.ok).toBe(false);
    expect(zweite.error).toBe("Konto ist nicht aktiv (bereits gesperrt oder gelöscht).");

    const entsperrt = await kontoEntsperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(entsperrt.ok).toBe(true);
    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("active");
  });

  // -------------------------------------------------------------------------
  // 7. sessionsBeenden — nur aktive Zeilen, korrekte Zählung
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("7. sessionsBeenden revoziert nur aktive Sessions; revozierte und abgelaufene bleiben", async () => {
    const ziel = await createUser("sess-ziel");
    await createSession(ziel.id);
    await createSession(ziel.id);
    const schonRevoziert = await createSession(ziel.id, tenantId, true);
    const altesRevokedAt = schonRevoziert.revokedAt;
    // Gate-B K2 (MINOR): abgelaufene Session zählt NICHT als aktiv — sie darf
    // weder in der Anzahl auftauchen noch angefasst werden (Live-Risiko = 2).
    const abgelaufen = await createSession(ziel.id, tenantId, false, true);

    const res = await sessionsBeendenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/2 aktive Sitzungen beendet/);

    // Unrevoziert bleibt NUR die abgelaufene Session (unbenutzbar, unangetastet).
    const unrevoziert = await aktiveSessions(ziel.id);
    expect(unrevoziert.length).toBe(1);
    expect(unrevoziert[0].id).toBe(abgelaufen.id);
    // Die bereits revozierte Session behält ihren alten Zeitstempel.
    const [alt] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, schonRevoziert.id));
    expect(alt.revokedAt?.getTime()).toBe(altesRevokedAt?.getTime());

    // Audit mit korrekter Anzahl (nur Live-Sessions, wie die UI-Zählung).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "account.sessions_revoked"), eq(auditEvents.targetId, ziel.id)));
    expect(audit.length).toBe(1);
    expect((audit[0].metadata as Record<string, unknown>).anzahl).toBe(2);
  });

  it.skipIf(SKIP)("7b. sessionsBeenden mit 0 aktiven Sessions ⇒ ok:true, Message nennt 0", async () => {
    const ziel = await createUser("sess-leer");
    const res = await sessionsBeendenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/0 aktive Sitzungen beendet/);
  });

  // -------------------------------------------------------------------------
  // 8. Sperren beendet Sessions in derselben Tx
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("8. Sperren setzt locked UND revoziert alle aktiven Sessions (eine Tx, Audit)", async () => {
    const ziel = await createUser("sperr-sess");
    await createSession(ziel.id);
    await createSession(ziel.id);
    // Abgelaufene Session zählt nicht ins IR-Audit (sessionsBeendet = Live-Sessions).
    await createSession(ziel.id, tenantId, false, true);

    const res = await kontoSperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(true);

    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("locked");
    // Unrevoziert bleibt nur die abgelaufene (unbenutzbare) Session.
    expect((await aktiveSessions(ziel.id)).length).toBe(1);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "account.locked"), eq(auditEvents.targetId, ziel.id)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(callerAdminId);
    expect((audit[0].metadata as Record<string, unknown>).sessionsBeendet).toBe(2);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  // -------------------------------------------------------------------------
  // 9. Offboarding
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("9. Offboarding all-or-nothing: eine nicht verwaltbare Rolle ⇒ KEINE Rolle gelöscht", async () => {
    const ziel = await createUser("off-mixed");
    await addRole(ziel.id, "verifier");
    await addRole(ziel.id, "super_admin");
    // Zweiter aktiver Admin, damit nicht der Letzter-Admin-Guard das Ergebnis verfälscht.
    const zweitAdmin = await createUser("off-zweit");
    await addRole(zweitAdmin.id, "super_admin");

    const res = await offboardingCore(db, tenantId, KOMMUNE, callerAdminId, ziel.id);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Keine Berechtigung für dieses Konto.");

    const rollen = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, ziel.id)));
    expect(rollen.length).toBe(2); // verifier UND super_admin unverändert
  });

  it.skipIf(SKIP)("9b. Offboarding-Erfolg: alle Rollen weg, Sessions revoziert, Konto bleibt AKTIV", async () => {
    const ziel = await createUser("off-ok");
    await addRole(ziel.id, "verifier");
    await addRole(ziel.id, "redakteur");
    await createSession(ziel.id);

    const res = await offboardingCore(db, tenantId, KOMMUNE, callerAdminId, ziel.id);
    expect(res.ok).toBe(true);

    const rollen = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, ziel.id)));
    expect(rollen.length).toBe(0);
    expect((await aktiveSessions(ziel.id)).length).toBe(0);
    // Konto-Status UNVERÄNDERT: Ex-Rollenträger bleibt Bürger.
    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("active");

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "account.offboarded"), eq(auditEvents.targetId, ziel.id)));
    expect(audit.length).toBe(1);
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.roleTypes).toEqual(expect.arrayContaining(["verifier", "redakteur"]));
    expect(meta.sessionsBeendet).toBe(1);
    expect(JSON.stringify(meta)).not.toContain("@");
  });

  it.skipIf(SKIP)("9c. Offboarding ohne Rollen ⇒ Fehler, Sessions bleiben unangetastet", async () => {
    const ziel = await createUser("off-leer");
    await createSession(ziel.id);

    const res = await offboardingCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Dieses Konto hat keine Rollen.");
    // Sessions BEWUSST nicht angefasst — dafür gibt es die eigene Aktion.
    expect((await aktiveSessions(ziel.id)).length).toBe(1);
  });

  it.skipIf(SKIP)("9d. Offboarding des letzten aktiven Admins ⇒ verweigert, Rollen bleiben", async () => {
    const [t] = await db
      .insert(tenants)
      .values({ slug: `konto-off-la-${Date.now()}-${++counter}`, name: "Off-Letzt" })
      .returning();
    const region = await resolveRegionIdForScope(db, t.id, "stadt", null);
    const ziel = await createUser("off-la-ziel", t.id);
    await db
      .insert(roles)
      .values({ tenantId: t.id, userId: ziel.id, roleType: "kommune_admin", regionId: region });

    const res = await offboardingCore(db, t.id, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/letzte aktive Administrator-Rolle/i);

    const rollen = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, t.id), eq(roles.userId, ziel.id)));
    expect(rollen.length).toBe(1);
  });

  it.skipIf(SKIP)("9e. Offboarding-Message ist statusabhängig: gesperrtes Ziel ⇒ bleibt gesperrt", async () => {
    // Gate-B K2 (MINOR): IR-Kette „erst sperren, dann Rollen entziehen" — die
    // Erfolgsmeldung darf nicht behaupten, das Konto sei aktiv.
    const gesperrtesZiel = await createUser("off-locked", tenantId, "locked");
    await addRole(gesperrtesZiel.id, "verifier");
    const resLocked = await offboardingCore(db, tenantId, SUPER, callerAdminId, gesperrtesZiel.id);
    expect(resLocked.ok).toBe(true);
    expect(resLocked.message).toContain("Das Konto bleibt gesperrt.");
    expect(resLocked.message).not.toContain("bleibt als Bürgerkonto aktiv");
    // Status unverändert: Offboarding hebt die Sperre NICHT auf.
    const [row] = await db.select().from(users).where(eq(users.id, gesperrtesZiel.id));
    expect(row.accountStatus).toBe("locked");

    // Aktives Ziel ⇒ die Aktiv-Variante der Message.
    const aktivesZiel = await createUser("off-aktiv");
    await addRole(aktivesZiel.id, "verifier");
    const resAktiv = await offboardingCore(db, tenantId, SUPER, callerAdminId, aktivesZiel.id);
    expect(resAktiv.ok).toBe(true);
    expect(resAktiv.message).toContain("Das Konto bleibt als Bürgerkonto aktiv.");
  });

  // -------------------------------------------------------------------------
  // 10. kontoSperrenPerEmail
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("10. kontoSperrenPerEmail: case-insensitive Treffer, fremder Tenant nicht", async () => {
    // users.email ist NICHT normalisiert gespeichert — gemischte Schreibweise.
    const email = `Max-${Date.now()}-${++counter}@Konto-Test.DE`;
    const [ziel] = await db.insert(users).values({ tenantId, email }).returning();

    // Fremder Tenant findet das Konto NICHT (generische Meldung).
    const fremd = await kontoSperrenPerEmailCore(
      db, tenant2Id, SUPER, callerAdminId, email.toLowerCase(),
    );
    expect(fremd.ok).toBe(false);
    expect(fremd.error).toBe("Konto nicht gefunden.");

    // Case-insensitiv + getrimmt im richtigen Tenant ⇒ gesperrt.
    const res = await kontoSperrenPerEmailCore(
      db, tenantId, SUPER, callerAdminId, `  ${email.toLowerCase()}  `,
    );
    expect(res.ok).toBe(true);
    const [zielRow] = await db.select().from(users).where(eq(users.id, ziel.id));
    expect(zielRow.accountStatus).toBe("locked");

    // Unbekannte Adresse ⇒ generisch (keine Konto-Existenz-Bestätigung).
    const unbekannt = await kontoSperrenPerEmailCore(
      db, tenantId, SUPER, callerAdminId, nextEmail("gibts-nicht"),
    );
    expect(unbekannt.ok).toBe(false);
    expect(unbekannt.error).toBe("Konto nicht gefunden.");
  });

  it.skipIf(SKIP)("10b. kontoSperrenPerEmail sperrt Case-Zwillinge deterministisch BEIDE (Gate-B MAJOR)", async () => {
    // users_tenant_email_unique ist case-SENSITIV und der Signup normalisiert
    // nicht — „Max@…" und „max@…" können als ZWEI Konten existieren. Die
    // IR-Sperre muss die Adresse KOMPLETT stilllegen, nicht ein planner-
    // abhängiges Einzelkonto.
    const basis = `zwilling-${Date.now()}-${++counter}@konto-test.de`;
    const emailGross = `Max.${basis}`;
    const emailKlein = `max.${basis}`;
    const [zwillingA] = await db.insert(users).values({ tenantId, email: emailGross }).returning();
    const [zwillingB] = await db.insert(users).values({ tenantId, email: emailKlein }).returning();
    await createSession(zwillingA.id);
    await createSession(zwillingB.id);

    const res = await kontoSperrenPerEmailCore(
      db, tenantId, SUPER, callerAdminId, emailKlein,
    );
    expect(res.ok).toBe(true);
    expect(res.message).toContain("2 Konten gesperrt");

    // BEIDE Konten gesperrt, BEIDE Sessions beendet — kein Re-Login über die
    // andere Schreibweise möglich.
    for (const z of [zwillingA, zwillingB]) {
      const [row] = await db.select().from(users).where(eq(users.id, z.id));
      expect(row.accountStatus).toBe("locked");
      expect((await aktiveSessions(z.id)).length).toBe(0);
      // Audit je Konto (aus kontoSperrenCore).
      const audit = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "account.locked"), eq(auditEvents.targetId, z.id)));
      expect(audit.length).toBe(1);
    }

    // Teilergebnis: erneuter Aufruf — beide bereits gesperrt ⇒ ok:false mit
    // präziser Begründung, kein stiller „Erfolg".
    const nochmal = await kontoSperrenPerEmailCore(
      db, tenantId, SUPER, callerAdminId, emailGross,
    );
    expect(nochmal.ok).toBe(false);
    expect(nochmal.error).toContain("nicht aktiv");
  });

  // -------------------------------------------------------------------------
  // 11. Audit-Vollständigkeit (unlocked + PII-Freiheit)
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("11. Entsperren schreibt account.unlocked-Audit, PII-frei", async () => {
    const ziel = await createUser("audit-ziel", tenantId, "locked");
    const res = await kontoEntsperrenCore(db, tenantId, SUPER, callerAdminId, ziel.id);
    expect(res.ok).toBe(true);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "account.unlocked"), eq(auditEvents.targetId, ziel.id)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(callerAdminId);
    expect(audit[0].actorType).toBe("admin");
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
    expect(audit[0].targetId).not.toContain("@");
  });
});
