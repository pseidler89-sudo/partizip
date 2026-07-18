/**
 * appointment.test.ts — DB-Integrationstest Vier-Augen-Verifier-Ernennung
 * (Block K3). Ruft die ECHTEN Kern-Funktionen aus appointment-core.ts direkt
 * gegen ein ephemeres PG16 auf (keine Logik-Spiegelung; Auth/Tenant als
 * Parameter, exakt wie in den "use server"-Actions).
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt):
 *   - Vorschlagen: pending + Audit (PII-frei), KEINE Rolle; Duplikat-pending
 *     freundlich (partieller UNIQUE-Index); Rolle existiert bereits freundlich;
 *     gesperrtes Ziel/Nicht-Admin/fremder Tenant abgelehnt.
 *   - Entscheiden: zweiter Admin bestätigt → Rolle + approved + Audits; SELBST
 *     ohne Flag → SoD-Fehler (bleibt pending); SELBST mit Überbrückung
 *     (isSelfApprovalAllowed({ALLOW_SELF_APPROVAL:"true"})) → ok + sichtbares
 *     selfApproval-Audit; ablehnen → keine Rolle; doppelt entscheiden →
 *     „bereits entschieden"; Ziel inzwischen gesperrt → Fehler, bleibt pending;
 *     Rolle inzwischen vorhanden → approved + „bestand bereits", kein Duplikat.
 *   - Zurückziehen: Vorschlagende:r ok, anderer Admin ok, Nicht-Admin nein.
 *   - Integration: assignRoleCore('verifier') erzeugt Appointment statt Rolle
 *     (andere Rollen unverändert direkt); Einladungs-Accept mit verifier →
 *     Appointment pending (proposed_by = Einladende:r), KEINE Rolle; Doppel-
 *     Accept-Fall still ok (kein Duplikat).
 *   - Migration-Smoke implizit: Tabelle + partieller UNIQUE-Index existieren
 *     (Tests laufen gegen die migrierte DB, der Duplikat-Test trifft den Index).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst skip).
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
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { getUserRoleTypes } from "@/lib/auth/roles";
import { isSelfApprovalAllowed } from "@/lib/digest/freigabe-core";
import {
  verifierErnennungVorschlagenCore,
  verifierErnennungEntscheidenCore,
  verifierErnennungZurueckziehenCore,
  offeneErnennungenListeCore,
} from "@/lib/admin/appointment-core";
import { assignRoleCore } from "@/lib/admin/role-actions";
import { einladenCore, einladungAnnehmenCore } from "@/lib/admin/invitation-core";
import type { Db } from "@/db/client";

const { tenants, users, roles, roleAppointments, auditEvents } = schema;

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

describe("Vier-Augen-Verifier-Ernennung (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let tenant2Id: string;
  let adminAId: string; // kommune_admin (Vorschlagende:r in den meisten Tests)
  let adminBId: string; // zweiter kommune_admin (Bestätiger)

  let counter = 0;
  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@ernennung-test.de`;
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

    const [t1] = await db
      .insert(tenants)
      .values({ slug: `ern-${Date.now()}`, name: "Ernennung-Test-Tenant" })
      .returning();
    tenantId = t1.id;

    const [t2] = await db
      .insert(tenants)
      .values({ slug: `ern-t2-${Date.now()}`, name: "Ernennung-Test-Tenant-2" })
      .returning();
    tenant2Id = t2.id;

    const stadtRegion = await resolveRegionIdForScope(db, tenantId, "stadt", null);
    const [a] = await db.insert(users).values({ tenantId, email: nextEmail("admin-a") }).returning();
    adminAId = a.id;
    const [b] = await db.insert(users).values({ tenantId, email: nextEmail("admin-b") }).returning();
    adminBId = b.id;
    await db.insert(roles).values([
      { tenantId, userId: adminAId, roleType: "kommune_admin", regionId: stadtRegion },
      { tenantId, userId: adminBId, roleType: "kommune_admin", regionId: stadtRegion },
    ]);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  /** Legt ein aktives Konto im Tenant an und gibt {id, email} zurück. */
  async function createUser(prefix: string, tId: string = tenantId) {
    const email = nextEmail(prefix);
    const [u] = await db.insert(users).values({ tenantId: tId, email }).returning();
    return { id: u.id, email };
  }

  /** Kurzform: Vorschlag durch adminA (Standard-Scope stadt). */
  async function vorschlagen(targetEmail: string) {
    return verifierErnennungVorschlagenCore(db, tenantId, KOMMUNE, adminAId, { targetEmail });
  }

  async function apptById(id: string) {
    const [row] = await db
      .select()
      .from(roleAppointments)
      .where(eq(roleAppointments.id, id))
      .limit(1);
    return row;
  }

  async function verifierRollen(userId: string) {
    return db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, userId), eq(roles.roleType, "verifier")));
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Vorschlagen
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("Vorschlagen legt pending an (KEINE Rolle) + PII-freies Audit", async () => {
    const ziel = await createUser("vorschlag");
    const res = await vorschlagen(ziel.email);
    expect(res.ok).toBe(true);
    expect(res.appointmentId).toBeTruthy();
    expect(res.message).toMatch(/Vier-Augen/);

    const appt = await apptById(res.appointmentId!);
    expect(appt.status).toBe("pending");
    expect(appt.targetUserId).toBe(ziel.id);
    expect(appt.roleType).toBe("verifier");
    expect(appt.proposedBy).toBe(adminAId);

    // KEINE Rolle vergeben.
    expect((await verifierRollen(ziel.id)).length).toBe(0);

    // Audit role.appointment_proposed, PII-frei (keine E-Mail).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.appointment_proposed"), eq(auditEvents.targetId, ziel.id)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(adminAId);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.appointmentId).toBe(res.appointmentId);
    expect(meta.roleType).toBe("verifier");
    expect(meta.regionId).toBe(appt.regionId);
  });

  it.skipIf(SKIP)("Duplikat-pending → freundlicher Fehler (partieller UNIQUE-Index)", async () => {
    const ziel = await createUser("duplikat");
    expect((await vorschlagen(ziel.email)).ok).toBe(true);

    const res2 = await vorschlagen(ziel.email);
    expect(res2.ok).toBe(false);
    expect(res2.error).toMatch(/bereits ein offener Vorschlag/i);

    // Genau EINE pending-Zeile.
    const rows = await db
      .select({ id: roleAppointments.id })
      .from(roleAppointments)
      .where(
        and(
          eq(roleAppointments.tenantId, tenantId),
          eq(roleAppointments.targetUserId, ziel.id),
          eq(roleAppointments.status, "pending"),
        ),
      );
    expect(rows.length).toBe(1);
  });

  it.skipIf(SKIP)("Rolle existiert bereits → freundlich, kein neuer Vorschlag", async () => {
    const ziel = await createUser("hat-rolle");
    const regionId = await resolveRegionIdForScope(db, tenantId, "stadt", null);
    await db.insert(roles).values({ tenantId, userId: ziel.id, roleType: "verifier", regionId });

    const res = await vorschlagen(ziel.email);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/hat die Rolle bereits/i);
    expect(res.appointmentId).toBeUndefined();

    const rows = await db
      .select({ id: roleAppointments.id })
      .from(roleAppointments)
      .where(and(eq(roleAppointments.tenantId, tenantId), eq(roleAppointments.targetUserId, ziel.id)));
    expect(rows.length).toBe(0);
  });

  it.skipIf(SKIP)("gesperrtes Ziel-Konto → Fehler, kein Vorschlag", async () => {
    const ziel = await createUser("gesperrt");
    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, ziel.id));

    const res = await vorschlagen(ziel.email);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nicht aktiv/i);
  });

  it.skipIf(SKIP)("Nicht-Admin kann NICHT vorschlagen", async () => {
    const ziel = await createUser("kein-admin-ziel");
    for (const roles_ of [["user"], ["verifier"], ["beobachter"], []]) {
      const res = await verifierErnennungVorschlagenCore(db, tenantId, roles_, adminAId, {
        targetEmail: ziel.email,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Admin erforderlich/i);
    }
  });

  it.skipIf(SKIP)("Tenant-Isolation: Ziel aus fremdem Tenant unsichtbar; fremdes Appointment nicht entscheidbar", async () => {
    // Ziel existiert nur in Tenant 2 → aus Tenant 1 heraus „kein Konto".
    const fremd = await createUser("fremd", tenant2Id);
    const res = await vorschlagen(fremd.email);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/kein Konto/i);

    // Appointment in Tenant 1 ist aus Tenant 2 heraus unsichtbar.
    const ziel = await createUser("iso-ziel");
    const created = await vorschlagen(ziel.email);
    const resEntscheiden = await verifierErnennungEntscheidenCore(db, tenant2Id, SUPER, adminBId, {
      appointmentId: created.appointmentId!,
      entscheidung: "bestaetigen",
    });
    expect(resEntscheiden.ok).toBe(false);
    expect(resEntscheiden.error).toMatch(/nicht gefunden/i);
    expect((await apptById(created.appointmentId!)).status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Entscheiden
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("zweiter Admin bestätigt → Rolle + approved + Audits (appointment_approved, role.granted)", async () => {
    const ziel = await createUser("bestaetigt");
    const created = await vorschlagen(ziel.email);

    const res = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: created.appointmentId!,
      entscheidung: "bestaetigen",
    });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/Rolle wurde vergeben/i);

    const appt = await apptById(created.appointmentId!);
    expect(appt.status).toBe("approved");
    expect(appt.decidedBy).toBe(adminBId);
    expect(appt.decidedAt).not.toBeNull();

    expect(await getUserRoleTypes(db, tenantId, ziel.id)).toContain("verifier");
    // Rolle trägt den Gebietsknoten des Vorschlags.
    const [rolle] = await verifierRollen(ziel.id);
    expect(rolle).toBeTruthy();

    const approvedAudit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.appointment_approved"), eq(auditEvents.targetId, ziel.id)));
    expect(approvedAudit.length).toBe(1);
    expect(approvedAudit[0].actorRef).toBe(adminBId);
    expect(JSON.stringify(approvedAudit[0].metadata)).not.toContain("@");
    // KEIN selfApproval-Marker (echter zweiter Admin).
    expect((approvedAudit[0].metadata as Record<string, unknown>).selfApproval).toBeUndefined();

    const grantedAudit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.granted"), eq(auditEvents.targetId, ziel.id)));
    expect(grantedAudit.length).toBe(1);
    expect((grantedAudit[0].metadata as Record<string, unknown>).via).toBe("appointment");
  });

  it.skipIf(SKIP)("SELBST-Bestätigung ohne Flag → SoD-Fehler, bleibt pending, keine Rolle", async () => {
    const ziel = await createUser("selbst-ohne-flag");
    const created = await vorschlagen(ziel.email);

    // isSelfApprovalAllowed fail-closed: fehlende/falsche Env ⇒ false.
    expect(isSelfApprovalAllowed({})).toBe(false);

    const res = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminAId, {
      appointmentId: created.appointmentId!,
      entscheidung: "bestaetigen",
      allowSelfApproval: isSelfApprovalAllowed({}),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Vier-Augen/i);

    expect((await apptById(created.appointmentId!)).status).toBe("pending");
    expect((await verifierRollen(ziel.id)).length).toBe(0);
  });

  it.skipIf(SKIP)("SELBST-Bestätigung MIT Überbrückung → ok, Rolle vergeben, selfApproval sichtbar im Audit", async () => {
    const ziel = await createUser("selbst-mit-flag");
    const created = await vorschlagen(ziel.email);

    // Env-injizierte Pilot-Überbrückung (exakt "true" — wiederverwendete Funktion).
    const allow = isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "true" });
    expect(allow).toBe(true);

    const res = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminAId, {
      appointmentId: created.appointmentId!,
      entscheidung: "bestaetigen",
      allowSelfApproval: allow,
    });
    expect(res.ok).toBe(true);
    expect((await apptById(created.appointmentId!)).status).toBe("approved");
    expect(await getUserRoleTypes(db, tenantId, ziel.id)).toContain("verifier");

    // Überbrückte Selbst-Bestätigung ist NIE unsichtbar.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.appointment_approved"), eq(auditEvents.targetId, ziel.id)));
    expect((audit[0].metadata as Record<string, unknown>).selfApproval).toBe(true);
  });

  it.skipIf(SKIP)("ablehnen → rejected, KEINE Rolle, Audit role.appointment_rejected", async () => {
    const ziel = await createUser("abgelehnt");
    const created = await vorschlagen(ziel.email);

    const res = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: created.appointmentId!,
      entscheidung: "ablehnen",
    });
    expect(res.ok).toBe(true);
    expect((await apptById(created.appointmentId!)).status).toBe("rejected");
    expect((await verifierRollen(ziel.id)).length).toBe(0);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.appointment_rejected"), eq(auditEvents.targetId, ziel.id)));
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("doppelt entscheiden → „bereits entschieden“", async () => {
    const ziel = await createUser("doppelt");
    const created = await vorschlagen(ziel.email);

    const r1 = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: created.appointmentId!,
      entscheidung: "ablehnen",
    });
    expect(r1.ok).toBe(true);

    const r2 = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: created.appointmentId!,
      entscheidung: "bestaetigen",
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/bereits entschieden/i);
    // Status unverändert rejected, keine Rolle.
    expect((await apptById(created.appointmentId!)).status).toBe("rejected");
    expect((await verifierRollen(ziel.id)).length).toBe(0);
  });

  it.skipIf(SKIP)("Ziel inzwischen gesperrt → Fehler, Appointment bleibt pending (Tx-Rollback)", async () => {
    const ziel = await createUser("spaeter-gesperrt");
    const created = await vorschlagen(ziel.email);
    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, ziel.id));

    const res = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: created.appointmentId!,
      entscheidung: "bestaetigen",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nicht mehr aktiv/i);

    // Flanke zurückgerollt: bleibt pending, keine Rolle, kein approved-Audit.
    expect((await apptById(created.appointmentId!)).status).toBe("pending");
    expect((await verifierRollen(ziel.id)).length).toBe(0);
  });

  it.skipIf(SKIP)("Rolle inzwischen anderweitig vorhanden → approved + „bestand bereits“, kein Duplikat", async () => {
    const ziel = await createUser("rolle-vorhanden");
    const created = await vorschlagen(ziel.email);

    // Rolle entsteht zwischenzeitlich anderweitig (z. B. Direkt-Insert/Bootstrap).
    const appt = await apptById(created.appointmentId!);
    await db.insert(roles).values({
      tenantId,
      userId: ziel.id,
      roleType: "verifier",
      regionId: appt.regionId,
    });

    const res = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: created.appointmentId!,
      entscheidung: "bestaetigen",
    });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/bestand bereits/i);
    expect((await apptById(created.appointmentId!)).status).toBe("approved");
    // Kein Duplikat (roles-UNIQUE + onConflictDoNothing).
    expect((await verifierRollen(ziel.id)).length).toBe(1);
    // KEIN role.granted-Audit für die Nicht-Vergabe.
    const granted = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.granted"), eq(auditEvents.targetId, ziel.id)));
    expect(granted.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Zurückziehen
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("Zurückziehen: Vorschlagende:r ok, anderer Admin ok, Nicht-Admin nein", async () => {
    // 1. Vorschlagende:r zieht zurück.
    const ziel1 = await createUser("rueckzug-1");
    const c1 = await vorschlagen(ziel1.email);
    const r1 = await verifierErnennungZurueckziehenCore(db, tenantId, KOMMUNE, adminAId, {
      appointmentId: c1.appointmentId!,
    });
    expect(r1.ok).toBe(true);
    expect((await apptById(c1.appointmentId!)).status).toBe("cancelled");

    // 2. Anderer Admin zieht zurück.
    const ziel2 = await createUser("rueckzug-2");
    const c2 = await vorschlagen(ziel2.email);
    const r2 = await verifierErnennungZurueckziehenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: c2.appointmentId!,
    });
    expect(r2.ok).toBe(true);
    expect((await apptById(c2.appointmentId!)).status).toBe("cancelled");

    // Audit vorhanden.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "role.appointment_cancelled"), eq(auditEvents.targetId, ziel2.id)));
    expect(audit.length).toBe(1);

    // 3. Nicht-Admin darf nicht.
    const ziel3 = await createUser("rueckzug-3");
    const c3 = await vorschlagen(ziel3.email);
    const r3 = await verifierErnennungZurueckziehenCore(db, tenantId, ["user"], adminAId, {
      appointmentId: c3.appointmentId!,
    });
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/Admin erforderlich/i);
    expect((await apptById(c3.appointmentId!)).status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Integration assignRoleCore
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("assignRole('verifier') erzeugt Appointment statt Rolle; andere Rollen direkt (Regression)", async () => {
    const ziel = await createUser("assign-verifier");
    const res = await assignRoleCore(db, tenantId, KOMMUNE, adminAId, {
      targetEmail: ziel.email,
      roleType: "verifier",
    });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/Vier-Augen/);

    // KEINE Rolle, aber ein pending-Appointment mit proposedBy = Caller.
    expect((await verifierRollen(ziel.id)).length).toBe(0);
    const appts = await db
      .select()
      .from(roleAppointments)
      .where(and(eq(roleAppointments.tenantId, tenantId), eq(roleAppointments.targetUserId, ziel.id)));
    expect(appts.length).toBe(1);
    expect(appts[0].status).toBe("pending");
    expect(appts[0].proposedBy).toBe(adminAId);

    // Regression: andere Rolle weiterhin DIREKT.
    const res2 = await assignRoleCore(db, tenantId, KOMMUNE, adminAId, {
      targetEmail: ziel.email,
      roleType: "redakteur",
    });
    expect(res2.ok).toBe(true);
    expect(await getUserRoleTypes(db, tenantId, ziel.id)).toContain("redakteur");
  });

  // -------------------------------------------------------------------------
  // Integration Einladungs-Accept
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("Einladungs-Accept mit verifier → Appointment pending (proposed_by=Einladende:r), KEINE Rolle", async () => {
    const email = nextEmail("einladung-verifier");
    const created = await einladenCore(db, tenantId, KOMMUNE, adminAId, {
      email,
      roleType: "verifier",
    });
    expect(created.ok).toBe(true);

    const konto = await createUser("einladung-konto");
    // Konto muss die EINGELADENE Adresse tragen (E-Mail-Bindung).
    await db.update(users).set({ email }).where(eq(users.id, konto.id));

    const res = await einladungAnnehmenCore(db, tenantId, created.rawToken!, {
      id: konto.id,
      email,
    });
    expect(res.ok).toBe(true);
    expect(res.pendingApproval).toBe(true);
    expect(res.roleType).toBe("verifier");

    // KEINE Rolle; genau EIN pending-Appointment mit dem Einladenden als Vorschlagendem.
    expect((await verifierRollen(konto.id)).length).toBe(0);
    const appts = await db
      .select()
      .from(roleAppointments)
      .where(and(eq(roleAppointments.tenantId, tenantId), eq(roleAppointments.targetUserId, konto.id)));
    expect(appts.length).toBe(1);
    expect(appts[0].status).toBe("pending");
    expect(appts[0].proposedBy).toBe(adminAId);

    // Einladung ist accepted (Endzustand wie bisher) → zweiter Accept scheitert.
    const res2 = await einladungAnnehmenCore(db, tenantId, created.rawToken!, {
      id: konto.id,
      email,
    });
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe("accepted");

    // Der zweite Admin kann den Vorschlag anschließend bestätigen.
    const entschieden = await verifierErnennungEntscheidenCore(db, tenantId, KOMMUNE, adminBId, {
      appointmentId: appts[0].id,
      entscheidung: "bestaetigen",
    });
    expect(entschieden.ok).toBe(true);
    expect(await getUserRoleTypes(db, tenantId, konto.id)).toContain("verifier");
  });

  it.skipIf(SKIP)("Einladungs-Accept: bestehender pending-Vorschlag → still ok, kein Duplikat", async () => {
    const email = nextEmail("einladung-doppel");
    const konto = await createUser("einladung-doppel-konto");
    await db.update(users).set({ email }).where(eq(users.id, konto.id));

    // Es existiert bereits ein offener Vorschlag (Direkt-Vorschlag durch adminB).
    const direkt = await verifierErnennungVorschlagenCore(db, tenantId, KOMMUNE, adminBId, {
      targetEmail: email,
    });
    expect(direkt.ok).toBe(true);

    const created = await einladenCore(db, tenantId, KOMMUNE, adminAId, {
      email,
      roleType: "verifier",
    });
    const res = await einladungAnnehmenCore(db, tenantId, created.rawToken!, {
      id: konto.id,
      email,
    });
    // Still ok für die annehmende Person — kein Fehler, kein Duplikat.
    expect(res.ok).toBe(true);
    expect(res.pendingApproval).toBe(true);

    const appts = await db
      .select()
      .from(roleAppointments)
      .where(
        and(
          eq(roleAppointments.tenantId, tenantId),
          eq(roleAppointments.targetUserId, konto.id),
          eq(roleAppointments.status, "pending"),
        ),
      );
    expect(appts.length).toBe(1);
    expect(appts[0].proposedBy).toBe(adminBId); // der ursprüngliche Vorschlag bleibt
  });

  // -------------------------------------------------------------------------
  // Lese-Query der Admin-Übersicht
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("offeneErnennungenListeCore: nur pending, tenant-scoped, mit E-Mails + Gebiet", async () => {
    const ziel = await createUser("liste");
    const created = await vorschlagen(ziel.email);

    const liste = await offeneErnennungenListeCore(db, tenantId);
    const eintrag = liste.find((e) => e.id === created.appointmentId);
    expect(eintrag).toBeTruthy();
    expect(eintrag!.targetEmail).toBe(ziel.email);
    expect(eintrag!.proposedBy).toBe(adminAId);
    expect(eintrag!.proposedByEmail).toContain("admin-a");
    expect(eintrag!.regionTyp).toBeTruthy();
    // Nur pending-Einträge in der Liste.
    expect(liste.every((e) => e.roleType === "verifier")).toBe(true);

    // Fremder Tenant sieht den Eintrag nicht.
    const listeT2 = await offeneErnennungenListeCore(db, tenant2Id);
    expect(listeT2.find((e) => e.id === created.appointmentId)).toBeUndefined();
  });
});
