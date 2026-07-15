/**
 * region/scope.ts — Brücke von der Scope-Eingabe (scope_level/scope_code) auf den
 * Gebietsbaum (ADR-024, GEBIETSMODELL §3.2, §4, ETAPPE 2).
 *
 * BEWUSST ohne "use server": reine, tenant-scoped DB-Helfer für Server-Actions,
 * Queries und Skripte (analog polls/queries.ts, region/tree.ts).
 *
 * Zwei Aufgaben:
 *   1. SCOPE→REGION_ID (ADR-024 contract): `resolveRegionIdForScope` leitet aus
 *      (tenant, Eingabe-Ebene, Code) die region_id ab — dieselbe Logik wie der
 *      Migrations-Backfill (die SQL-Funktion regions_resolve_region_id ist die
 *      Single Source of Truth; hier nur der Aufruf). Der Server setzt damit die
 *      EINZIGE Gebietsquelle — scope_level/scope_code existieren nicht mehr.
 *   2. LESE-SICHT: `resolveOrtsteilRegionId` bildet den Ortsteil-Code eines
 *      anonymen Cookie-Lesers auf seinen Ortsteil-Knoten ab (viewer_path der
 *      Standard-Sicht); rein lesend, KEIN Provisioning.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { regions } from "@/db/schema";
import type { ScopeInputLevel } from "@/lib/region/ebenen";

/**
 * Composer-Eingabe-Ebene (ADR-024 contract): früher der DB-Enum scope_level, jetzt
 * ein reiner TS-Union (@/lib/region/ebenen), serverseitig zu region_id aufgelöst.
 */
export type ScopeLevel = ScopeInputLevel;

/**
 * Leitet die region_id für einen Scope ab (Dual-Write). Delegiert an die
 * SQL-Funktion `regions_resolve_region_id(..., provision => true)` — identisch zu
 * Trigger und Backfill, damit App und DB nie divergieren. Wirft, wenn der Scope
 * nicht auf einen Knoten abbildbar ist (kein stilles NULL).
 *
 * provision=true wird durchgereicht, ist in PRODUKTION aber wirkungslos: das
 * Sicherheitsnetz (minimaler Pilot-Pfad für ungeseedete Tenants) ist zusätzlich per
 * GUC `app.region_provision` test/demo-gegated (Gate-B MINOR). In Produktion ist die
 * GUC ungesetzt → das Netz greift nie; ist der Baum (wie erwartet) geseedet, wird nur
 * aufgelöst, fehlt er, schlägt es HART fehl statt still einen Knoten anzulegen.
 */
export async function resolveRegionIdForScope(
  db: Db,
  tenantId: string,
  scopeLevel: ScopeLevel,
  scopeCode: string | null
): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT regions_resolve_region_id(${tenantId}::uuid, ${scopeLevel}::text, ${scopeCode}, true) AS id`
  )) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      `region_id konnte für Scope (${scopeLevel}, ${scopeCode ?? "∅"}) nicht abgeleitet werden`
    );
  }
  return id;
}

/**
 * Ortsteil-Code (aus dem Region-Cookie eines anonymen Lesers) → Ortsteil-Knoten
 * des Tenants. Rein lesend (KEIN Provisioning): unbekannter Code → null (der
 * Aufrufer fällt dann auf die tenant-weite obere Sicht zurück). Die Normalisierung
 * (regions_ltree_label) ist identisch zum Seed/Trigger, damit der Join hält.
 */
export async function resolveOrtsteilRegionId(
  db: Db,
  tenantId: string,
  ortsteilCode: string
): Promise<string | null> {
  const rows = await db
    .select({ id: regions.id })
    .from(regions)
    .where(
      sql`${regions.typ} = 'ortsteil'
          AND ${regions.pathLabel} = regions_ltree_label(${ortsteilCode})
          AND ${regions.parentId} = (
            SELECT g.id FROM regions g
            WHERE g.typ = 'gemeinde' AND g.tenant_id = ${tenantId}::uuid
            ORDER BY g.created_at LIMIT 1
          )`
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Gemeinde-Knoten eines Tenants (Stadt-Ebene, viewer_path-Fallback). Rein lesend
 * (KEIN Provisioning); null, wenn der Baum für den Tenant noch nicht geseedet ist.
 */
export async function resolveGemeindeRegionId(
  db: Db,
  tenantId: string
): Promise<string | null> {
  const rows = await db
    .select({ id: regions.id })
    .from(regions)
    .where(sql`${regions.typ} = 'gemeinde' AND ${regions.tenantId} = ${tenantId}::uuid`)
    .orderBy(regions.createdAt)
    .limit(1);
  return rows[0]?.id ?? null;
}
