/**
 * ebenen.ts — Gebietsart-Labels + Composer-Eingabe-Ebenen (ADR-024 contract).
 *
 * Nach dem contract-Schnitt (GEBIETSMODELL §4 Schritt 4) trägt keine Fachtabelle
 * mehr `scope_level`/`scope_code`; die geografische Ebene EINES OBJEKTS ergibt
 * sich ausschließlich aus seinem Gebietsknoten (`regions.typ`/`path`). Für die
 * ANZEIGE bildet {@link REGION_TYP_LABEL} die Gebietsart auf ein Ebenen-Label ab.
 *
 * Die Composer-EINGABE bleibt vorerst ein Ebenen-Wert (ortsteil/stadt/kreis/land)
 * — aber als reiner TS-Union-Type ({@link SCOPE_INPUT_LEVELS}), NICHT mehr als
 * DB-Enum. Serverseitig wird er via Gebietsbaum zu `region_id` aufgelöst
 * (resolveRegionIdForScope). Der Region-Picker (Baum-Auswahl, inkl. Bund) löst
 * dieses Dropdown in einer Folge-Etappe ab (GEBIETSMODELL §8/§9).
 */

import { regionTypEnum } from "@/db/schema";

/** Gebietsart eines Baum-Knotens (regions.typ). */
export type RegionTyp = (typeof regionTypEnum.enumValues)[number];

/** Composer-Eingabe-Ebenen — reiner TS-Union, serverseitig zu region_id aufgelöst. */
export const SCOPE_INPUT_LEVELS = ["ortsteil", "stadt", "kreis", "land"] as const;
export type ScopeInputLevel = (typeof SCOPE_INPUT_LEVELS)[number];

/** Menschliche Ebenen-Bezeichnung je Gebietsart (Singular). */
export const REGION_TYP_LABEL: Record<RegionTyp, string> = {
  bund: "Bund",
  land: "Land",
  kreis: "Kreis",
  gemeinde: "Kommune",
  ortsteil: "Ortsteil",
};

/** Anzeige-Reihenfolge: am lokalsten zuerst (Ortsteil → … → Bund). */
export const REGION_TYP_ORDER: readonly RegionTyp[] = [
  "ortsteil",
  "gemeinde",
  "kreis",
  "land",
  "bund",
];

/** Ebenen-Label einer Gebietsart (mit sicherem Fallback auf den Rohwert). */
export function regionTypLabel(typ: string): string {
  return REGION_TYP_LABEL[typ as RegionTyp] ?? typ;
}
