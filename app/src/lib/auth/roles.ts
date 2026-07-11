/**
 * roles.ts — Zentrale Rollen-Logik (H1/M2).
 *
 * Ersetzt die zuvor über viele Dateien duplizierte Prüfung
 * `roleType === 'kommune_admin' || 'super_admin'` durch benannte Achsen:
 *
 *   - REDAKTION: darf Digests bearbeiten/quellen-prüfen (redakteur + Admins)
 *   - FREIGABE:  darf freigeben/veröffentlichen — NUR Admins. Das ist der
 *                Vier-Augen-Hebel (H1): ein `redakteur` prüft, gibt aber NICHT frei.
 *   - ADMIN:     klassische Verwaltungsrechte (Anliegen, Einstellungen, Rollen)
 *
 * Ein User kann mehrere Rollen haben; geprüft wird per Schnittmenge.
 */

import { and, eq } from "drizzle-orm";
import { roles, users } from "@/db/schema";
import type { Db } from "@/db/client";

export const REDAKTION_ROLES = ["redakteur", "kommune_admin", "super_admin"] as const;
export const FREIGABE_ROLES = ["kommune_admin", "super_admin"] as const;
export const ADMIN_ROLES = ["kommune_admin", "super_admin"] as const;
// ADR-014 Block 2: Wer QR-Codes für die Wohnsitz-Verifizierung erzeugen/
// widerrufen darf. Bewusst eng: verifier (Bürgerbüro/Institution) + Admins.
// Ein normaler User kann sich NUR über einen gültigen QR verifizieren — nie
// per Direktaufruf (kein Selbst-Hochstufen).
export const VERIFIER_ROLES = ["verifier", "kommune_admin", "super_admin"] as const;

/**
 * Lädt die Rollentypen eines aktiven Users in einem Tenant (können mehrere sein).
 *
 * Sicherheit (Eskalationsgrenze): nur Rollen von Konten mit
 * `account_status = 'active'` werden zurückgegeben. Ein gesperrtes/gelöschtes
 * Konto (locked/deleted) erhält `[]` → `isAdmin`/`canRedaktion`/`canFreigeben`/
 * `canVerify` sind dann false. Damit verliert ein gesperrtes Admin-Konto auch bei
 * noch gültiger Session SOFORT alle privilegierten Rechte (zentral erzwungen über
 * den inneren JOIN auf users) — konsistent mit `getStufe`, das locked → Stufe 0 setzt.
 */
export async function getUserRoleTypes(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ roleType: roles.roleType })
    .from(roles)
    .innerJoin(users, eq(users.id, roles.userId))
    .where(
      and(
        eq(roles.tenantId, tenantId),
        eq(roles.userId, userId),
        eq(users.accountStatus, "active"),
      ),
    );
  return rows.map((r: { roleType: string }) => r.roleType);
}

export function hasAnyRole(roleTypes: string[], allowed: readonly string[]): boolean {
  return roleTypes.some((rt) => allowed.includes(rt));
}

/** Darf Digests redaktionell bearbeiten/quellen-prüfen (redakteur oder Admin). */
export function canRedaktion(roleTypes: string[]): boolean {
  return hasAnyRole(roleTypes, REDAKTION_ROLES);
}

/** Darf Digests freigeben/veröffentlichen (NUR Admin — redakteur nicht). */
export function canFreigeben(roleTypes: string[]): boolean {
  return hasAnyRole(roleTypes, FREIGABE_ROLES);
}

/** Klassische Admin-Rechte (kommune_admin/super_admin). */
export function isAdmin(roleTypes: string[]): boolean {
  return hasAnyRole(roleTypes, ADMIN_ROLES);
}

/**
 * Darf QR-Codes für die Wohnsitz-Verifizierung erstellen/widerrufen
 * (verifier oder Admin). ADR-014 Block 2 — serverseitig hart erzwungen.
 */
export function canVerify(roleTypes: string[]): boolean {
  return hasAnyRole(roleTypes, VERIFIER_ROLES);
}

// ---------------------------------------------------------------------------
// Rollen-Verwaltung & Eskalationsgrenze (Achse B — Rollenvergabe auditiert)
// ---------------------------------------------------------------------------

/**
 * Alle gültigen Rollentypen (Reihenfolge = Anzeige-Reihenfolge in der UI).
 * Hält sich an den `role_type`-Enum in schema.ts.
 */
export const ALL_ROLE_TYPES = [
  "user",
  "verifier",
  "redakteur",
  "kommune_admin",
  "super_admin",
  "ortsteil_admin",
  "kreis_admin",
  "land_admin",
] as const;

export type RoleType = (typeof ALL_ROLE_TYPES)[number];

/**
 * Rollen, die ein `kommune_admin` vergeben/entziehen darf.
 * BEWUSST eng: NIEMALS `super_admin`, NIEMALS die Reserve-Rollen
 * (`ortsteil_admin`/`kreis_admin`/`land_admin`). Das ist die
 * Eskalationsgrenze (Privilege-Escalation-Schutz, Vertrauensprodukt).
 */
export const KOMMUNE_ADMIN_MANAGEABLE_ROLES = [
  "user",
  "verifier",
  "redakteur",
  "kommune_admin",
] as const;

/** Reserve-Rollen — im Pilot nicht vergeben; nur `super_admin` darf sie verwalten. */
export const RESERVE_ROLES = ["ortsteil_admin", "kreis_admin", "land_admin"] as const;

/**
 * KERN DER ESKALATIONSGRENZE — reine, unit-testbare Funktion.
 *
 * Beantwortet: „Darf ein Caller mit den Rollen `callerRoleTypes` die Rolle
 * `roleType` vergeben ODER entziehen?"
 *
 * Regeln (serverseitig hart erzwungen; die UI ist nur Komfort):
 *   - `super_admin`   → darf JEDE Rolle verwalten.
 *   - `kommune_admin` → NUR { user, verifier, redakteur, kommune_admin }.
 *                       NIEMALS super_admin, NIEMALS Reserve-Rollen.
 *   - alles andere (Nicht-Admin) → darf NICHTS verwalten.
 *
 * Mehrfachrollen: Caller darf, sobald EINE seiner Rollen es erlaubt
 * (super_admin gewinnt). Unbekannte/ungültige roleType-Werte → false.
 */
export function canManageRole(callerRoleTypes: string[], roleType: string): boolean {
  // Ungültiger Ziel-Rollentyp → niemals verwaltbar (Fail-closed).
  if (!(ALL_ROLE_TYPES as readonly string[]).includes(roleType)) return false;

  // super_admin darf alles.
  if (callerRoleTypes.includes("super_admin")) return true;

  // kommune_admin darf nur die eng definierte Teilmenge.
  if (callerRoleTypes.includes("kommune_admin")) {
    return (KOMMUNE_ADMIN_MANAGEABLE_ROLES as readonly string[]).includes(roleType);
  }

  // Nicht-Admin (oder nur user/verifier/redakteur) darf nichts verwalten.
  return false;
}

/**
 * Liefert die Liste der Rollentypen, die der Caller in der UI anbieten darf.
 * Reiner Filter über {@link canManageRole}; der Server erzwingt es zusätzlich.
 */
export function manageableRoleTypes(callerRoleTypes: string[]): RoleType[] {
  return ALL_ROLE_TYPES.filter((rt) => canManageRole(callerRoleTypes, rt));
}
