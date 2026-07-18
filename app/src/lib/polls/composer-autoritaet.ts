/**
 * composer-autoritaet.ts — Gebiets-Autorität der Poll-Erstellung & -Verwaltung (Block H).
 *
 * BEWUSST OHNE "use server" (Muster: qr-core.ts, region/tree.ts, region/scope.ts):
 * rein lesende, testbare Helfer, die db/tenantId/scopes als PARAMETER nehmen. Damit
 * sind sie 1. von den "use server"-Actions (polls/actions.ts) wiederverwendbar und
 * 2. in DB-Integrationstests als ECHTE Funktionen aufrufbar (keine gespiegelte Logik).
 *
 * KERNBEFUND (die Lücke, die H schließt): `pollErstellen` gated bisher nur über
 * `requireAdminCtx()` → „irgendein Admin des Tenants" — und VERWIRFT die
 * Rollen-Gebiete. Ein präparierter Request eines Gemeinde-Admins mit
 * `scopeLevel:"kreis"` konnte so kreis-/land-Polls anlegen. H zieht — analog zur
 * QR-Gebietsbindung (qr-core.ts K1) — die `pfadDecktAb`-Prüfung ein.
 *
 * PRODUKTENTSCHEIDE (Spec H, bindend):
 *   1. Autorität = vertikale Scheibe ABWÄRTS vom eigenen `roles.region_id` (ltree-`@>`).
 *      Ein kommune_admin (Gemeinde-Anker) darf stadt + seine Ortsteile — NICHT kreis/land.
 *   2. super_admin bypasst die Gebietsbindung; der Picker-Feed bleibt aber auf die
 *      Tenant-Gemeinde-Scheibe (H erstellt keine kreis/land/bund-Polls — das ist das
 *      Separate-Tenant-Modell, PR #49).
 *   3. Anker aus `getUserRolesMitScope` (nicht „Admin = immer Gemeinde"): ein per
 *      super_admin unterhalb angelegter Ortsteil-Admin ist nur auf seinen Ortsteil
 *      berechtigt.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { polls, regions } from "@/db/schema";
import { pfadDecktAb, type RoleScopeRow } from "@/lib/auth/roles";
import { getRegion, getNachfahren } from "@/lib/region/tree";
import {
  resolveGemeindeRegionId,
  resolveOrtsteilCodeForRegionId,
} from "@/lib/region/scope";
import type { ScopeInputLevel } from "@/lib/region/ebenen";

/**
 * Rollen, die eine Poll ERSTELLEN/VERWALTEN dürfen — an ihren eigenen Rollen-Pfad
 * gebunden (super_admin wird separat via `istSuperAdmin` bypassed). kommune_admin
 * ist der Regelfall; die Reserve-Admins (ortsteil/kreis/land_admin) sind im Pilot
 * nicht vergeben, hier aber vollständigkeitshalber gebietsgebunden mitgeführt.
 * redakteur/verifier/beobachter erstellen KEINE Polls (das prüft `isAdmin`
 * vorgelagert in requireAdminCtx).
 */
export const POLL_AUTORITAET_ROLLEN = [
  "kommune_admin",
  "super_admin",
  "ortsteil_admin",
  "kreis_admin",
  "land_admin",
] as const;

/**
 * Darf ein Caller mit diesen Rollen-Gebieten eine Poll für den Knoten `zielPath`
 * erstellen/verwalten? REINE Funktion, fail-closed (Muster qr-core.ts):
 *
 *   - super_admin → true (Plattform-Betreiber/Eskalation; Gebietsbindung entfällt).
 *   - sonst: mindestens EINE Poll-Autoritäts-Rolle, deren ltree-Pfad `zielPath`
 *     abdeckt (Vorfahr-oder-Selbst — ein Gemeinde-Anker deckt seine Ortsteile mit).
 *
 * `scopes` stammt aus `getUserRolesMitScope` (tenant-scoped + account_status-
 * gefiltert) — Rollen fremder Tenants/gesperrter Konten zählen strukturell nicht.
 */
export function pollGebietErlaubt(
  scopes: RoleScopeRow[],
  istSuperAdmin: boolean,
  zielPath: string,
): boolean {
  if (istSuperAdmin) return true;
  return scopes.some(
    (r) =>
      (POLL_AUTORITAET_ROLLEN as readonly string[]).includes(r.roleType) &&
      pfadDecktAb(r.regionPath, zielPath),
  );
}

/** Ableitung `istSuperAdmin` aus den geladenen Rollen-Scopes (eine Quelle). */
export function istSuperAdminScope(scopes: RoleScopeRow[]): boolean {
  return scopes.some((r) => r.roleType === "super_admin");
}

/** Ein wählbares Ziel-Gebiet im Composer-Picker (server-getriebener Feed). */
export interface ZielGebiet {
  regionId: string;
  /** Immer 'gemeinde' oder 'ortsteil' — H bleibt abwärts, nie kreis/land. */
  typ: "gemeinde" | "ortsteil";
  path: string;
  /** Anzeige-Name des Knotens (Gemeinde- bzw. Ortsteil-Name). */
  label: string;
  /** Composer-Eingabe-Paar für resolveRegionIdForScope (H bleibt bei stadt/ortsteil). */
  scopeLevel: Extract<ScopeInputLevel, "stadt" | "ortsteil">;
  scopeCode: string | null;
}

/**
 * Der Picker-Feed: welche Gebiete darf dieser Caller im Composer wählen?
 *
 * Anker = Tenant-Gemeinde-Knoten (`resolveGemeindeRegionId`). Kandidaten =
 * Gemeinde-Knoten + `getNachfahren(gemeinde)`, GEFILTERT auf typ ∈ {gemeinde,
 * ortsteil} (H bleibt bewusst abwärts — kreis/land haben `tenant_id=NULL` und
 * bleiben dem Separate-Tenant-Modell vorbehalten). Davon nur die, für die
 * `pollGebietErlaubt` gilt. Jeder Eintrag trägt das Composer-Eingabe-Paar:
 * Gemeinde → {scopeLevel:"stadt", scopeCode:null}; Ortsteil → {scopeLevel:
 * "ortsteil", scopeCode:<code>}. Ohne Ortsteil-Code (kein `ortsteile`-Eintrag)
 * ist der Knoten nicht adressierbar → fail-closed übersprungen.
 *
 * Ist der Baum für den Tenant (noch) nicht geseedet, liefert die Funktion [].
 * Sortierung: Gemeinde zuerst, dann Ortsteile alphabetisch (stabile Anzeige).
 */
export async function erlaubteZielGebiete(
  db: Db,
  tenantId: string,
  scopes: RoleScopeRow[],
  istSuperAdmin: boolean,
): Promise<ZielGebiet[]> {
  const gemeindeId = await resolveGemeindeRegionId(db, tenantId);
  if (!gemeindeId) return [];

  const gemeinde = await getRegion(db, gemeindeId);
  if (!gemeinde || !gemeinde.path) return [];

  const nachfahren = await getNachfahren(db, gemeindeId);
  const kandidaten = [gemeinde, ...nachfahren].filter(
    (r) => r.typ === "gemeinde" || r.typ === "ortsteil",
  );

  const ergebnis: ZielGebiet[] = [];
  for (const r of kandidaten) {
    if (!r.path) continue;
    if (!pollGebietErlaubt(scopes, istSuperAdmin, r.path)) continue;

    if (r.typ === "gemeinde") {
      ergebnis.push({
        regionId: r.id,
        typ: "gemeinde",
        path: r.path,
        label: r.name,
        scopeLevel: "stadt",
        scopeCode: null,
      });
    } else {
      const code = await resolveOrtsteilCodeForRegionId(db, tenantId, r.id);
      if (!code) {
        // Ohne Code nicht via (scopeLevel,scopeCode) adressierbar → fail-closed
        // überspringen. In Prod folgenlos (Ortsteil-Knoten stammen aus ortsteile.json,
        // Round-Trip garantiert), aber beobachtbar machen, falls Baum und
        // ortsteile-Tabelle je divergieren (Normalisierung/manueller Knoten).
        console.warn(
          `[composer-autoritaet] Ortsteil-Knoten ohne ortsteile-Code übersprungen: regionId=${r.id} path=${r.path}`,
        );
        continue;
      }
      ergebnis.push({
        regionId: r.id,
        typ: "ortsteil",
        path: r.path,
        label: r.name,
        scopeLevel: "ortsteil",
        scopeCode: code,
      });
    }
  }

  ergebnis.sort((a, b) => {
    if (a.typ !== b.typ) return a.typ === "gemeinde" ? -1 : 1;
    return a.label.localeCompare(b.label, "de");
  });
  return ergebnis;
}

/**
 * Autoritäts-Vorprüfung für die Poll-VERWALTUNG (aktivieren/schließen/löschen):
 * lädt den Gebiets-Pfad der Poll (tenant-scoped Join auf regions) und prüft
 * `pollGebietErlaubt` gegen `poll.region_id`. Symmetrisch zur Erstellung — ein
 * gebietsgebundener Admin darf keine Poll AUSSERHALB seines Gebiets verändern.
 *
 * Existiert die Poll (im Tenant) nicht, liefert die Funktion `true`: dann
 * übernimmt der bestehende Status-/Existenz-/Tenant-Guard der Action die
 * freundliche „nicht gefunden"-Meldung — kein Existenz-Orakel, keine
 * Doppel-Meldung. Fehlt (wider Erwarten) der Gebiets-Pfad, ist es fail-closed
 * false.
 */
export async function pollVerwaltungErlaubt(
  db: Db,
  tenantId: string,
  pollId: string,
  scopes: RoleScopeRow[],
  istSuperAdmin: boolean,
): Promise<boolean> {
  const rows = await db
    .select({ path: sql<string>`${regions.path}::text` })
    .from(polls)
    .innerJoin(regions, eq(regions.id, polls.regionId))
    .where(and(eq(polls.id, pollId), eq(polls.tenantId, tenantId)))
    .limit(1);
  if (rows.length === 0) return true; // Poll im Tenant nicht vorhanden → Standard-Guard.
  const zielPath = rows[0].path;
  // regions.path ist im Schema nullable (Trigger setzt es real immer); ein
  // NULL-Pfad wäre eine Datenanomalie → fail-closed ablehnen statt pfadDecktAb(…,null)
  // (TypeError). null-sicher wie der Erstellungs-Pfad (`!zielPath`).
  if (!zielPath) return false;
  return pollGebietErlaubt(scopes, istSuperAdmin, zielPath);
}
