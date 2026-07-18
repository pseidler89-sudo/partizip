/**
 * role-actions.ts — Rollen-Verwaltung mit Audit (Achse B, Gate B).
 *
 * HEUTE werden Rollen nur per SQL gesetzt → unauditiert. Diese Datei schließt
 * die Lücke: Rollen werden über auditierte Server Actions vergeben/entzogen,
 * mit serverseitig hart erzwungener Eskalationsgrenze.
 *
 * Aufbau (Muster aus konto/delete.ts + konto/actions.ts):
 *   - Kern-Logik `assignRoleCore` / `revokeRoleCore` ist KEIN "use server" —
 *     direkt unit-/integration-testbar (DB rein, keine Cookies/Header).
 *   - Die dünnen "use server"-Wrapper `assignRole` / `revokeRole` lösen den
 *     Auth-Kontext (Session-Cookie → Tenant + Caller-UserId) auf und rufen
 *     dann in die Kern-Logik.
 *
 * Sicherheits-Invarianten (Vertrauensprodukt):
 *   - Tenant-Isolation in JEDER Query (tenantId immer im WHERE).
 *   - Eskalationsgrenze über die reine Funktion `canManageRole` (roles.ts):
 *       super_admin → alles; kommune_admin → nur { user, verifier, redakteur,
 *       kommune_admin }; niemals super_admin/Reserve.
 *   - Letzter-Admin-Schutz beim Entzug race-frei (pg_advisory_xact_lock).
 *   - Audit PII-frei: actorRef = Caller-UUID, targetId = betroffene UserId,
 *     metadata enthält NIEMALS E-Mail.
 */

import { and, eq, count, ne, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users, roles, auditEvents } from "@/db/schema";
import {
  ADMIN_ROLES,
  canManageRole,
  isAdmin,
  type RoleType,
} from "@/lib/auth/roles";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { normalizeEmail } from "@/lib/auth/email";
import { verifierErnennungVorschlagenCore } from "@/lib/admin/appointment-core";
import { identitaetPiiEntfernenWennKeinRollentraeger } from "@/lib/identity/pii-cleanup";

type ScopeLevel = "ortsteil" | "stadt" | "kreis" | "land";

export type RoleActionResult = { ok: boolean; error?: string; message?: string };

export interface AssignRoleInput {
  targetEmail: string;
  roleType: string;
  scopeLevel?: ScopeLevel;
  scopeCode?: string | null;
}

export interface RevokeRoleInput {
  roleId: string;
}

// ---------------------------------------------------------------------------
// Kern-Logik (testbar — kein "use server", kein Cookie/Header)
// ---------------------------------------------------------------------------

/**
 * Vergibt eine Rolle an einen User (per Ziel-E-Mail) — tenant-scoped, auditiert.
 *
 * @param callerRoleTypes  Rollen des aufrufenden Admins (für Eskalationsgrenze).
 * @param callerUserId     UserId des Callers (Audit-actorRef).
 */
export async function assignRoleCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  input: AssignRoleInput,
): Promise<RoleActionResult> {
  // 1. Caller muss überhaupt Admin sein.
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  // Block K3 (Vier-Augen): `verifier` wird NICHT mehr direkt vergeben, sondern
  // als zweistufiger Ernennungs-Vorschlag angelegt (Vorschlag → Bestätigung
  // durch eine:n zweite:n Admin). Alle anderen Rollen unverändert direkt.
  if (input.roleType === "verifier") {
    return verifierErnennungVorschlagenCore(db, tenantId, callerRoleTypes, callerUserId, {
      targetEmail: input.targetEmail,
      scopeLevel: input.scopeLevel,
      scopeCode: input.scopeCode,
    });
  }

  const roleType = input.roleType;
  const scopeLevel: ScopeLevel = input.scopeLevel ?? "stadt";
  const scopeCode = input.scopeCode ?? null;
  const targetEmail = normalizeEmail(input.targetEmail);

  // 2. ESKALATIONSGRENZE — serverseitig hart. UI ist nur Komfort.
  if (!canManageRole(callerRoleTypes, roleType)) {
    return { ok: false, error: "Keine Berechtigung, diese Rolle zu vergeben." };
  }

  if (!targetEmail) {
    return { ok: false, error: "Bitte eine Ziel-E-Mail angeben." };
  }

  // G1: scopeLevel serverseitig validieren — Server Actions sind RPC-Endpoints,
  //     der TS-Typ schützt nur kompilierzeitlich.
  const VALID_SCOPE_LEVELS: readonly string[] = ["ortsteil", "stadt", "kreis", "land"];
  if (!VALID_SCOPE_LEVELS.includes(scopeLevel)) {
    return { ok: false, error: "Ungültige Ebene (scope_level)." };
  }

  // 3. Ziel-User im SELBEN Tenant auflösen (tenant-scoped).
  const targetRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, targetEmail)))
    .limit(1);

  const target = targetRows[0];
  if (!target) {
    return { ok: false, error: "Es existiert kein Konto mit dieser E-Mail in dieser Kommune." };
  }

  // ADR-024 contract: die Scope-Eingabe (TS-Ebene + optionaler Code) wird via Baum
  // zu region_id aufgelöst — der EINZIGE geschriebene Gebietsbezug (scope_level/
  // scope_code sind entfernt). Kein Gebiet hinterlegt → freundlicher Fehler.
  let regionId: string;
  try {
    regionId = await resolveRegionIdForScope(db, tenantId, scopeLevel, scopeCode);
  } catch {
    return { ok: false, error: "Für die gewählte Ebene ist noch kein Gebiet hinterlegt." };
  }

  // 4.+5. Rolle einfügen + Audit in EINER Transaktion (F1: keine Mutation ohne
  //        Audit — die Invariante, die Achse B gerade herstellen soll).
  //        onConflictDoNothing greift den UNIQUE(tenant,user,role_type,region_id)
  //        ab; returning() ist leer, wenn nichts eingefügt wurde.
  return await db.transaction(async (tx: Db) => {
    const inserted = await tx
      .insert(roles)
      .values({
        tenantId,
        userId: target.id,
        roleType: roleType as RoleType,
        regionId,
      })
      .onConflictDoNothing()
      .returning({ id: roles.id });

    if (inserted.length === 0) {
      return {
        ok: true as const,
        message: "Diese Rolle ist diesem Konto bereits zugewiesen (keine Änderung).",
      };
    }

    // Audit role.granted — PII-frei (actorRef=Caller, targetId=Ziel-User-UUID).
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "role.granted",
      targetType: "user",
      targetId: target.id,
      metadata: { roleType, scopeLevel },
    });

    return { ok: true as const, message: "Rolle vergeben." };
  });
}

/**
 * Entzieht eine Rolle (per roleId) — tenant-scoped, eskalations- und
 * letzter-Admin-geschützt, auditiert.
 *
 * Race-frei: Letzter-Admin-Guard + Delete + Audit laufen in EINER Transaktion,
 * serialisiert per pg_advisory_xact_lock(hashtext(tenantId)) (Muster aus
 * konto/delete.ts), damit zwei parallele Entzüge nicht beide den Tenant
 * verwaisen lassen.
 */
export async function revokeRoleCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  input: RevokeRoleInput,
): Promise<RoleActionResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  return await db.transaction(async (tx: Db) => {
    // Per-Tenant-Lock: serialisiert nebenläufige Rollen-Entzüge DESSELBEN
    // Tenants (sonst könnten zwei „vorletzte"-Admin-Entzüge gleichzeitig laufen,
    // beide den jeweils anderen noch als Admin sehen → verwaister Tenant).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);

    // 1. Rolle tenant-scoped laden.
    const roleRows = await tx
      .select({
        id: roles.id,
        userId: roles.userId,
        roleType: roles.roleType,
      })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.id, input.roleId)))
      .limit(1);

    const role = roleRows[0];
    if (!role) {
      return { ok: false as const, error: "Rolle nicht gefunden." };
    }

    // 2. ESKALATIONSGRENZE — kommune_admin darf super_admin/Reserve NICHT entziehen.
    if (!canManageRole(callerRoleTypes, role.roleType)) {
      return { ok: false as const, error: "Keine Berechtigung, diese Rolle zu entziehen." };
    }

    // 3. LETZTER-ADMIN-SCHUTZ — innerhalb der gesperrten Transaktion (race-frei).
    //    Nur relevant, wenn die zu entziehende Rolle selbst eine Admin-Rolle ist.
    if ((ADMIN_ROLES as readonly string[]).includes(role.roleType)) {
      // Gibt es im Tenant noch eine ANDERE Admin-Rolle (anderer User ODER
      // andere Rolle desselben Users)?
      const otherAdminRows = await tx
        .select({ n: count() })
        .from(roles)
        // Audit m2: nur AKTIVE Admins zählen — ein gesperrtes/gelöschtes Konto
        // ist nicht handlungsfähig und darf den Letzter-Admin-Schutz nicht
        // aushebeln (sonst bliebe die Kommune ohne bedienbaren Admin zurück).
        .innerJoin(users, eq(users.id, roles.userId))
        .where(
          and(
            eq(roles.tenantId, tenantId),
            ne(roles.id, role.id),
            inArray(roles.roleType, [...ADMIN_ROLES]),
            eq(users.accountStatus, "active"),
          ),
        );
      const otherAdminCount = otherAdminRows[0]?.n ?? 0;
      if (otherAdminCount === 0) {
        return {
          ok: false as const,
          error:
            "Diese Rolle ist die letzte Administrator-Rolle dieser Kommune und " +
            "kann nicht entzogen werden. Bitte zuerst eine andere Person zur " +
            "Administratorin oder zum Administrator ernennen.",
        };
      }
    }

    // 4. Rolle löschen (tenant-scoped).
    await tx
      .delete(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.id, role.id)));

    // 4b. Datenminimierung (Block J1, Gate-B 1a): hält der User danach keine
    //     Rolle ≠ `user` mehr, entfällt die Zweckbindung für Klarname/Funktion —
    //     die Identitäts-PII wird in DERSELBEN Tx entfernt (+ Audit profile.updated).
    await identitaetPiiEntfernenWennKeinRollentraeger(
      tx,
      tenantId,
      role.userId,
      callerUserId,
      "role_revoked",
    );

    // 5. Audit role.revoked — PII-frei (targetId = betroffene UserId).
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "role.revoked",
      targetType: "user",
      targetId: role.userId,
      metadata: { roleType: role.roleType },
    });

    return { ok: true as const, message: "Rolle entzogen." };
  });
}
