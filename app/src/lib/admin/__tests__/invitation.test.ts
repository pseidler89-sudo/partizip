/**
 * invitation.test.ts — DB-Integrationstest Einladungs-Flow (Gate B).
 *
 * Ruft die ECHTEN Kern-Funktionen aus invitation-core.ts direkt gegen ein
 * ephemeres PG16 auf (keine Logik-Spiegelung; Auth/Tenant als Parameter, exakt
 * wie in den "use server"-Actions).
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt):
 *   - Autorisierung: kommune_admin kann redakteur/verifier/beobachter einladen,
 *     NICHT super_admin (Eskalationsgrenze); Nicht-Admin (beobachter/user) kann
 *     NICHT einladen; Tenant-Isolation (kein Einladen/Zurückziehen fremd).
 *   - Token: GET-Prüfung (getInvitationStatus) verbraucht NICHT; Accept genau
 *     einmal (zweiter Accept → 'accepted', keine zweite Rollenvergabe);
 *     abgelaufene/zurückgezogene Einladung nicht annehmbar; fremder/falscher
 *     Token → generischer Fehler.
 *   - E-Mail-Bindung: Annahme durch andere Adresse als eingeladen → abgelehnt,
 *     KEINE Rollenvergabe, Einladung bleibt pending (Rollback der Flanke).
 *   - Rolle nach Accept korrekt mit Scope zugewiesen; Grenzprüfung zum Accept-
 *     Zeitpunkt greift (Einladender inzwischen herabgestuft → nicht annehmbar).
 *   - Idempotenz: erneutes Einladen derselben (tenant,email) rotiert statt zu
 *     duplizieren (partieller UNIQUE-Index).
 *   - Audit-Events PII-frei (kein E-Mail-String in metadata/targetId).
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
import { sha256Hex } from "@/lib/auth/crypto";
import { getUserRoleTypes } from "@/lib/auth/roles";
import {
  einladenCore,
  einladungZurueckziehenCore,
  einladungErneutSendenCore,
  einladungAnnehmenCore,
  getInvitationStatus,
  einladungenListeCore,
} from "@/lib/admin/invitation-core";
import type { Db } from "@/db/client";

const { tenants, users, roles, invitations, auditEvents } = schema;

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

describe("Einladungs-Flow (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let tenant2Id: string;
  let inviterId: string; // kommune_admin im Tenant 1

  let counter = 0;
  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@einladung-test.de`;
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
      .values({ slug: `einl-${Date.now()}`, name: "Einladung-Test-Tenant" })
      .returning();
    tenantId = t1.id;

    const [t2] = await db
      .insert(tenants)
      .values({ slug: `einl-t2-${Date.now()}`, name: "Einladung-Test-Tenant-2" })
      .returning();
    tenant2Id = t2.id;

    // Einladender: kommune_admin im Tenant 1.
    const [inv] = await db
      .insert(users)
      .values({ tenantId, email: nextEmail("inviter") })
      .returning();
    inviterId = inv.id;
    await db.insert(roles).values({
      tenantId,
      userId: inviterId,
      roleType: "kommune_admin",
      scopeLevel: "stadt",
    });
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  /** Legt ein Konto (Stufe-1-fähig) an und gibt {id, email} zurück. */
  async function createUser(email: string, tId: string = tenantId) {
    const [u] = await db
      .insert(users)
      .values({ tenantId: tId, email, minAgeConfirmedAt: new Date() })
      .returning();
    return { id: u.id, email };
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Autorisierung beim Einladen
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("kommune_admin kann redakteur/verifier/beobachter einladen", async () => {
    for (const rt of ["redakteur", "verifier", "beobachter"]) {
      const res = await einladenCore(db, tenantId, KOMMUNE, inviterId, {
        email: nextEmail(`ok-${rt}`),
        roleType: rt,
      });
      expect(res.ok).toBe(true);
      expect(res.rawToken).toBeTruthy();
      expect(res.resent).toBe(false);
    }
  });

  it.skipIf(SKIP)("kommune_admin kann NICHT super_admin einladen (Eskalationsgrenze)", async () => {
    const res = await einladenCore(db, tenantId, KOMMUNE, inviterId, {
      email: nextEmail("no-super"),
      roleType: "super_admin",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Keine Berechtigung/i);
  });

  it.skipIf(SKIP)("kommune_admin kann NICHT Reserve-Rolle einladen", async () => {
    const res = await einladenCore(db, tenantId, KOMMUNE, inviterId, {
      email: nextEmail("no-reserve"),
      roleType: "kreis_admin",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Keine Berechtigung/i);
  });

  it.skipIf(SKIP)("kommune_admin kann eine pending super_admin-Einladung NICHT überschreiben", async () => {
    const email = nextEmail("no-override");
    // super_admin lädt zu super_admin ein.
    const created = await einladenCore(db, tenantId, SUPER, inviterId, {
      email,
      roleType: "super_admin",
    });
    expect(created.ok).toBe(true);
    const superToken = created.rawToken;
    // kommune_admin versucht, dieselbe (tenant,email)-Einladung neu zu vergeben.
    const res = await einladenCore(db, tenantId, KOMMUNE, inviterId, {
      email,
      roleType: "redakteur",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Keine Berechtigung/i);
    // Der super_admin-Token bleibt gültig (nicht rotiert/entwertet).
    const status = await getInvitationStatus(db, tenantId, superToken!);
    expect(status.status).toBe("valid");
    expect(status.roleType).toBe("super_admin");
  });

  it.skipIf(SKIP)("beobachter/user können NICHT einladen", async () => {
    for (const roles_ of [["beobachter"], ["user"], []]) {
      const res = await einladenCore(db, tenantId, roles_, inviterId, {
        email: nextEmail("no-invite"),
        roleType: "redakteur",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Admin erforderlich/i);
    }
  });

  it.skipIf(SKIP)("Tenant-Isolation: Zurückziehen einer fremden Einladung schlägt fehl", async () => {
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, {
      email: nextEmail("iso"),
      roleType: "redakteur",
    });
    expect(created.ok).toBe(true);
    // Aus Tenant 2 heraus versuchen (super_admin-Rolle, aber falscher Tenant).
    const res = await einladungZurueckziehenCore(
      db,
      tenant2Id,
      SUPER,
      inviterId,
      created.invitationId!,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nicht gefunden/i);
  });

  // -------------------------------------------------------------------------
  // Idempotenz / Re-Send
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("erneutes Einladen derselben (tenant,email) rotiert statt zu duplizieren", async () => {
    const email = nextEmail("dupe");
    const r1 = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email, roleType: "redakteur" });
    expect(r1.resent).toBe(false);

    const r2 = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email, roleType: "verifier" });
    expect(r2.ok).toBe(true);
    expect(r2.resent).toBe(true);
    expect(r2.rawToken).not.toBe(r1.rawToken);

    // Genau EINE Zeile für (tenant,email).
    const rows = await db
      .select({ id: invitations.id, roleType: invitations.roleType })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.email, email)));
    expect(rows.length).toBe(1);
    expect(rows[0].roleType).toBe("verifier"); // aktualisiert
  });

  // -------------------------------------------------------------------------
  // GET-Prüfung verbraucht NICHT
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("getInvitationStatus verbraucht den Token NICHT (Scanner-Härtung)", async () => {
    const email = nextEmail("get-safe");
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email, roleType: "redakteur" });
    const token = created.rawToken!;

    for (let i = 0; i < 3; i++) {
      const c = await getInvitationStatus(db, tenantId, token);
      expect(c.status).toBe("valid");
      expect(c.roleType).toBe("redakteur");
    }
    // Immer noch pending in der DB.
    const [row] = await db
      .select({ status: invitations.status })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.tokenHash, sha256Hex(token))));
    expect(row.status).toBe("pending");
  });

  it.skipIf(SKIP)("fremder/falscher Token → generischer 'unknown'-Status", async () => {
    const c = await getInvitationStatus(db, tenantId, "voellig-erfundener-token");
    expect(c.status).toBe("unknown");
    expect(c.roleType).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Annahme: genau einmal, Rolle + Scope korrekt, Audit PII-frei
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("Accept genau einmal → Rolle mit Scope vergeben; zweiter Accept → 'accepted', keine zweite Vergabe", async () => {
    const email = nextEmail("accept");
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, {
      email,
      roleType: "redakteur",
      scopeLevel: "ortsteil",
      scopeCode: "OT-7",
    });
    const token = created.rawToken!;
    const account = await createUser(email);

    const a1 = await einladungAnnehmenCore(db, tenantId, token, account);
    expect(a1.ok).toBe(true);
    expect(a1.roleType).toBe("redakteur");

    // Rolle mit korrektem Scope zugewiesen.
    const roleRows = await db
      .select({ roleType: roles.roleType, scopeLevel: roles.scopeLevel, scopeCode: roles.scopeCode })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, account.id), eq(roles.roleType, "redakteur")));
    expect(roleRows.length).toBe(1);
    expect(roleRows[0].scopeLevel).toBe("ortsteil");
    expect(roleRows[0].scopeCode).toBe("OT-7");

    // Zweiter Accept → schon angenommen, KEINE zweite Rollenzeile.
    const a2 = await einladungAnnehmenCore(db, tenantId, token, account);
    expect(a2.ok).toBe(false);
    expect(a2.reason).toBe("accepted");
    const roleRows2 = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, account.id), eq(roles.roleType, "redakteur")));
    expect(roleRows2.length).toBe(1);

    // Audit invitation.accepted + role.granted, beide PII-frei.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, "invitation.accepted")));
    const mine = audit.find((a: { actorRef: string | null }) => a.actorRef === account.id);
    expect(mine).toBeTruthy();
    expect(JSON.stringify(mine!.metadata)).not.toContain("@");
    expect(mine!.targetId).not.toContain("@");
  });

  // -------------------------------------------------------------------------
  // E-Mail-Bindung
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("Annahme durch ANDERE Adresse als eingeladen → abgelehnt, keine Vergabe, bleibt pending", async () => {
    const invitedEmail = nextEmail("bound");
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email: invitedEmail, roleType: "redakteur" });
    const token = created.rawToken!;

    const fremd = await createUser(nextEmail("fremd-accept"));
    const res = await einladungAnnehmenCore(db, tenantId, token, fremd);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("email_mismatch");

    // Keine Rolle für das fremde Konto.
    const rts = await getUserRoleTypes(db, tenantId, fremd.id);
    expect(rts).not.toContain("redakteur");

    // Einladung ist NICHT verbraucht (Rollback der Flanke) — bleibt pending.
    const [row] = await db
      .select({ status: invitations.status })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.tokenHash, sha256Hex(token))));
    expect(row.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Zurückgezogen / fremder Token nicht annehmbar
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("zurückgezogene Einladung ist nicht annehmbar", async () => {
    const email = nextEmail("revoked");
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email, roleType: "redakteur" });
    const token = created.rawToken!;

    const rev = await einladungZurueckziehenCore(db, tenantId, KOMMUNE, inviterId, created.invitationId!);
    expect(rev.ok).toBe(true);

    // GET zeigt revoked.
    expect((await getInvitationStatus(db, tenantId, token)).status).toBe("revoked");

    const account = await createUser(email);
    const res = await einladungAnnehmenCore(db, tenantId, token, account);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("revoked");
    expect(await getUserRoleTypes(db, tenantId, account.id)).not.toContain("redakteur");
  });

  it.skipIf(SKIP)("fremder Token beim Annehmen → generischer 'unknown'-Fehler", async () => {
    const account = await createUser(nextEmail("unknown-accept"));
    const res = await einladungAnnehmenCore(db, tenantId, "kein-echter-token", account);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unknown");
  });

  it.skipIf(SKIP)("abgelaufene Einladung ist nicht annehmbar", async () => {
    const email = nextEmail("expired");
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email, roleType: "redakteur" });
    const token = created.rawToken!;
    // Ablauf in die Vergangenheit setzen.
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, created.invitationId!)));

    expect((await getInvitationStatus(db, tenantId, token)).status).toBe("expired");

    const account = await createUser(email);
    const res = await einladungAnnehmenCore(db, tenantId, token, account);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
    expect(await getUserRoleTypes(db, tenantId, account.id)).not.toContain("redakteur");
  });

  // -------------------------------------------------------------------------
  // Grenzprüfung zum ACCEPT-Zeitpunkt
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("Einladender inzwischen herabgestuft → Einladung nicht mehr annehmbar", async () => {
    // Eigener Einladender, den wir danach herabstufen.
    const demoteEmail = nextEmail("demote-inviter");
    const demoteInviter = await createUser(demoteEmail);
    const [demoteRole] = await db
      .insert(roles)
      .values({ tenantId, userId: demoteInviter.id, roleType: "kommune_admin", scopeLevel: "stadt" })
      .returning();

    const targetEmail = nextEmail("demote-target");
    const created = await einladenCore(db, tenantId, KOMMUNE, demoteInviter.id, {
      email: targetEmail,
      roleType: "redakteur",
    });
    const token = created.rawToken!;

    // Einladenden herabstufen: Admin-Rolle entfernen.
    await db.delete(roles).where(eq(roles.id, demoteRole.id));

    const account = await createUser(targetEmail);
    const res = await einladungAnnehmenCore(db, tenantId, token, account);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid");
    expect(await getUserRoleTypes(db, tenantId, account.id)).not.toContain("redakteur");

    // Einladung bleibt pending (Rollback).
    const [row] = await db
      .select({ status: invitations.status })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.tokenHash, sha256Hex(token))));
    expect(row.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Audit PII-frei beim Einladen
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("invitation.created-Audit ist PII-frei (keine E-Mail in metadata)", async () => {
    const email = nextEmail("audit");
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email, roleType: "redakteur" });
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.action, "invitation.created"),
          eq(auditEvents.targetId, created.invitationId!),
        ),
      );
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(inviterId);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
    expect(JSON.stringify(audit[0].metadata)).not.toContain(email);
  });

  // -------------------------------------------------------------------------
  // Erneut senden (per id) rotiert Token
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("einladungErneutSenden rotiert den Token und erhöht resendCount", async () => {
    const email = nextEmail("resend");
    const created = await einladenCore(db, tenantId, KOMMUNE, inviterId, { email, roleType: "redakteur" });
    const oldToken = created.rawToken!;

    const res = await einladungErneutSendenCore(db, tenantId, KOMMUNE, inviterId, created.invitationId!);
    expect(res.ok).toBe(true);
    expect(res.rawToken).not.toBe(oldToken);
    expect(res.email).toBe(email);

    // Alter Token ungültig (unknown), neuer Token gültig.
    expect((await getInvitationStatus(db, tenantId, oldToken)).status).toBe("unknown");
    expect((await getInvitationStatus(db, tenantId, res.rawToken!)).status).toBe("valid");

    const [row] = await db
      .select({ resendCount: invitations.resendCount })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, created.invitationId!)));
    expect(row.resendCount).toBe(1);
  });

  it.skipIf(SKIP)("einladungenListeCore gibt niemals token_hash zurück", async () => {
    const liste = await einladungenListeCore(db, tenantId);
    expect(liste.length).toBeGreaterThan(0);
    expect(Object.keys(liste[0])).not.toContain("tokenHash");
    expect(Object.keys(liste[0])).not.toContain("token_hash");
  });
});
