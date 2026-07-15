/**
 * seed-utils.ts — geteilte Helfer der Seed-Skripte.
 *
 * Deterministische UUID v5 (RFC 4122 name-based, SHA-1): natürlicher Schlüssel →
 * immer dieselbe UUID → idempotente Inserts über onConflictDoNothing/-Update.
 * Vorher in seed.ts und seed-demo.ts dupliziert — hier EINMAL.
 */

import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

/** Namespace-UUID der Seed-Skripte (UUID-v5 DNS namespace, RFC 4122). */
export const SEED_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

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

export function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const sha1 = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(name, "utf-8")]))
    .digest();
  sha1[6] = (sha1[6] & 0x0f) | 0x50; // version 5
  sha1[8] = (sha1[8] & 0x3f) | 0x80; // variant 10
  const hex = sha1.toString("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
