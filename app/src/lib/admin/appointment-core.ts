/**
 * appointment-core.ts — Vier-Augen-Verifier-Ernennung (Block K3). Reine DB-Logik.
 *
 * Produktentscheid (bindend): Das Vier-Augen-Prinzip greift an der Verifier-
 * ERNENNUNG (nicht je Verifizierung). Die Rolle `verifier` wird zweistufig
 * vergeben: Vorschlag (pending) durch eine:n Admin → Bestätigung/Ablehnung
 * durch eine:n ZWEITE:N Admin. Mechanik analog Digest-Freigabe:
 * `isSelfApprovalAllowed()` (lib/digest/freigabe-core.ts, WIEDERVERWENDET,
 * nicht dupliziert) erlaubt im Ein-Personen-Pilot (ALLOW_SELF_APPROVAL=true)
 * die Selbst-Bestätigung — fehlend/anderes ⇒ fail-closed Vier-Augen-Pflicht.
 * Auch bei erlaubter Selbst-Bestätigung bleibt der Bestätigungs-KLICK eine
 * explizite, auditierte Handlung (kein Auto-Approve); überbrückte
 * Selbst-Bestätigung steht sichtbar im Audit (metadata.selfApproval = true).
 *
 * BEWUSST OHNE "use server" und ohne Request-Kontext (Muster role-actions/
 * invitation-core/konto-sicherheit-core): alle Funktionen nehmen db/tenantId/
 * Caller als PARAMETER — von den "use server"-Actions wiederverwendbar UND in
 * DB-Integrationstests als ECHTE Funktionen aufrufbar.
 *
 * SICHERHEITS-INVARIANTEN (Vertrauensprodukt):
 *   - Tenant-Isolation in JEDER Query (tenant_id immer im WHERE).
 *   - Eskalationsgrenze über canManageRole — exakt wie assignRole (die Rolle
 *     `verifier` ist für kommune_admin verwaltbar; geprüft wird generisch über
 *     den role_type des Vorschlags).
 *   - SoD ATOMAR (kein TOCTOU): Die Selbst-Bestätigungs-Sperre steht als
 *     Bedingung in der WHERE-Klausel DESSELBEN UPDATEs, das den Statusübergang
 *     pending→approved/rejected macht (Muster freigebenCore).
 *   - Doppel-Vorschläge race-fest über den partiellen UNIQUE-Index
 *     (role_appointments_pending_unique) — 23505 wird via istPgFehler
 *     (lib/db/pg-errors.ts) freundlich beantwortet.
 *   - KEIN JS-Date in Roh-sql — decided_at/proposed_at per DB-now().
 *   - Audit PII-frei: actorRef = Caller-UUID, targetId = Ziel-UserId,
 *     metadata enthält NIEMALS eine E-Mail (nur appointmentId/roleType/regionId).
 */

import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import { auditEvents, regions, roleAppointments, roles, users } from "@/db/schema";
import { canManageRole, isAdmin, type RoleType } from "@/lib/auth/roles";
import { istPgFehler, PG_UNIQUE_VIOLATION } from "@/lib/db/pg-errors";
import { resolveRegionIdForScope } from "@/lib/region/scope";

type ScopeLevel = "ortsteil" | "stadt" | "kreis" | "land";
const VALID_SCOPE_LEVELS: readonly string[] = ["ortsteil", "stadt", "kreis", "land"];

/** Vorerst durchläuft NUR `verifier` das Vier-Augen-Verfahren (Spalte generisch). */
const ERNENNUNGS_ROLLE: RoleType = "verifier";

export type ErnennungResult = {
  ok: boolean;
  error?: string;
  message?: string;
  appointmentId?: string;
};

const SOD_FEHLER =
  "Vier-Augen-Prinzip: Der Vorschlag muss durch eine zweite Administratorin " +
  "oder einen zweiten Administrator bestätigt werden.";

/** Gate-B MINOR: Die BEGÜNSTIGTE Person entscheidet nie über die eigene Ernennung. */
const SOD_ZIEL_FEHLER = "Sie können Ihre eigene Ernennung nicht bestätigen.";

const NICHT_GEFUNDEN = "Vorschlag nicht gefunden oder bereits entschieden.";

/** Erfolgs-Meldung des Vorschlags — erklärt den zweistufigen Weg (Vier-Augen). */
const VORSCHLAG_ANGELEGT =
  "Vorschlag angelegt: Die Ernennung zur Verifiziererin oder zum Verifizierer " +
  "wird erst wirksam, wenn sie bestätigt wird (Vier-Augen-Prinzip). Sie finden " +
  "den Vorschlag unter „Ausstehende Verifier-Ernennungen“.";

export interface ErnennungVorschlagenInput {
  targetEmail: string;
  scopeLevel?: ScopeLevel;
  scopeCode?: string | null;
}

// ---------------------------------------------------------------------------
// verifierErnennungVorschlagenCore — Schritt 1: Vorschlag (pending) anlegen.
// ---------------------------------------------------------------------------

/**
 * Schlägt die Ernennung einer Person (per Ziel-E-Mail) zur Rolle `verifier`
 * vor — tenant-scoped, eskalationsgeschützt, auditiert. Guards wie
 * assignRoleCore; die E-Mail wird beidseitig normalisiert verglichen
 * (lower/trim — users.email ist historisch nicht normalisiert gespeichert).
 */
export async function verifierErnennungVorschlagenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  input: ErnennungVorschlagenInput,
): Promise<ErnennungResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  // ESKALATIONSGRENZE — serverseitig hart (UI ist Komfort). Wer `verifier`
  // nicht vergeben darf, darf die Ernennung auch nicht vorschlagen.
  if (!canManageRole(callerRoleTypes, ERNENNUNGS_ROLLE)) {
    return { ok: false, error: "Keine Berechtigung, diese Rolle zu vergeben." };
  }

  const scopeLevel: ScopeLevel = input.scopeLevel ?? "stadt";
  const scopeCode = input.scopeCode ?? null;
  const targetEmail = input.targetEmail.trim().toLowerCase();

  if (!targetEmail) {
    return { ok: false, error: "Bitte eine Ziel-E-Mail angeben." };
  }
  // Server Actions sind RPC-Endpoints — der TS-Typ schützt nur kompilierzeitlich.
  if (!VALID_SCOPE_LEVELS.includes(scopeLevel)) {
    return { ok: false, error: "Ungültige Ebene (scope_level)." };
  }

  // Ziel-User im SELBEN Tenant auflösen — lower(trim) BEIDSEITIG.
  const targetRows = await db
    .select({ id: users.id, accountStatus: users.accountStatus })
    .from(users)
    .where(
      and(eq(users.tenantId, tenantId), sql`lower(trim(${users.email})) = ${targetEmail}`),
    )
    .limit(1);
  const target = targetRows[0];
  if (!target) {
    return { ok: false, error: "Es existiert kein Konto mit dieser E-Mail in dieser Kommune." };
  }

  // Nur ein AKTIVES Konto ist ernennbar (gesperrt/gelöscht ⇒ Fehler).
  if (target.accountStatus !== "active") {
    return { ok: false, error: "Dieses Konto ist nicht aktiv (gesperrt oder gelöscht)." };
  }

  // ADR-024 contract: Scope-Eingabe via Baum zu region_id auflösen.
  let regionId: string;
  try {
    regionId = await resolveRegionIdForScope(db, tenantId, scopeLevel, scopeCode);
  } catch {
    return { ok: false, error: "Für die gewählte Ebene ist noch kein Gebiet hinterlegt." };
  }

  // Existiert die ROLLE (am selben Gebietsknoten) bereits, gibt es nichts
  // vorzuschlagen — freundlich, keine Änderung (Muster assignRole-Idempotenz).
  const vorhandene = await db
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        eq(roles.userId, target.id),
        eq(roles.roleType, ERNENNUNGS_ROLLE),
        eq(roles.regionId, regionId),
      ),
    )
    .limit(1);
  if (vorhandene.length > 0) {
    return { ok: true, message: "Diese Person hat die Rolle bereits." };
  }

  // Insert pending + Audit in EINER Transaktion. Doppel-Vorschlag ⇒ der
  // partielle UNIQUE-Index wirft 23505 (race-fest, kein TOCTOU) ⇒ freundlich.
  try {
    return await db.transaction(async (tx: Db) => {
      const [row] = await tx
        .insert(roleAppointments)
        .values({
          tenantId,
          targetUserId: target.id,
          roleType: ERNENNUNGS_ROLLE,
          regionId,
          proposedBy: callerUserId,
        })
        .returning({ id: roleAppointments.id });

      // Audit PII-frei — KEINE E-Mail, nur IDs + Rolle.
      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "admin",
        actorRef: callerUserId,
        action: "role.appointment_proposed",
        targetType: "user",
        targetId: target.id,
        metadata: { appointmentId: row.id, roleType: ERNENNUNGS_ROLLE, regionId },
      });

      return { ok: true as const, appointmentId: row.id, message: VORSCHLAG_ANGELEGT };
    });
  } catch (err) {
    if (istPgFehler(err, PG_UNIQUE_VIOLATION)) {
      return { ok: false, error: "Für diese Person liegt bereits ein offener Vorschlag vor." };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// verifierErnennungEntscheidenCore — Schritt 2: bestätigen ODER ablehnen.
// ---------------------------------------------------------------------------

export interface ErnennungEntscheidenInput {
  appointmentId: string;
  entscheidung: "bestaetigen" | "ablehnen";
  /**
   * true NUR über isSelfApprovalAllowed() (ALLOW_SELF_APPROVAL=true) —
   * SERVERSEITIG bestimmt, nie vom Client. Default false = Vier-Augen-Sperre
   * erzwungen (fail-closed).
   */
  allowSelfApproval?: boolean;
}

/** Interner Marker für den atomaren Rollback (Statusflanke zurückrollen). */
class EntscheidenRollback extends Error {
  constructor(public fehler: string) {
    super(`appointment-entscheiden-rollback`);
    this.name = "EntscheidenRollback";
  }
}

/**
 * Entscheidet einen offenen Ernennungs-Vorschlag — ATOMAR und race-frei:
 *
 *   1. Bedingter UPDATE pending→approved/rejected (WHERE id AND tenant AND
 *      status='pending' AND SoD-Guards, RETURNING) — gewinnt genau EINER; die
 *      Selbst-Bestätigungs-Sperren stehen als Bedingung IM UPDATE (kein TOCTOU).
 *   2. Bei „bestaetigen“: Ziel-Konto MUSS noch aktiv sein — sonst Rollback der
 *      Flanke (Vorschlag bleibt pending) mit Fehler.
 *   3. Rollenvergabe idempotent (onConflictDoNothing auf den roles-UNIQUE):
 *      existiert die Rolle inzwischen anderweitig, wird der Vorschlag trotzdem
 *      approved („Rolle bestand bereits.“) — bewusst ohne Savepoint-Akrobatik,
 *      onConflictDoNothing IST die 23505-Behandlung innerhalb der Transaktion.
 *   4. Audits in DERSELBEN Transaktion: role.appointment_approved + role.granted
 *      (nur bei echter Vergabe; Muster role-actions) bzw. role.appointment_rejected.
 *
 * SoD gilt NUR für „bestaetigen“ (Gate-B MINOR): Das ABLEHNEN des eigenen
 * Vorschlags ist funktional ein Zurückziehen mit anderem Endstatus — es vergibt
 * nichts und braucht kein Vier-Augen (sonst UI-Sackgasse mit irreführendem
 * Fehlertext). Zwei Sperren bei Bestätigung (außer allowSelfApproval):
 *   - proposedBy ≠ caller  (Vorschlagende:r bestätigt nicht selbst)
 *   - targetUserId ≠ caller (die BEGÜNSTIGTE Person bestätigt nicht die eigene
 *     Ernennung — auch wenn ein anderer Admin vorgeschlagen hat; Gate-B MINOR)
 */
export async function verifierErnennungEntscheidenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  input: ErnennungEntscheidenInput,
): Promise<ErnennungResult> {
  const allowSelfApproval = input.allowSelfApproval ?? false;

  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  // Vorschlag tenant-scoped laden (Anzeige-/Fehlerpfad; sicherheitskritisch ist
  // das atomare UPDATE unten). Fremder Tenant sieht generisch „nicht gefunden“.
  const apptRows = await db
    .select({
      id: roleAppointments.id,
      status: roleAppointments.status,
      roleType: roleAppointments.roleType,
      proposedBy: roleAppointments.proposedBy,
      targetUserId: roleAppointments.targetUserId,
    })
    .from(roleAppointments)
    .where(and(eq(roleAppointments.tenantId, tenantId), eq(roleAppointments.id, input.appointmentId)))
    .limit(1);
  const appt = apptRows[0];
  if (!appt || appt.status !== "pending") {
    return { ok: false, error: NICHT_GEFUNDEN };
  }

  // ESKALATIONSGRENZE über den role_type des Vorschlags (generisch; heute 'verifier').
  if (!canManageRole(callerRoleTypes, appt.roleType)) {
    return { ok: false, error: "Keine Berechtigung, diese Rolle zu vergeben." };
  }

  // NUR die BESTÄTIGUNG unterliegt dem Vier-Augen-Prinzip — Ablehnen des
  // eigenen Vorschlags ist ein Zurückziehen mit anderem Endstatus (s. Docblock).
  const istBestaetigung = input.entscheidung === "bestaetigen";

  // SoD-Vorprüfungen (freundliche Fehler; atomarer Backstop im UPDATE unten).
  if (istBestaetigung && !allowSelfApproval) {
    if (appt.proposedBy === callerUserId) {
      return { ok: false, error: SOD_FEHLER };
    }
    if (appt.targetUserId === callerUserId) {
      return { ok: false, error: SOD_ZIEL_FEHLER };
    }
  }

  const neuerStatus = istBestaetigung ? "approved" : "rejected";

  try {
    return await db.transaction(async (tx: Db) => {
      // SoD-Sperren ATOMAR (nur bei Bestätigung, ohne Überbrückung): das UPDATE
      // schlägt fehl, wenn (a) die entscheidende Person selbst vorgeschlagen hat
      // (proposedBy NULL — z. B. Vorschlagende:r gelöscht — zählt als „andere
      // Person“: Vier-Augen erfüllt) oder (b) sie selbst die BEGÜNSTIGTE der
      // Ernennung ist (Gate-B MINOR: Ziel-Admin bestätigt eigene Beförderung).
      const sodGuard =
        !istBestaetigung || allowSelfApproval
          ? undefined
          : and(
              or(
                isNull(roleAppointments.proposedBy),
                ne(roleAppointments.proposedBy, callerUserId),
              ),
              ne(roleAppointments.targetUserId, callerUserId),
            );

      const updated = await tx
        .update(roleAppointments)
        .set({
          status: neuerStatus,
          decidedBy: callerUserId,
          decidedAt: sql`now()`,
        })
        .where(
          and(
            eq(roleAppointments.id, input.appointmentId),
            eq(roleAppointments.tenantId, tenantId),
            eq(roleAppointments.status, "pending"),
            sodGuard,
          ),
        )
        .returning({
          id: roleAppointments.id,
          targetUserId: roleAppointments.targetUserId,
          roleType: roleAppointments.roleType,
          regionId: roleAppointments.regionId,
          proposedBy: roleAppointments.proposedBy,
        });

      if (updated.length === 0) {
        // Ursache unterscheiden: SoD-Sperren oder bereits entschieden/weg.
        const cur = await tx
          .select({
            status: roleAppointments.status,
            proposedBy: roleAppointments.proposedBy,
            targetUserId: roleAppointments.targetUserId,
          })
          .from(roleAppointments)
          .where(
            and(eq(roleAppointments.tenantId, tenantId), eq(roleAppointments.id, input.appointmentId)),
          )
          .limit(1);
        if (cur[0]?.status === "pending" && istBestaetigung && !allowSelfApproval) {
          if (cur[0].proposedBy === callerUserId) {
            return { ok: false as const, error: SOD_FEHLER };
          }
          if (cur[0].targetUserId === callerUserId) {
            return { ok: false as const, error: SOD_ZIEL_FEHLER };
          }
        }
        return { ok: false as const, error: NICHT_GEFUNDEN };
      }

      const flanke = updated[0];
      // Überbrückte Selbst-Bestätigung EXPLIZIT sichtbar machen (nie unsichtbar):
      // sowohl „eigenen Vorschlag bestätigt“ als auch „eigene Ernennung bestätigt“.
      const selfApproval =
        allowSelfApproval &&
        (flanke.proposedBy === callerUserId || flanke.targetUserId === callerUserId);

      if (input.entscheidung === "ablehnen") {
        await tx.insert(auditEvents).values({
          tenantId,
          actorType: "admin",
          actorRef: callerUserId,
          action: "role.appointment_rejected",
          targetType: "user",
          targetId: flanke.targetUserId,
          metadata: {
            appointmentId: flanke.id,
            roleType: flanke.roleType,
            regionId: flanke.regionId,
          },
        });
        return { ok: true as const, message: "Vorschlag abgelehnt. Es wurde keine Rolle vergeben." };
      }

      // bestaetigen: Ziel-Konto MUSS noch aktiv sein — sonst Rollback der
      // Flanke (Vorschlag bleibt pending), kein Rollen-Insert.
      const zielRows = await tx
        .select({ accountStatus: users.accountStatus })
        .from(users)
        .where(and(eq(users.id, flanke.targetUserId), eq(users.tenantId, tenantId)))
        .limit(1);
      if (zielRows[0]?.accountStatus !== "active") {
        throw new EntscheidenRollback(
          "Dieses Konto ist nicht mehr aktiv (gesperrt oder gelöscht) — der Vorschlag bleibt offen.",
        );
      }

      // Rolle idempotent einfügen: greift den UNIQUE(tenant,user,role_type,region)
      // ab — existiert sie inzwischen anderweitig, bleibt der Vorschlag approved.
      const inserted = await tx
        .insert(roles)
        .values({
          tenantId,
          userId: flanke.targetUserId,
          roleType: flanke.roleType as RoleType,
          regionId: flanke.regionId,
        })
        .onConflictDoNothing()
        .returning({ id: roles.id });

      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "admin",
        actorRef: callerUserId,
        action: "role.appointment_approved",
        targetType: "user",
        targetId: flanke.targetUserId,
        metadata: {
          appointmentId: flanke.id,
          roleType: flanke.roleType,
          regionId: flanke.regionId,
          ...(selfApproval ? { selfApproval: true } : {}),
        },
      });

      if (inserted.length > 0) {
        // role.granted — exakt das Muster aus role-actions (Audit-Konsistenz).
        await tx.insert(auditEvents).values({
          tenantId,
          actorType: "admin",
          actorRef: callerUserId,
          action: "role.granted",
          targetType: "user",
          targetId: flanke.targetUserId,
          metadata: { roleType: flanke.roleType, via: "appointment" },
        });
        return { ok: true as const, message: "Ernennung bestätigt — die Rolle wurde vergeben." };
      }

      return { ok: true as const, message: "Ernennung bestätigt. Rolle bestand bereits." };
    });
  } catch (err) {
    if (err instanceof EntscheidenRollback) {
      return { ok: false, error: err.fehler };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// verifierErnennungZurueckziehenCore — offenen Vorschlag zurückziehen.
// ---------------------------------------------------------------------------

/**
 * Zieht einen offenen Vorschlag zurück (pending→cancelled, atomar, auditiert).
 * Erlaubt für die vorschlagende Person ODER jede:n Admin, der die Rolle
 * verwalten darf (canManageRole) — Nicht-Admins nie (fail-closed).
 */
export async function verifierErnennungZurueckziehenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  input: { appointmentId: string },
): Promise<ErnennungResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  return await db.transaction(async (tx: Db) => {
    const rows = await tx
      .select({
        id: roleAppointments.id,
        roleType: roleAppointments.roleType,
        targetUserId: roleAppointments.targetUserId,
        regionId: roleAppointments.regionId,
        proposedBy: roleAppointments.proposedBy,
      })
      .from(roleAppointments)
      .where(and(eq(roleAppointments.tenantId, tenantId), eq(roleAppointments.id, input.appointmentId)))
      .limit(1);
    const appt = rows[0];
    if (!appt) {
      return { ok: false as const, error: NICHT_GEFUNDEN };
    }

    // Vorschlagende:r ODER Admin mit Verwaltungsrecht für diese Rolle.
    if (appt.proposedBy !== callerUserId && !canManageRole(callerRoleTypes, appt.roleType)) {
      return { ok: false as const, error: "Keine Berechtigung für diesen Vorschlag." };
    }

    // Atomar: nur ein noch OFFENER Vorschlag lässt sich zurückziehen.
    const updated = await tx
      .update(roleAppointments)
      .set({ status: "cancelled", decidedBy: callerUserId, decidedAt: sql`now()` })
      .where(
        and(
          eq(roleAppointments.id, input.appointmentId),
          eq(roleAppointments.tenantId, tenantId),
          eq(roleAppointments.status, "pending"),
        ),
      )
      .returning({ id: roleAppointments.id });
    if (updated.length === 0) {
      return { ok: false as const, error: NICHT_GEFUNDEN };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "role.appointment_cancelled",
      targetType: "user",
      targetId: appt.targetUserId,
      metadata: { appointmentId: appt.id, roleType: appt.roleType, regionId: appt.regionId },
    });

    return { ok: true as const, message: "Vorschlag zurückgezogen." };
  });
}

// ---------------------------------------------------------------------------
// Lese-Query für die Admin-Übersicht (OHNE "use server").
// ---------------------------------------------------------------------------

export interface ErnennungRow {
  id: string;
  /** UserId des Ziel-Kontos (UI: Ziel-Person bestätigt nie die eigene Ernennung). */
  targetUserId: string;
  /** E-Mail des Ziel-Kontos (Admin-Fläche, tenant-intern — wie Rollen-Liste). */
  targetEmail: string;
  roleType: string;
  regionTyp: string;
  regionName: string;
  /** UserId der vorschlagenden Person (UI: „Zurückziehen“/Selbst-Bestätigung). */
  proposedBy: string | null;
  /** E-Mail der vorschlagenden Person (null, wenn Konto gelöscht — SET NULL). */
  proposedByEmail: string | null;
  proposedAt: Date;
}

/**
 * Listet die OFFENEN (pending) Verifier-Ernennungen eines Tenants — mit
 * Ziel-/Vorschlagenden-E-Mail (Admin-only, tenant-intern; NICHT zu verwechseln
 * mit der PII-freien Audit-Ansicht) und Gebiets-Label wie die Rollen-Anzeige.
 */
export async function offeneErnennungenListeCore(
  db: Db,
  tenantId: string,
): Promise<ErnennungRow[]> {
  const proposer = alias(users, "proposer");
  const rows = await db
    .select({
      id: roleAppointments.id,
      targetUserId: roleAppointments.targetUserId,
      targetEmail: users.email,
      roleType: roleAppointments.roleType,
      regionTyp: regions.typ,
      regionName: regions.name,
      proposedBy: roleAppointments.proposedBy,
      proposedByEmail: proposer.email,
      proposedAt: roleAppointments.proposedAt,
    })
    .from(roleAppointments)
    .innerJoin(users, eq(users.id, roleAppointments.targetUserId))
    .innerJoin(regions, eq(regions.id, roleAppointments.regionId))
    .leftJoin(proposer, eq(proposer.id, roleAppointments.proposedBy))
    .where(and(eq(roleAppointments.tenantId, tenantId), eq(roleAppointments.status, "pending")))
    .orderBy(desc(roleAppointments.proposedAt));
  return rows as ErnennungRow[];
}
