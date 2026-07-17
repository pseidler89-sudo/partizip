/**
 * dot.test.ts — Unit-Tests für Dot-/Budget-Voting-Kernlogik (ADR-025):
 * Validierung der Zuteilungen + Aggregation inkl. Mindest-N-Zurückhaltung.
 */

import { describe, it, expect } from "vitest";
import {
  validateDotAllocations,
  aggregateDotVotes,
  type DotOption,
  type DotAllocationRow,
} from "@/lib/polls/dot";
import { K_ANONYMITY_SCHWELLE } from "@/lib/polls/ergebnis";

const OPTS: DotOption[] = [
  { id: "a", label: "Spielplatz", position: 0 },
  { id: "b", label: "Radweg", position: 1 },
  { id: "c", label: "Bücherei", position: 2 },
];
const IDS = new Set(["a", "b", "c"]);

describe("validateDotAllocations", () => {
  it("akzeptiert eine gültige Verteilung ≤ Budget und filtert 0-Punkte", () => {
    const r = validateDotAllocations(
      [{ optionId: "a", punkte: 3 }, { optionId: "b", punkte: 0 }, { optionId: "c", punkte: 2 }],
      IDS, 10,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allocations).toEqual([{ optionId: "a", punkte: 3 }, { optionId: "c", punkte: 2 }]);
  });

  it("lehnt Überschreitung des Budgets ab", () => {
    const r = validateDotAllocations([{ optionId: "a", punkte: 7 }, { optionId: "b", punkte: 5 }], IDS, 10);
    expect(r.ok).toBe(false);
  });

  it("lehnt unbekannte Option ab", () => {
    expect(validateDotAllocations([{ optionId: "x", punkte: 1 }], IDS, 10).ok).toBe(false);
  });

  it("lehnt doppelte Option ab", () => {
    expect(validateDotAllocations([{ optionId: "a", punkte: 1 }, { optionId: "a", punkte: 1 }], IDS, 10).ok).toBe(false);
  });

  it("lehnt negative/nicht-ganzzahlige Punkte ab", () => {
    expect(validateDotAllocations([{ optionId: "a", punkte: -1 }], IDS, 10).ok).toBe(false);
    expect(validateDotAllocations([{ optionId: "a", punkte: 1.5 }], IDS, 10).ok).toBe(false);
  });

  it("lehnt eine leere Stimme ab (kein Punkt vergeben)", () => {
    expect(validateDotAllocations([{ optionId: "a", punkte: 0 }], IDS, 10).ok).toBe(false);
    expect(validateDotAllocations([], IDS, 10).ok).toBe(false);
  });

  it("lehnt kaputte Eingabe ab", () => {
    expect(validateDotAllocations("nope", IDS, 10).ok).toBe(false);
    expect(validateDotAllocations([{ optionId: 1, punkte: 1 }], IDS, 10).ok).toBe(false);
  });
});

/** Erzeugt Zuteilungs-Zeilen für N Wähler mit identischer Verteilung. */
function rows(nWaehler: number, verteilung: Record<string, number>, verif = false): DotAllocationRow[] {
  const out: DotAllocationRow[] = [];
  for (let i = 0; i < nWaehler; i++) {
    for (const [optionId, punkte] of Object.entries(verteilung)) {
      if (punkte > 0) out.push({ optionId, punkte, voterRef: `v${i}`, warVerifiziert: verif });
    }
  }
  return out;
}

describe("aggregateDotVotes", () => {
  it("hält die Aufschlüsselung zurück, solange die Umfrage läuft (beendet=false)", () => {
    const e = aggregateDotVotes(rows(K_ANONYMITY_SCHWELLE, { a: 5, b: 5 }), OPTS, 10, false);
    expect(e.aufschluesselungZurueckgehalten).toBe(true);
    expect(e.zurueckhaltungsGrund).toBe("laeuft_noch");
    expect(e.gesamtWaehler).toBe(K_ANONYMITY_SCHWELLE); // Teilnahme bleibt sichtbar
    expect(e.optionen.every((o) => o.punkteSumme === null)).toBe(true);
  });

  it("hält zurück bei < k Teilnehmenden trotz Ende", () => {
    const e = aggregateDotVotes(rows(K_ANONYMITY_SCHWELLE - 1, { a: 6, b: 4 }), OPTS, 10, true);
    expect(e.aufschluesselungZurueckgehalten).toBe(true);
    expect(e.zurueckhaltungsGrund).toBe("zu_wenige_teilnehmende");
    expect(e.gesamtWaehler).toBe(K_ANONYMITY_SCHWELLE - 1);
    expect(e.optionen.every((o) => o.punkteSumme === null)).toBe(true);
  });

  it("zeigt die Verteilung ab k Teilnehmenden nach Ende (alle Optionen ≥ k)", () => {
    // 5 Wähler, je 6 auf a UND 4 auf b → waehler(a)=waehler(b)=5 ≥ k, c=0.
    const e = aggregateDotVotes(rows(5, { a: 6, b: 4 }), OPTS, 10, true);
    expect(e.aufschluesselungZurueckgehalten).toBe(false);
    expect(e.gesamtWaehler).toBe(5);
    const a = e.optionen.find((o) => o.optionId === "a")!;
    const b = e.optionen.find((o) => o.optionId === "b")!;
    const c = e.optionen.find((o) => o.optionId === "c")!;
    expect(a.maskiert).toBe(false);
    expect(a.punkteSumme).toBe(30);
    expect(b.punkteSumme).toBe(20);
    expect(c.punkteSumme).toBe(0); // niemand → 0, nicht maskiert
    expect(a.prozent).toBe(60);
    expect(b.prozent).toBe(40);
  });

  it("zählt Teilnahme + verifizierte Teilnehmende auf Poll-Ebene", () => {
    const gemischt = [
      ...rows(3, { a: 10 }, true),
      ...rows(2, { b: 10 }, false),
    ].map((r, i) => ({ ...r, voterRef: `u${i}` }));
    const e = aggregateDotVotes(gemischt, OPTS, 10, true);
    expect(e.gesamtWaehler).toBe(5);
    expect(e.verifizierteWaehler).toBe(3);
  });

  it("B1: maskiert Optionen mit 1..k-1 Wählern (zwei kleine Gruppen)", () => {
    // 4 Wähler auf a, 1 auf b → 5 distinct Wähler; waehler(a)=4<k, waehler(b)=1<k.
    const r = [
      ...rows(4, { a: 5 }).map((x, i) => ({ ...x, voterRef: `a${i}` })),
      ...rows(1, { b: 5 }).map((x, i) => ({ ...x, voterRef: `b${i}` })),
    ];
    const e = aggregateDotVotes(r, OPTS, 10, true);
    expect(e.aufschluesselungZurueckgehalten).toBe(false); // gesamt 5 ≥ k
    const a = e.optionen.find((o) => o.optionId === "a")!;
    const b = e.optionen.find((o) => o.optionId === "b")!;
    expect(a.maskiert).toBe(true);
    expect(a.punkteSumme).toBeNull();
    expect(b.maskiert).toBe(true);
  });

  it("B1: komplementäre Maskierung — genau eine kleine Gruppe zieht eine zweite mit", () => {
    // 6 Wähler: 5 nur auf a (waehler 5, sichtbar), 1 nur auf b (waehler 1, maskiert).
    // Nur b wäre maskiert → aus gesamt − sichtbar rekonstruierbar → a wird mitmaskiert.
    const r = [
      ...rows(5, { a: 4 }).map((x, i) => ({ ...x, voterRef: `p${i}` })),
      ...rows(1, { b: 4 }).map((x, i) => ({ ...x, voterRef: `q${i}` })),
    ];
    const e = aggregateDotVotes(r, OPTS, 10, true);
    const a = e.optionen.find((o) => o.optionId === "a")!;
    const b = e.optionen.find((o) => o.optionId === "b")!;
    const c = e.optionen.find((o) => o.optionId === "c")!;
    expect(b.maskiert).toBe(true);
    expect(a.maskiert).toBe(true); // komplementär mitmaskiert
    expect(c.maskiert).toBe(false); // 0 Wähler → sichtbar (0)
  });

  it("sortiert Optionen nach Position", () => {
    const e = aggregateDotVotes(rows(5, { a: 5, b: 5 }), OPTS, 10, true);
    expect(e.optionen.map((o) => o.position)).toEqual([0, 1, 2]);
  });
});
