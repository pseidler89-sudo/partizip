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

import { and, eq, sql } from "drizzle-orm";
import { roles, users, regions } from "@/db/schema";
import type { Db } from "@/db/client";
import type { ScopeInputLevel } from "@/lib/region/ebenen";

export const REDAKTION_ROLES = ["redakteur", "kommune_admin", "super_admin"] as const;
export const FREIGABE_ROLES = ["kommune_admin", "super_admin"] as const;
export const ADMIN_ROLES = ["kommune_admin", "super_admin"] as const;
// Rollen-Governance: Lese-Zugriff auf den Verwaltungs-Bereich (Ergebnisse,
// Digest-Entwürfe). `beobachter` ist eine reine View-Only-Rolle für
// Multiplikatoren — sie taucht BEWUSST in KEINER Mutations-Achse auf
// (REDAKTION/FREIGABE/ADMIN/VERIFIER): kein Bearbeiten, kein Freigeben,
// keine Rollenvergabe, keine Verifizierung.
export const BEOBACHTUNG_ROLES = [
  "beobachter",
  "redakteur",
  "kommune_admin",
  "super_admin",
] as const;
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
 * NUR der Betreiber (super_admin) — enger als isAdmin. Block N: die tenant-freie
 * Interessenten-Sicht (Leads über alle Kommunen hinweg) ist ausschließlich für
 * den Plattform-Betreiber, NICHT für einen kommune_admin einer einzelnen Kommune.
 */
export function isSuperAdmin(roleTypes: string[]): boolean {
  return roleTypes.includes("super_admin");
}

/**
 * Darf QR-Codes für die Wohnsitz-Verifizierung erstellen/widerrufen
 * (verifier oder Admin). ADR-014 Block 2 — serverseitig hart erzwungen.
 */
export function canVerify(roleTypes: string[]): boolean {
  return hasAnyRole(roleTypes, VERIFIER_ROLES);
}

/**
 * Darf den LESE-Teil der Verwaltung sehen (Ergebnisse, Digest-Entwürfe):
 * beobachter, redakteur oder Admin. REINE Lese-Achse — sie gibt NIEMALS
 * Mutationsrechte (dafür gelten weiterhin canRedaktion/canFreigeben/isAdmin/
 * canVerify, in denen `beobachter` nicht vorkommt).
 */
export function canBeobachten(roleTypes: string[]): boolean {
  return hasAnyRole(roleTypes, BEOBACHTUNG_ROLES);
}

// ---------------------------------------------------------------------------
// Gebiets-Sichtbarkeit für die View-Only-Rolle `beobachter` (ADR-024)
// ---------------------------------------------------------------------------

/**
 * Rollenzeile mit Gebietsknoten — Eingabe für die Sichtbarkeits-Prüfung. Statt
 * scope_level/scope_code (entfernt) trägt sie jetzt die Gebietsart (regions.typ)
 * und den ltree-Pfad (regions.path) des Rollen-Knotens.
 */
export interface RoleScopeRow {
  roleType: string;
  regionTyp: string;
  regionPath: string;
}

/**
 * Deckt der Vorfahr-(oder-Selbst-)Knoten `anc` den Knoten `node` ab? ltree-`@>`
 * in JS: gleicher Pfad ODER `node` liegt echt unterhalb (`anc.` als Präfix).
 *
 * Exportiert (Block K1): neben der Beobachter-Sichtbarkeit nutzt auch die
 * QR-Gebietsbindung (qrErstellenCore) diese Abdeckungs-Prüfung — ein Verifier
 * darf QR-Codes nur für Knoten erstellen, die sein Rollen-Pfad abdeckt.
 */
export function pfadDecktAb(anc: string, node: string): boolean {
  return node === anc || node.startsWith(anc + ".");
}

/**
 * Sieht ein `beobachter` mit diesen Rollen ein Objekt am Knoten `objPath`?
 * REINE Funktion, fail-closed:
 *
 *   - Betrachtet werden AUSSCHLIESSLICH `beobachter`-Rollen — Admin-/
 *     Redaktions-Sichtbarkeit läuft weiterhin über die bestehenden Achsen.
 *   - Ein Beobachter-Knoten deckt sein eigenes Gebiet UND alle Nachfahren ab
 *     (Kreis-Beobachter sieht Gemeinde-/Ortsteil-Objekte); Vorfahr-oder-Selbst
 *     im ltree-Sinn (`beobachter.path @> obj.path`). Das ersetzt strukturell die
 *     alte „höherer Scope deckt niedrigere ab"-Rang-Logik — inkl. korrektem
 *     Ortsteil-Verhalten (ein Ortsteil-Beobachter sieht nur SEINEN Ortsteil,
 *     keine Nachbarorte, keine stadtweiten Objekte).
 */
export function beobachterDarfSehen(
  rollen: RoleScopeRow[],
  objPath: string,
): boolean {
  return rollen.some(
    (r) => r.roleType === "beobachter" && pfadDecktAb(r.regionPath, objPath),
  );
}

/**
 * Sieht ein `beobachter` die tenant-weiten (Gemeinde-Ebene) Objekte — z. B.
 * Digest-Entwürfe? Das ist genau dann der Fall, wenn er einen Beobachter-Knoten
 * ab Gemeinde-Ebene aufwärts hat (Gebietsart != ortsteil): innerhalb eines
 * Tenants liegen alle Beobachter-Knoten auf dessen vertikalem Pfad, also deckt
 * jeder Nicht-Ortsteil-Knoten den Gemeinde-Knoten ab. Ein reiner Ortsteil-
 * Beobachter sieht keine tenant-weiten Objekte (fail-closed).
 */
export function beobachterDarfTenantweitSehen(rollen: RoleScopeRow[]): boolean {
  return rollen.some(
    (r) => r.roleType === "beobachter" && r.regionTyp !== "ortsteil",
  );
}

/**
 * Lädt die Rollen eines aktiven Users MIT Gebietsknoten (für die Beobachter-
 * Sichtbarkeit). Gleiche Eskalationsgrenze wie getUserRoleTypes:
 * gesperrte/gelöschte Konten erhalten [] (innerer JOIN auf users.active).
 */
export async function getUserRolesMitScope(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<RoleScopeRow[]> {
  const rows = await db
    .select({
      roleType: roles.roleType,
      regionTyp: regions.typ,
      regionPath: sql<string>`${regions.path}::text`,
    })
    .from(roles)
    .innerJoin(users, eq(users.id, roles.userId))
    .innerJoin(regions, eq(regions.id, roles.regionId))
    .where(
      and(
        eq(roles.tenantId, tenantId),
        eq(roles.userId, userId),
        eq(users.accountStatus, "active"),
      ),
    );
  return rows as RoleScopeRow[];
}

/**
 * Erlaubte QR-Eingabe-Ebenen je Gebietsart des Rollen-Knotens (Block K1):
 * die Ebene des eigenen Knotens und alles DARUNTER (ein Kreis-Verifier darf
 * kreis-, stadt- und ortsteil-QRs erstellen; ein Ortsteil-Verifier nur
 * ortsteil). Mapping Gebietsart→Eingabe-Ebene: `gemeinde` → „stadt";
 * `bund` deckt alle vier Eingabe-Ebenen ab (Bund selbst ist keine Ebene).
 */
const SCOPE_EBENEN_JE_REGION_TYP: Record<string, ScopeInputLevel[]> = {
  ortsteil: ["ortsteil"],
  gemeinde: ["ortsteil", "stadt"],
  kreis: ["ortsteil", "stadt", "kreis"],
  land: ["ortsteil", "stadt", "kreis", "land"],
  bund: ["ortsteil", "stadt", "kreis", "land"],
};

/**
 * Welche QR-Eingabe-Ebenen darf ein Nicht-Admin-Verifier mit diesen Rollen im
 * Dropdown sehen? REINE Funktion, nur UI-KOMFORT — die eigentliche Durchsetzung
 * (inkl. „richtiger Ortsteil?") passiert serverseitig in qrErstellenCore über
 * den ltree-Pfad (pfadDecktAb). Betrachtet werden AUSSCHLIESSLICH
 * `verifier`-Rollen; unbekannte Gebietsarten zählen nicht (fail-closed).
 */
export function erlaubteScopeEbenenFuerVerifier(
  rollen: RoleScopeRow[],
): ScopeInputLevel[] {
  const erlaubt = new Set<ScopeInputLevel>();
  for (const r of rollen) {
    if (r.roleType !== "verifier") continue;
    for (const ebene of SCOPE_EBENEN_JE_REGION_TYP[r.regionTyp] ?? []) {
      erlaubt.add(ebene);
    }
  }
  // Stabile Anzeige-Reihenfolge (lokal → grob), unabhängig von der Rollen-Reihenfolge.
  return (["ortsteil", "stadt", "kreis", "land"] as const).filter((e) =>
    erlaubt.has(e),
  );
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
  "beobachter",
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
  // View-Only-Rolle für Multiplikatoren — Vergabe wie redakteur durch
  // kommune_admin erlaubt. `beobachter` selbst darf NIEMALS Rollen verwalten
  // (canManageRole kennt nur Admin-Caller); Eskalationsgrenze unverändert.
  "beobachter",
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
