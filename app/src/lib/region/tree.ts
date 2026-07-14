/**
 * region/tree.ts — reine Lese-Primitive auf dem Gebietsbaum (ADR-024,
 * GEBIETSMODELL §3, §5).
 *
 * ETAPPE 1: nur die Baum-Primitive (Vorfahren-Kette, direkte Kinder, Nachfahren,
 * vertikale Scheibe). Rein lesend, tenant-UNABHÄNGIG auf dem globalen Baum —
 * `regions` ist tenant-frei (§3.1). Die spätere fachliche Nutzung
 * (Sichtbarkeits-Query, Zuständigkeit) ist tenant-scoped und Gegenstand von
 * Etappe 2; sie ändert an diesen Primitiven nichts.
 *
 * BEWUSST ohne "use server" (analog polls/queries.ts, region/queries.ts): reine
 * lesende DB-Zugriffe für Server-Komponenten/Actions/Skripte — kein
 * client-aufrufbarer RPC-Endpunkt.
 *
 * Die Ordnung nutzt den materialisierten ltree-Pfad (GiST-Index): `@>` liefert
 * Vorfahren (inkl. Selbst), `<@` liefert Nachfahren (inkl. Selbst); nlevel()
 * sortiert von der Wurzel (Bund) nach unten.
 */

import { eq, asc, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { regions } from "@/db/schema";

export type RegionRow = typeof regions.$inferSelect;

/** Ein Knoten per id, oder null. */
export async function getRegion(db: Db, id: string): Promise<RegionRow | null> {
  const rows = await db.select().from(regions).where(eq(regions.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Vorfahren-Kette OHNE den Knoten selbst, von der Wurzel (Bund) bis zum direkten
 * Elternknoten. Leer, wenn der Knoten die Wurzel ist oder nicht existiert.
 */
export async function getVorfahren(db: Db, id: string): Promise<RegionRow[]> {
  return db
    .select()
    .from(regions)
    .where(
      sql`${regions.path} @> (SELECT path FROM regions WHERE id = ${id}) AND ${regions.id} <> ${id}`
    )
    .orderBy(sql`nlevel(${regions.path})`);
}

/**
 * Direkte Kinder eines Knotens (eine Ebene tiefer), alphabetisch nach Name.
 */
export async function getKinder(db: Db, id: string): Promise<RegionRow[]> {
  return db
    .select()
    .from(regions)
    .where(eq(regions.parentId, id))
    .orderBy(asc(regions.name));
}

/**
 * Alle Nachfahren OHNE den Knoten selbst (ganzer Teilbaum darunter), von oben
 * nach unten sortiert (nlevel). Grundlage der Kreis-/Land-Aggregation (§5).
 */
export async function getNachfahren(db: Db, id: string): Promise<RegionRow[]> {
  return db
    .select()
    .from(regions)
    .where(
      sql`${regions.path} <@ (SELECT path FROM regions WHERE id = ${id}) AND ${regions.id} <> ${id}`
    )
    .orderBy(sql`nlevel(${regions.path})`);
}

/**
 * „Vertikale Scheibe": der Knoten selbst + alle Vorfahren (bis Bund) + seine
 * direkten Kinder. Das ist die Baum-Primitive hinter der Standard-Sicht
 * (GEBIETSMODELL §5) — die tenant-scoped Poll-Auflösung baut in Etappe 2 darauf
 * auf. Sortiert von der Wurzel nach unten (nlevel), Geschwister nach Name.
 */
export async function getVertikaleScheibe(
  db: Db,
  id: string
): Promise<RegionRow[]> {
  return db
    .select()
    .from(regions)
    .where(
      sql`(${regions.path} @> (SELECT path FROM regions WHERE id = ${id})) OR (${regions.parentId} = ${id})`
    )
    .orderBy(sql`nlevel(${regions.path})`, asc(regions.name));
}
