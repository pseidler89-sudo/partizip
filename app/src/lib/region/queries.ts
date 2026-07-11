/**
 * region/queries.ts — Lese-Auflösung des PLZ-/Standort-Einstiegs (ADR-015).
 *
 * BEWUSST ohne "use server" (analog polls/queries.ts): reine, lesende DB-Zugriffe
 * für Server-Komponenten/Actions. Würden sie in einer "use server"-Datei liegen,
 * wären es client-aufrufbare RPC-Endpunkte (Gate-B MAJOR-G).
 *
 * Die Auflösung ist NICHT tenant-scoped, sondern global (plz/Standort → Tenant) —
 * das ist das skalierfähige Backbone (mehrere Kommunen). Der Aufrufer gleicht das
 * Ergebnis gegen den aktuellen Host-Tenant ab.
 */

import { and, eq, isNotNull, asc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { plzRegionen, ortsteile } from "@/db/schema";
import { haversineKm, normalizePlz, STANDORT_MAX_KM } from "@/lib/region/core";

export interface RegionTreffer {
  tenantId: string;
  /** Default-Ortsteil-Code der Region (i. d. R. null → Stadt-Ebene). */
  ortsteilCode: string | null;
}

export interface RegionKoordinatenTreffer extends RegionTreffer {
  distanceKm: number;
}

/**
 * Löst eine PLZ zu ihrer Region (Tenant + Default-Ortsteil) auf.
 * Mehrere Zeilen je PLZ möglich (Stadt-Zeile + feinere Ortsteil-Zeilen): die
 * Stadt-Zeile (ortsteil_code NULL) wird bevorzugt, sonst die erste. null, wenn
 * die PLZ keiner teilnehmenden Region zugeordnet ist.
 */
export async function resolveRegionByPlz(
  db: Db,
  plzInput: string
): Promise<RegionTreffer | null> {
  const plz = normalizePlz(plzInput);
  if (plz.length === 0) return null;

  const rows = await db
    .select({ tenantId: plzRegionen.tenantId, ortsteilCode: plzRegionen.ortsteilCode })
    .from(plzRegionen)
    .where(eq(plzRegionen.plz, plz));

  if (rows.length === 0) return null;
  // Stadt-Ebene (ortsteil_code NULL) bevorzugen — den Ortsteil wählt der Bürger
  // anschließend selbst.
  const stadt = rows.find((r: RegionTreffer) => r.ortsteilCode == null);
  return stadt ?? rows[0];
}

/**
 * Löst Koordinaten (Standort-Freigabe) zur nächstgelegenen Region auf, sofern sie
 * innerhalb von maxKm liegt. Reine Haversine-Nähe gegen die Regions-Zentren in
 * plz_regionen (kein externer Geocoder). null, wenn nichts in Reichweite ist.
 */
export async function resolveRegionByCoords(
  db: Db,
  lat: number,
  lon: number,
  maxKm: number = STANDORT_MAX_KM
): Promise<RegionKoordinatenTreffer | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const rows = await db
    .select({
      tenantId: plzRegionen.tenantId,
      ortsteilCode: plzRegionen.ortsteilCode,
      lat: plzRegionen.lat,
      lon: plzRegionen.lon,
    })
    .from(plzRegionen)
    .where(and(isNotNull(plzRegionen.lat), isNotNull(plzRegionen.lon)));

  let best: RegionKoordinatenTreffer | null = null;
  for (const r of rows) {
    // numeric kommt als string aus dem Treiber → parsen.
    const rlat = Number(r.lat);
    const rlon = Number(r.lon);
    if (!Number.isFinite(rlat) || !Number.isFinite(rlon)) continue;
    const distanceKm = haversineKm(lat, lon, rlat, rlon);
    if (best == null || distanceKm < best.distanceKm) {
      best = { tenantId: r.tenantId, ortsteilCode: r.ortsteilCode, distanceKm };
    }
  }

  if (best == null || best.distanceKm > maxKm) return null;
  return best;
}

export interface OrtsteilOption {
  code: string;
  name: string;
}

/** Ortsteile eines Tenants (für das Auswahl-Dropdown), alphabetisch nach Name. */
export async function getOrtsteileForTenant(
  db: Db,
  tenantId: string
): Promise<OrtsteilOption[]> {
  return db
    .select({ code: ortsteile.code, name: ortsteile.name })
    .from(ortsteile)
    .where(eq(ortsteile.tenantId, tenantId))
    .orderBy(asc(ortsteile.name));
}

/** Prüft, ob ein Ortsteil-Code zum Tenant gehört (Validierung der Cookie-Wahl). */
export async function ortsteilCodeGehoertZuTenant(
  db: Db,
  tenantId: string,
  code: string
): Promise<boolean> {
  const rows = await db
    .select({ id: ortsteile.id })
    .from(ortsteile)
    .where(and(eq(ortsteile.tenantId, tenantId), eq(ortsteile.code, code)))
    .limit(1);
  return rows.length > 0;
}
