/**
 * invitation-core.ts — Einladungs-Flow für Rollen (Gate B). Reine DB-Logik.
 *
 * Löst die grant-role-CLI im Regelbetrieb ab: Kommunen laden Mitwirkende per
 * E-Mail ein; angenommen wird über die bestehende Magic-Link-Infrastruktur.
 *
 * BEWUSST OHNE "use server" und ohne Request-Kontext (Cookies/Headers): alle
 * Funktionen nehmen db/tenantId/Caller als PARAMETER — damit sind sie
 *   1. von den "use server"-Actions wiederverwendbar (die nur Auth/Tenant
 *      auflösen und dann hierher delegieren), und
 *   2. in DB-Integrationstests als ECHTE Funktionen aufrufbar (keine Spiegelung
 *      der Logik im Test).
 *
 * SICHERHEITS-INVARIANTEN (Vertrauensprodukt):
 *   - Eskalationsgrenze über die reine Funktion `canManageRole` (roles.ts) —
 *     EXAKT wie assignRole: kommune_admin darf NIE super_admin/Reserve einladen.
 *     Sie wird beim EINLADEN und ERNEUT beim ANNEHMEN geprüft (s. u.).
 *   - Roh-Token (CSPRNG) verlässt nie den Server; in der DB steht nur der Hash.
 *   - Tenant-Isolation in JEDER Query (tenant_id immer im WHERE).
 *   - Annahme ATOMAR: bedingter UPDATE pending→accepted (WHERE ... RETURNING,
 *     kein TOCTOU) + Rollenvergabe in EINER Transaktion.
 *   - E-Mail-Bindung: angenommen werden kann NUR mit einem Konto, dessen E-Mail
 *     der eingeladenen Adresse entspricht (kein Weiterreichen des Links).
 *   - Audit PII-frei: actorRef = Caller-/Akteur-UUID; metadata NIE mit E-Mail.
 *
 * ENTSCHEIDUNG — Eskalationsgrenze zum ANNAHME-Zeitpunkt (nicht eingefroren):
 *   Beim Annehmen wird die Grenze ERNEUT gegen die AKTUELLEN Rollen des
 *   Einladenden geprüft (getUserRoleTypes filtert gesperrte/gelöschte Konten →
 *   []). Wurde der Einladende inzwischen herabgestuft/gesperrt/gelöscht, ist die
 *   Einladung nicht mehr annehmbar ("nicht mehr gültig"). Das ist die
 *   konservative Wahl: eine pending-Einladung verleiht nie mehr Rechte, als der
 *   Einladende IM MOMENT DER ANNAHME selbst vergeben dürfte — konsistent mit dem
 *   Prinzip, dass ein gesperrtes Admin-Konto sofort alle Rechte verliert.
 */

import { and, eq, desc, gt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { invitations, roles, users, auditEvents, regions } from "@/db/schema";
import {
  canManageRole,
  isAdmin,
  getUserRoleTypes,
  type RoleType,
} from "@/lib/auth/roles";
import { generateRawToken, sha256Hex } from "@/lib/auth/crypto";
import { resolveRegionIdForScope } from "@/lib/region/scope";

type ScopeLevel = "ortsteil" | "stadt" | "kreis" | "land";
const VALID_SCOPE_LEVELS: readonly string[] = ["ortsteil", "stadt", "kreis", "land"];

/** Gültigkeitsdauer einer Einladung (Standard 14 Tage). Konfigurierbar via env. */
export const INVITATION_TTL_DAYS = Number(process.env.INVITATION_TTL_DAYS ?? "14");

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function expiresInDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export interface EinladenInput {
  email: string;
  roleType: string;
  scopeLevel?: ScopeLevel;
  scopeCode?: string | null;
}

export interface EinladenResult {
  ok: boolean;
  invitationId?: string;
  /** RAW-Token — GENAU EINMAL zurückgegeben (für die Einladungs-URL/Mail). */
  rawToken?: string;
  /** Empfänger-Adresse (server-intern, für den Mailversand der Action). */
  email?: string;
  /** true ⇒ es gab bereits eine offene Einladung → Token wurde rotiert. */
  resent?: boolean;
  roleType?: string;
  expiresAt?: Date;
  error?: string;
}

// ---------------------------------------------------------------------------
// einladen — Einladung erstellen ODER (bei bereits offener) neu versenden.
// ---------------------------------------------------------------------------

/**
 * Erstellt eine Rollen-Einladung (tenant-scoped, auditiert, eskalationsgeschützt).
 *
 * Idempotenz: Existiert bereits eine PENDING-Einladung für (tenant, email), wird
 * KEINE Dublette angelegt — stattdessen wird der Token rotiert, Rolle/Scope
 * aktualisiert und die Einladung erneut versendet (resend_count++). Das
 * entspricht dem partiellen UNIQUE-Index (höchstens eine offene je (tenant,email)).
 *
 * @param callerRoleTypes  Rollen des einladenden Admins (Eskalationsgrenze).
 * @param callerUserId     UserId des Einladenden (Audit-actorRef + invited_by).
 */
export async function einladenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  input: EinladenInput,
): Promise<EinladenResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  const roleType = input.roleType;
  const scopeLevel: ScopeLevel = input.scopeLevel ?? "stadt";
  const scopeCode = input.scopeCode ?? null;
  const email = normalizeEmail(input.email);

  // ESKALATIONSGRENZE — serverseitig hart, exakt wie assignRole. UI ist Komfort.
  if (!canManageRole(callerRoleTypes, roleType)) {
    return { ok: false, error: "Keine Berechtigung, diese Rolle zu vergeben." };
  }
  if (!email || !email.includes("@")) {
    return { ok: false, error: "Bitte eine gültige E-Mail-Adresse angeben." };
  }
  if (!VALID_SCOPE_LEVELS.includes(scopeLevel)) {
    return { ok: false, error: "Ungültige Ebene (scope_level)." };
  }

  // ADR-024 contract: die Einladung ist eine aufgeschobene Rolle und trägt den
  // Gebietsknoten (region_id) statt scope_level/scope_code. Die Scope-Eingabe wird
  // schon beim Einladen via Baum aufgelöst; beim Annehmen wird sie 1:1 auf die
  // Rolle übernommen. Kein Gebiet hinterlegt → freundlicher Fehler.
  let regionId: string;
  try {
    regionId = await resolveRegionIdForScope(db, tenantId, scopeLevel, scopeCode);
  } catch {
    return { ok: false, error: "Für die gewählte Ebene ist noch kein Gebiet hinterlegt." };
  }

  const rawToken = generateRawToken();
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = expiresInDays(INVITATION_TTL_DAYS);

  return db.transaction(async (tx: Db) => {
    // Bereits offene Einladung für (tenant, email)? → rotieren statt duplizieren.
    const existingRows = await tx
      .select({
        id: invitations.id,
        resendCount: invitations.resendCount,
        roleType: invitations.roleType,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.email, email),
          eq(invitations.status, "pending"),
        ),
      )
      .limit(1);
    const existing = existingRows[0];

    if (existing) {
      // Symmetrisch zu Zurückziehen/Erneut-Senden: Wer die BESTEHENDE Rolle der
      // offenen Einladung nicht verwalten darf, darf sie auch nicht durch eine
      // Neu-Einladung überschreiben — sonst könnte ein niedriger privilegierter
      // Admin die pending-Einladung eines höheren still umwidmen oder entwerten.
      if (!canManageRole(callerRoleTypes, existing.roleType as RoleType)) {
        return { ok: false as const, error: "Keine Berechtigung für diese Einladung." };
      }
      await tx
        .update(invitations)
        .set({
          roleType: roleType as RoleType,
          regionId,
          tokenHash,
          expiresAt,
          resentBy: callerUserId,
          resendCount: existing.resendCount + 1,
        })
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, existing.id)));

      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "admin",
        actorRef: callerUserId,
        action: "invitation.resent",
        targetType: "invitation",
        targetId: existing.id,
        metadata: { roleType, scopeLevel },
      });

      return {
        ok: true as const,
        invitationId: existing.id,
        rawToken,
        email,
        resent: true,
        roleType,
        expiresAt,
      };
    }

    const [row] = await tx
      .insert(invitations)
      .values({
        tenantId,
        email,
        roleType: roleType as RoleType,
        regionId,
        tokenHash,
        invitedBy: callerUserId,
        expiresAt,
      })
      .returning({ id: invitations.id });

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "invitation.created",
      targetType: "invitation",
      targetId: row.id,
      // PII-frei: NIE die E-Mail, nur Rolle + Scope.
      metadata: { roleType, scopeLevel },
    });

    return {
      ok: true as const,
      invitationId: row.id,
      rawToken,
      email,
      resent: false,
      roleType,
      expiresAt,
    };
  });
}

// ---------------------------------------------------------------------------
// einladungZurueckziehen — offene Einladung widerrufen.
// ---------------------------------------------------------------------------

export async function einladungZurueckziehenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  invitationId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  return db.transaction(async (tx: Db) => {
    const rows = await tx
      .select({ id: invitations.id, roleType: invitations.roleType, status: invitations.status })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, invitationId)))
      .limit(1);
    const inv = rows[0];
    if (!inv) return { ok: false as const, error: "Einladung nicht gefunden." };

    // Eskalationsgrenze: nur wer die Ziel-Rolle vergeben darf, darf die
    // Einladung auch zurückziehen.
    if (!canManageRole(callerRoleTypes, inv.roleType)) {
      return { ok: false as const, error: "Keine Berechtigung für diese Einladung." };
    }

    // Atomar: nur eine noch OFFENE Einladung lässt sich zurückziehen.
    const updated = await tx
      .update(invitations)
      .set({ status: "revoked", revokedBy: callerUserId })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.id, invitationId),
          eq(invitations.status, "pending"),
        ),
      )
      .returning({ id: invitations.id });

    if (updated.length === 0) {
      return { ok: false as const, error: "Diese Einladung ist nicht mehr offen." };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "invitation.revoked",
      targetType: "invitation",
      targetId: invitationId,
      metadata: { roleType: inv.roleType },
    });

    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// einladungErneutSenden — neuen Token für eine offene Einladung erzeugen.
// ---------------------------------------------------------------------------

export interface ErneutSendenResult {
  ok: boolean;
  rawToken?: string;
  email?: string;
  roleType?: string;
  expiresAt?: Date;
  error?: string;
}

export async function einladungErneutSendenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  invitationId: string,
): Promise<ErneutSendenResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  const rawToken = generateRawToken();
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = expiresInDays(INVITATION_TTL_DAYS);

  return db.transaction(async (tx: Db) => {
    const rows = await tx
      .select({
        id: invitations.id,
        email: invitations.email,
        roleType: invitations.roleType,
        status: invitations.status,
        resendCount: invitations.resendCount,
      })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, invitationId)))
      .limit(1);
    const inv = rows[0];
    if (!inv) return { ok: false as const, error: "Einladung nicht gefunden." };

    if (!canManageRole(callerRoleTypes, inv.roleType)) {
      return { ok: false as const, error: "Keine Berechtigung für diese Einladung." };
    }

    // Nur eine noch OFFENE Einladung lässt sich erneut senden (atomar).
    const updated = await tx
      .update(invitations)
      .set({
        tokenHash,
        expiresAt,
        resentBy: callerUserId,
        resendCount: inv.resendCount + 1,
      })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.id, invitationId),
          eq(invitations.status, "pending"),
        ),
      )
      .returning({ id: invitations.id });

    if (updated.length === 0) {
      return { ok: false as const, error: "Diese Einladung ist nicht mehr offen." };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "invitation.resent",
      targetType: "invitation",
      targetId: invitationId,
      metadata: { roleType: inv.roleType },
    });

    return {
      ok: true as const,
      rawToken,
      email: inv.email,
      roleType: inv.roleType,
      expiresAt,
    };
  });
}

// ---------------------------------------------------------------------------
// getInvitationStatus — nebenwirkungsfreie Statusprüfung (GET-Härtung).
//
// GARANTIE: reiner Lesezugriff. Kein UPDATE, kein Audit — beliebig viele Aufrufe
// (Scanner, Prefetch, Reload) verändern den Zustand NICHT. Der Token wird erst
// durch die bewusste Annahme (POST/Server-Action) konsumiert.
// ---------------------------------------------------------------------------

export type InvitationStatus = "valid" | "accepted" | "revoked" | "expired" | "unknown";

export interface InvitationCheck {
  status: InvitationStatus;
  /** Nur bei status='valid' gesetzt (für Anzeige/Bindungsprüfung der Seite). */
  roleType?: string;
  email?: string;
}

export async function getInvitationStatus(
  db: Db,
  tenantId: string,
  rawToken: string,
): Promise<InvitationCheck> {
  const tokenHash = sha256Hex(rawToken);
  const rows = await db
    .select({
      status: invitations.status,
      roleType: invitations.roleType,
      email: invitations.email,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(and(eq(invitations.tenantId, tenantId), eq(invitations.tokenHash, tokenHash)))
    .limit(1);
  const inv = rows[0];
  if (!inv) return { status: "unknown" };
  if (inv.status === "accepted") return { status: "accepted" };
  if (inv.status === "revoked") return { status: "revoked" };
  if (inv.status === "expired" || inv.expiresAt <= new Date()) return { status: "expired" };
  return {
    status: "valid",
    roleType: inv.roleType,
    email: inv.email,
  };
}

// ---------------------------------------------------------------------------
// einladungAnnehmen — ATOMARE Annahme + Rollenvergabe.
// ---------------------------------------------------------------------------

export type AnnehmenReason =
  | "accepted"
  | "revoked"
  | "expired"
  | "unknown"
  | "email_mismatch"
  | "account_inactive"
  | "invalid";

export interface AnnehmenResult {
  ok: boolean;
  roleType?: string;
  reason?: AnnehmenReason;
  error?: string;
}

/** Interne Marker-Fehler für den atomaren Rollback (Rollback der pending→accepted-Flanke). */
class AcceptRollback extends Error {
  constructor(public reason: AnnehmenReason) {
    super(`invitation-accept-rollback:${reason}`);
    this.name = "AcceptRollback";
  }
}

/**
 * Nimmt eine Einladung an — ATOMAR und race-frei (kein TOCTOU):
 *
 *   1. Bedingter UPDATE status pending→accepted
 *      WHERE tenant_id AND token_hash AND status='pending' AND expires_at > now()
 *      RETURNING — gewinnt genau EINER; ein zweiter Aufruf trifft kein pending.
 *   2. E-Mail-BINDUNG: die eingeladene E-Mail MUSS der E-Mail des annehmenden
 *      (bereits per Magic-Link authentifizierten) Kontos entsprechen. Sonst
 *      Rollback der Flanke → reason 'email_mismatch'. Damit kann ein
 *      weitergereichter Link KEINER anderen Adresse die Rolle verschaffen.
 *   2b. KONTO-STATUS: das annehmende Konto muss aktiv sein. Gesperrt/gelöscht →
 *      Rollback → reason 'account_inactive' (Einladung bleibt pending).
 *      Härtung, damit ein nicht-aktives Konto gar keine Rollenzeile erhält.
 *   3. Eskalationsgrenze zum ANNAHME-Zeitpunkt: die AKTUELLEN Rollen des
 *      Einladenden werden geladen (getUserRoleTypes → gesperrte/gelöschte Konten
 *      = []); nur wenn er die Rolle JETZT noch vergeben dürfte (isAdmin +
 *      canManageRole), wird sie zugewiesen. Sonst Rollback → 'invalid'.
 *   4. Rollenvergabe an das authentifizierte Konto (onConflictDoNothing →
 *      idempotent) + Audit role.granted (actorRef=Einladender) + Audit
 *      invitation.accepted (actorRef=annehmendes Konto). Alles in EINER
 *      Transaktion; scheitert ein Schritt, rollt die accepted-Flanke zurück.
 *
 * @param accepter  Das per Magic-Link angemeldete Konto {id, email}.
 */
export async function einladungAnnehmenCore(
  db: Db,
  tenantId: string,
  rawToken: string,
  accepter: { id: string; email: string },
): Promise<AnnehmenResult> {
  const tokenHash = sha256Hex(rawToken);
  const accepterEmail = normalizeEmail(accepter.email);

  try {
    return await db.transaction(async (tx: Db) => {
      // 1. Atomare Flanke pending→accepted (DB-Uhr, race-frei).
      const flipped = await tx
        .update(invitations)
        .set({ status: "accepted", acceptedBy: accepter.id })
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.tokenHash, tokenHash),
            eq(invitations.status, "pending"),
            gt(invitations.expiresAt, sql`now()`),
          ),
        )
        .returning({
          id: invitations.id,
          email: invitations.email,
          roleType: invitations.roleType,
          regionId: invitations.regionId,
          invitedBy: invitations.invitedBy,
        });
      const inv = flipped[0];

      if (!inv) {
        // Nichts geflippt → diagnostizieren (read-only) für eine passende Meldung.
        const diag = await tx
          .select({ status: invitations.status, expiresAt: invitations.expiresAt })
          .from(invitations)
          .where(and(eq(invitations.tenantId, tenantId), eq(invitations.tokenHash, tokenHash)))
          .limit(1);
        const d = diag[0];
        if (!d) throw new AcceptRollback("unknown");
        if (d.status === "accepted") throw new AcceptRollback("accepted");
        if (d.status === "revoked") throw new AcceptRollback("revoked");
        throw new AcceptRollback("expired");
      }

      // 2. E-Mail-Bindung.
      if (normalizeEmail(inv.email) !== accepterEmail) {
        throw new AcceptRollback("email_mismatch");
      }

      // 2b. Das ANNEHMENDE Konto muss aktiv sein. Ein gesperrtes/gelöschtes Konto
      // (accountStatus != 'active') kann eine Einladung nicht annehmen — sonst
      // erhielte es eine (zwar über getUserRoleTypes inerte, aber vorhandene)
      // Rollenzeile. Härtung, kein neuer Vektor: Rollback der Flanke → Einladung
      // bleibt pending. Tenant-scoped, aus der DB (nie aus Client-Eingaben).
      const accepterRows = await tx
        .select({ accountStatus: users.accountStatus })
        .from(users)
        .where(and(eq(users.id, accepter.id), eq(users.tenantId, tenantId)))
        .limit(1);
      if (accepterRows[0]?.accountStatus !== "active") {
        throw new AcceptRollback("account_inactive");
      }

      // 3. Eskalationsgrenze zum Annahme-Zeitpunkt (aktuelle Rollen des Einladenden).
      if (!inv.invitedBy) throw new AcceptRollback("invalid");
      const inviterRoles = await getUserRoleTypes(tx, tenantId, inv.invitedBy);
      if (!isAdmin(inviterRoles) || !canManageRole(inviterRoles, inv.roleType)) {
        throw new AcceptRollback("invalid");
      }

      // 4. Rolle an das authentifizierte Konto vergeben (idempotent) + Audit.
      // ADR-024 contract: der Gebietsknoten der Einladung (schon beim Einladen via
      // Baum aufgelöst) wird 1:1 auf die Rolle übernommen.
      const inserted = await tx
        .insert(roles)
        .values({
          tenantId,
          userId: accepter.id,
          roleType: inv.roleType as RoleType,
          regionId: inv.regionId,
        })
        .onConflictDoNothing()
        .returning({ id: roles.id });

      if (inserted.length > 0) {
        // role.granted mit dem Einladenden als actorRef (Lineage), PII-frei.
        await tx.insert(auditEvents).values({
          tenantId,
          actorType: "admin",
          actorRef: inv.invitedBy,
          action: "role.granted",
          targetType: "user",
          targetId: accepter.id,
          metadata: { roleType: inv.roleType, via: "invitation" },
        });
      }

      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "user",
        actorRef: accepter.id,
        action: "invitation.accepted",
        targetType: "invitation",
        targetId: inv.id,
        metadata: { roleType: inv.roleType },
      });

      return {
        ok: true as const,
        roleType: inv.roleType,
      };
    });
  } catch (err) {
    if (err instanceof AcceptRollback) {
      return { ok: false, reason: err.reason, error: reasonMessage(err.reason) };
    }
    throw err;
  }
}

function reasonMessage(reason: AnnehmenReason): string {
  switch (reason) {
    case "accepted":
      return "Diese Einladung wurde bereits angenommen.";
    case "revoked":
      return "Diese Einladung wurde zurückgezogen.";
    case "expired":
      return "Diese Einladung ist abgelaufen.";
    case "email_mismatch":
      return "Diese Einladung ist an eine andere E-Mail-Adresse gebunden.";
    case "account_inactive":
      return "Ihr Konto ist derzeit nicht aktiv. Bitte wenden Sie sich an Ihre Kommune.";
    case "invalid":
    case "unknown":
    default:
      return "Diese Einladung ist nicht mehr gültig.";
  }
}

// ---------------------------------------------------------------------------
// Lese-Query für die Admin-Übersicht (OHNE "use server"; kein token_hash!).
// ---------------------------------------------------------------------------

export interface EinladungRow {
  id: string;
  email: string;
  roleType: string;
  /** Gebietsart des Rollen-Knotens (regions.typ) — Ebenen-Label für die UI. */
  regionTyp: string;
  /** Name des Rollen-Knotens (z. B. Ortsteil-/Gemeinde-Name) für die Anzeige. */
  regionName: string;
  status: string;
  resendCount: number;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Listet Einladungen eines Tenants (neueste zuerst). Gibt NIEMALS den token_hash
 * zurück. E-Mail ist hier erlaubt (Admin-only, tenant-intern — wie die Rollen-
 * Verwaltung; NICHT zu verwechseln mit der PII-freien Audit-Ansicht).
 */
export async function einladungenListeCore(
  db: Db,
  tenantId: string,
): Promise<EinladungRow[]> {
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      roleType: invitations.roleType,
      regionTyp: regions.typ,
      regionName: regions.name,
      status: invitations.status,
      resendCount: invitations.resendCount,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(regions, eq(regions.id, invitations.regionId))
    .where(eq(invitations.tenantId, tenantId))
    .orderBy(desc(invitations.createdAt));
  return rows as EinladungRow[];
}
