/**
 * gruppierung.ts — Polls nach geografischer Ebene gruppieren (ADR-015).
 *
 * Reine Funktion (kein DB/IO): macht „nach Ebene gekennzeichnet" konkret —
 * Ortsteil ⊂ Kommune ⊂ Kreis ⊂ Land ⊂ Bund. Genutzt von Landing + /umfragen.
 *
 * ADR-024 contract: die Ebene ist jetzt die Gebietsart des Knotens (regions.typ),
 * nicht mehr der entfernte scope_level. Labels/Reihenfolge in @/lib/region/ebenen.
 */

import {
  REGION_TYP_LABEL,
  REGION_TYP_ORDER,
  type RegionTyp,
} from "@/lib/region/ebenen";

export interface PollGruppe<T> {
  typ: RegionTyp;
  label: string;
  polls: T[];
}

/**
 * Gruppiert Polls nach Gebietsart (regions.typ) in fester Reihenfolge (lokal →
 * bundesweit); leere Ebenen entfallen. Generisch über alles, was ein `regionTyp`
 * trägt (PollListItem, PollMitErgebnis).
 */
export function gruppiereNachEbene<T extends { regionTyp: RegionTyp }>(
  polls: T[]
): PollGruppe<T>[] {
  return REGION_TYP_ORDER.map((typ) => ({
    typ,
    label: REGION_TYP_LABEL[typ],
    polls: polls.filter((p) => p.regionTyp === typ),
  })).filter((g) => g.polls.length > 0);
}
