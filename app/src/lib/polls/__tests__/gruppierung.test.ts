/**
 * gruppierung.test.ts — reine Unit-Tests für gruppiereNachEbene (ADR-015).
 */

import { describe, it, expect } from "vitest";
import { gruppiereNachEbene, SCOPE_LABEL } from "@/lib/polls/gruppierung";

type Item = { id: string; scopeLevel: "ortsteil" | "stadt" | "kreis" | "land" };

describe("polls/gruppierung", () => {
  it("gruppiert in fester Reihenfolge Ortsteil → Stadt → Kreis → Land", () => {
    const items: Item[] = [
      { id: "land1", scopeLevel: "land" },
      { id: "ot1", scopeLevel: "ortsteil" },
      { id: "stadt1", scopeLevel: "stadt" },
      { id: "kreis1", scopeLevel: "kreis" },
    ];
    const g = gruppiereNachEbene(items);
    expect(g.map((x) => x.level)).toEqual(["ortsteil", "stadt", "kreis", "land"]);
    expect(g.map((x) => x.label)).toEqual([
      SCOPE_LABEL.ortsteil,
      SCOPE_LABEL.stadt,
      SCOPE_LABEL.kreis,
      SCOPE_LABEL.land,
    ]);
  });

  it("lässt leere Ebenen weg", () => {
    const items: Item[] = [
      { id: "s1", scopeLevel: "stadt" },
      { id: "s2", scopeLevel: "stadt" },
    ];
    const g = gruppiereNachEbene(items);
    expect(g).toHaveLength(1);
    expect(g[0].level).toBe("stadt");
    expect(g[0].polls.map((p) => p.id)).toEqual(["s1", "s2"]);
  });

  it("erhält die Eingabereihenfolge innerhalb einer Ebene", () => {
    const items: Item[] = [
      { id: "a", scopeLevel: "ortsteil" },
      { id: "b", scopeLevel: "ortsteil" },
      { id: "c", scopeLevel: "ortsteil" },
    ];
    const g = gruppiereNachEbene(items);
    expect(g[0].polls.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("leere Eingabe → leeres Ergebnis", () => {
    expect(gruppiereNachEbene([])).toEqual([]);
  });
});
