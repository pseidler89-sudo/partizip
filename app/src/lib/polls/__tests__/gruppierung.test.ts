/**
 * gruppierung.test.ts — reine Unit-Tests für gruppiereNachEbene (ADR-015).
 *
 * ADR-024 contract: gruppiert jetzt nach Gebietsart (regions.typ) statt scope_level.
 */

import { describe, it, expect } from "vitest";
import { gruppiereNachEbene } from "@/lib/polls/gruppierung";
import { REGION_TYP_LABEL, type RegionTyp } from "@/lib/region/ebenen";

type Item = { id: string; regionTyp: RegionTyp };

describe("polls/gruppierung", () => {
  it("gruppiert in fester Reihenfolge Ortsteil → Kommune → Kreis → Land → Bund", () => {
    const items: Item[] = [
      { id: "bund1", regionTyp: "bund" },
      { id: "land1", regionTyp: "land" },
      { id: "ot1", regionTyp: "ortsteil" },
      { id: "stadt1", regionTyp: "gemeinde" },
      { id: "kreis1", regionTyp: "kreis" },
    ];
    const g = gruppiereNachEbene(items);
    expect(g.map((x) => x.typ)).toEqual([
      "ortsteil",
      "gemeinde",
      "kreis",
      "land",
      "bund",
    ]);
    expect(g.map((x) => x.label)).toEqual([
      REGION_TYP_LABEL.ortsteil,
      REGION_TYP_LABEL.gemeinde,
      REGION_TYP_LABEL.kreis,
      REGION_TYP_LABEL.land,
      REGION_TYP_LABEL.bund,
    ]);
  });

  it("lässt leere Ebenen weg", () => {
    const items: Item[] = [
      { id: "s1", regionTyp: "gemeinde" },
      { id: "s2", regionTyp: "gemeinde" },
    ];
    const g = gruppiereNachEbene(items);
    expect(g).toHaveLength(1);
    expect(g[0].typ).toBe("gemeinde");
    expect(g[0].polls.map((p) => p.id)).toEqual(["s1", "s2"]);
  });

  it("erhält die Eingabereihenfolge innerhalb einer Ebene", () => {
    const items: Item[] = [
      { id: "a", regionTyp: "ortsteil" },
      { id: "b", regionTyp: "ortsteil" },
      { id: "c", regionTyp: "ortsteil" },
    ];
    const g = gruppiereNachEbene(items);
    expect(g[0].polls.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("leere Eingabe → leeres Ergebnis", () => {
    expect(gruppiereNachEbene([])).toEqual([]);
  });
});
