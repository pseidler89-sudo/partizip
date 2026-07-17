/**
 * seed-utils.ts — geteilte Helfer der Seed-Skripte.
 *
 * Deterministische UUID v5 (RFC 4122 name-based, SHA-1): natürlicher Schlüssel →
 * immer dieselbe UUID → idempotente Inserts über onConflictDoNothing/-Update.
 * Vorher in seed.ts und seed-demo.ts dupliziert — jetzt EINMAL in
 * src/lib/demo/seed-ids.ts (kanonische Quelle, weil auch Server-Actions die
 * Seed-IDs kennen müssen); hier nur RE-EXPORT, damit alle Skripte ihren
 * gewohnten Import behalten (KEINE Drift zwischen App und Skripten).
 */

import { sql, type SQL } from "drizzle-orm";

export { SEED_NAMESPACE, uuidV5 } from "../src/lib/demo/seed-ids.js";

/**
 * Löst eine Scope-Eingabe (Ebene + optionaler Code) über den Gebietsbaum zu einer
 * region_id auf (ADR-024 contract). Ruft dieselbe SQL-Funktion wie der frühere
 * Dual-Write-Trigger (`regions_resolve_region_id`, provision=true) — damit die
 * Seeds nach Wegfall des Triggers weiterhin nur über den Scope arbeiten können und
 * region_id explizit setzen. Voraussetzung: der Pilot-Baum ist geseedet
 * (scripts/seed-regions.ts) bzw. das Provisioning-Netz (GUC app.region_provision)
 * ist für die Ziel-DB freigegeben. Wirft, wenn der Scope nicht abbildbar ist.
 */
export async function resolveRegionId(
  db: { execute: (query: SQL) => Promise<unknown> },
  tenantId: string,
  scopeLevel: "ortsteil" | "stadt" | "kreis" | "land",
  scopeCode: string | null,
): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT regions_resolve_region_id(${tenantId}::uuid, ${scopeLevel}::text, ${scopeCode}, true) AS id`,
  )) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      `region_id nicht auflösbar für Scope (${scopeLevel}, ${scopeCode ?? "∅"}) — ist der Gebietsbaum geseedet?`,
    );
  }
  return id;
}
