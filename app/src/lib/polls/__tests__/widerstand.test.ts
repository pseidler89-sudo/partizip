/**
 * widerstand.test.ts — Unit-Tests für die Widerstandsabfrage-Kernlogik
 * (ADR-025): Validierung (inkl. Vollständigkeits-Invariante) + Aggregation
 * (Konsens-Sortierung, geringster Widerstand, Mindest-N-Zurückhaltung).
 */

import { describe, it, expect } from "vitest";
import {
  validateWiderstandsWerte,
  aggregateWiderstandsVotes,
  type WiderstandsWertRow,
} from "@/lib/polls/widerstand";
import { K_ANONYMITY_SCHWELLE } from "@/lib/polls/ergebnis";

const OPTS = [
  { id: "a", label: "Spielplatz", position: 0 },
  { id: "b", label: "Radweg", position: 1 },
  { id: "c", label: "Bücherei", position: 2 },
];
const IDS = new Set(["a", "b", "c"]);

describe("validateWiderstandsWerte", () => {
  it("akzeptiert eine vollständige Abgabe (alle Optionen bewertet)", () => {
    const r = validateWiderstandsWerte(
      [{ optionId: "a", wert: 0 }, { optionId: "b", wert: 5 }, { optionId: "c", wert: 10 }],
      IDS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 0-Werte werden NICHT gefiltert — vollständige Abgabe ist die Invariante.
      expect(r.werte).toEqual([
        { optionId: "a", wert: 0 },
        { optionId: "b", wert: 5 },
        { optionId: "c", wert: 10 },
      ]);
    }
  });

  it("akzeptiert wert 0 überall (überall „keine Einwände“ ist eine gültige Aussage)", () => {
    const r = validateWiderstandsWerte(
      [{ optionId: "a", wert: 0 }, { optionId: "b", wert: 0 }, { optionId: "c", wert: 0 }],
      IDS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.werte).toHaveLength(3);
  });

  it("lehnt eine unvollständige Abgabe ab (fehlende Option)", () => {
    const r = validateWiderstandsWerte(
      [{ optionId: "a", wert: 3 }, { optionId: "b", wert: 2 }],
      IDS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Bitte bewerten Sie jede Option (0 = keine Einwände).");
  });

  it("lehnt unbekannte Option ab", () => {
    expect(
      validateWiderstandsWerte(
        [{ optionId: "x", wert: 1 }, { optionId: "a", wert: 1 }, { optionId: "b", wert: 1 }],
        IDS,
      ).ok,
    ).toBe(false);
  });

  it("lehnt doppelte Option ab", () => {
    expect(
      validateWiderstandsWerte(
        [{ optionId: "a", wert: 1 }, { optionId: "a", wert: 2 }, { optionId: "b", wert: 1 }],
        IDS,
      ).ok,
    ).toBe(false);
  });

  it("lehnt Werte außerhalb 0..10 und Nicht-Ganzzahlen ab", () => {
    const mit = (wert: number) => [
      { optionId: "a", wert },
      { optionId: "b", wert: 1 },
      { optionId: "c", wert: 1 },
    ];
    expect(validateWiderstandsWerte(mit(11), IDS).ok).toBe(false);
    expect(validateWiderstandsWerte(mit(-1), IDS).ok).toBe(false);
    expect(validateWiderstandsWerte(mit(1.5), IDS).ok).toBe(false);
  });

  it("lehnt kaputte Eingabe ab", () => {
    expect(validateWiderstandsWerte("nope", IDS).ok).toBe(false);
    expect(validateWiderstandsWerte([{ optionId: 1, wert: 1 }], IDS).ok).toBe(false);
  });
});

/** Erzeugt vollständige Widerstands-Zeilen für N Wähler mit identischer Bewertung. */
function rows(nWaehler: number, bewertung: Record<string, number>, verif = false): WiderstandsWertRow[] {
  const out: WiderstandsWertRow[] = [];
  for (let i = 0; i < nWaehler; i++) {
    for (const [optionId, wert] of Object.entries(bewertung)) {
      out.push({ optionId, wert, voterRef: `v${i}`, warVerifiziert: verif });
    }
  }
  return out;
}

describe("aggregateWiderstandsVotes", () => {
  it("hält die Aufschlüsselung zurück, solange die Umfrage läuft (beendet=false)", () => {
    const e = aggregateWiderstandsVotes(rows(K_ANONYMITY_SCHWELLE, { a: 2, b: 5, c: 8 }), OPTS, false);
    expect(e.aufschluesselungZurueckgehalten).toBe(true);
    expect(e.zurueckhaltungsGrund).toBe("laeuft_noch");
    expect(e.gesamtWaehler).toBe(K_ANONYMITY_SCHWELLE); // Teilnahme bleibt sichtbar
    expect(e.optionen.every((o) => o.widerstandsSumme === null && o.mittelwert === null)).toBe(true);
    expect(e.optionen.every((o) => o.geringsterWiderstand === false)).toBe(true);
    // Bei Zurückhaltung nach Position sortiert (keine Rangfolge leaken).
    expect(e.optionen.map((o) => o.position)).toEqual([0, 1, 2]);
  });

  it("hält zurück bei < k Teilnehmenden trotz Ende", () => {
    const e = aggregateWiderstandsVotes(rows(K_ANONYMITY_SCHWELLE - 1, { a: 2, b: 5, c: 8 }), OPTS, true);
    expect(e.aufschluesselungZurueckgehalten).toBe(true);
    expect(e.zurueckhaltungsGrund).toBe("zu_wenige_teilnehmende");
    expect(e.gesamtWaehler).toBe(K_ANONYMITY_SCHWELLE - 1);
    expect(e.optionen.every((o) => o.widerstandsSumme === null)).toBe(true);
  });

  it("zeigt Summen/Mittelwerte ab k Teilnehmenden nach Ende, aufsteigend sortiert", () => {
    // 5 Wähler, alle: a=2, b=8, c=0 → Summen a=10, b=40, c=0 → Reihenfolge c, a, b.
    const e = aggregateWiderstandsVotes(rows(5, { a: 2, b: 8, c: 0 }), OPTS, true);
    expect(e.aufschluesselungZurueckgehalten).toBe(false);
    expect(e.gesamtWaehler).toBe(5);
    expect(e.optionen.map((o) => o.optionId)).toEqual(["c", "a", "b"]);
    const [c, a, b] = e.optionen;
    expect(c.widerstandsSumme).toBe(0);
    expect(c.mittelwert).toBe(0);
    expect(c.geringsterWiderstand).toBe(true); // geringster Gesamtwiderstand gewinnt
    expect(a.widerstandsSumme).toBe(10);
    expect(a.mittelwert).toBe(2);
    expect(a.geringsterWiderstand).toBe(false);
    expect(b.widerstandsSumme).toBe(40);
    expect(b.mittelwert).toBe(8);
    expect(b.geringsterWiderstand).toBe(false);
  });

  it("rundet den Mittelwert auf 1 Nachkommastelle", () => {
    // 3 Wähler ergäben < k → 6 Wähler: 4× wert 1, 2× wert 2 auf a → Ø 8/6 = 1,333… → 1,3.
    const r: WiderstandsWertRow[] = [];
    for (let i = 0; i < 6; i++) {
      const wa = i < 4 ? 1 : 2;
      r.push({ optionId: "a", wert: wa, voterRef: `m${i}`, warVerifiziert: false });
      r.push({ optionId: "b", wert: 5, voterRef: `m${i}`, warVerifiziert: false });
      r.push({ optionId: "c", wert: 5, voterRef: `m${i}`, warVerifiziert: false });
    }
    const e = aggregateWiderstandsVotes(r, OPTS, true);
    const a = e.optionen.find((o) => o.optionId === "a")!;
    expect(a.widerstandsSumme).toBe(8);
    expect(a.mittelwert).toBe(1.3);
  });

  it("markiert bei Gleichstand ALLE Optionen mit Minimal-Summe als geringster Widerstand", () => {
    // a und c beide Summe 10, b höher → beide Gewinner, Gleichstand nach Position.
    const e = aggregateWiderstandsVotes(rows(5, { a: 2, b: 7, c: 2 }), OPTS, true);
    const gewinner = e.optionen.filter((o) => o.geringsterWiderstand);
    expect(gewinner.map((o) => o.optionId)).toEqual(["a", "c"]); // Position-Tiebreak
    expect(e.optionen[0].optionId).toBe("a");
    expect(e.optionen.at(-1)!.optionId).toBe("b");
  });

  it("zählt Teilnahme + verifizierte Teilnehmende auf Poll-Ebene", () => {
    const gemischt = [
      ...rows(3, { a: 1, b: 2, c: 3 }, true).map((r, i) => ({ ...r, voterRef: `t${Math.floor(i / 3)}` })),
      ...rows(2, { a: 1, b: 2, c: 3 }, false).map((r, i) => ({ ...r, voterRef: `u${Math.floor(i / 3)}` })),
    ];
    const e = aggregateWiderstandsVotes(gemischt, OPTS, true);
    expect(e.gesamtWaehler).toBe(5);
    expect(e.verifizierteWaehler).toBe(3);
  });
});
