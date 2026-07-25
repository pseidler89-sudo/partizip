/**
 * seed-formate.test.ts — maschinelle Invarianten-Prüfung der kuratierten
 * Format-Seed-Daten (P1 „Demo-Alleinstellung", scripts/seed-demo.ts).
 *
 * Prüft mit den ECHTEN Produktions-Validatoren (dot.ts/widerstand.ts), dass die
 * Seed-Definitionen genau die Abgaben erzeugen, die auch die Server Actions
 * akzeptieren würden — insbesondere die Vollständigkeits-Invariante der
 * Widerstandsabfrage (JEDE Option von JEDEM Wähler bewertet, 0-Werte werden
 * gespeichert) und die k-Anonymität (Teilnehmerzahl deutlich über k; jede
 * Dot-Option von ≥ k Wählern bedacht → keine per-Option-Maskierung im Demo).
 * Reine Funktionen, keine DB nötig.
 */

import { describe, it, expect } from "vitest";
import {
  DEMO_DOT_BUDGET,
  DEMO_DOT_OPTIONEN,
  DEMO_DOT_VERTEILUNGEN,
  DEMO_DOT_ABGESCHLOSSEN_BUDGET,
  DEMO_DOT_ABGESCHLOSSEN_OPTIONEN,
  DEMO_DOT_ABGESCHLOSSEN_VERTEILUNGEN,
  DEMO_WIDERSTAND_OPTIONEN,
  DEMO_WIDERSTAND_WERTE,
  demoDotVoterRef,
  demoDotAbgeschlossenVoterRef,
  demoWiderstandVoterRef,
} from "@/lib/demo/seed-formate";
import { validateDotAllocations, DOT_OPTIONEN_MIN, DOT_OPTIONEN_MAX } from "@/lib/polls/dot";
import { validateWiderstandsWerte, WIDERSTAND_MAX } from "@/lib/polls/widerstand";
import { K_ANONYMITY_SCHWELLE } from "@/lib/polls/ergebnis";

// Synthetische Options-IDs in position-Reihenfolge (die Validatoren prüfen nur
// gegen die ID-Menge — der Seed nutzt deterministische uuid5-IDs analog).
const dotOptionIds = DEMO_DOT_OPTIONEN.map((_, i) => `dot-opt-${i}`);
const widerstandOptionIds = DEMO_WIDERSTAND_OPTIONEN.map((_, i) => `w-opt-${i}`);

describe("demo/seed-formate — Dot-Voting", () => {
  it("Optionsanzahl liegt in den Composer-Grenzen", () => {
    expect(DEMO_DOT_OPTIONEN.length).toBeGreaterThanOrEqual(DOT_OPTIONEN_MIN);
    expect(DEMO_DOT_OPTIONEN.length).toBeLessThanOrEqual(DOT_OPTIONEN_MAX);
  });

  it("jede Seed-Verteilung passiert den Produktions-Validator und schöpft das Budget exakt aus", () => {
    for (const verteilung of DEMO_DOT_VERTEILUNGEN) {
      expect(verteilung).toHaveLength(DEMO_DOT_OPTIONEN.length);
      const input = verteilung.map((punkte, i) => ({ optionId: dotOptionIds[i], punkte }));
      const res = validateDotAllocations(input, new Set(dotOptionIds), DEMO_DOT_BUDGET);
      expect(res.ok).toBe(true);
      // „Vollständige Verteilung": das Budget wird komplett vergeben (nicht nur ≤).
      expect(verteilung.reduce((a, b) => a + b, 0)).toBe(DEMO_DOT_BUDGET);
    }
  });

  it("Teilnehmerzahl liegt DEUTLICH über der k-Schwelle; jede Option wird von ≥ k Wählern bedacht", () => {
    expect(DEMO_DOT_VERTEILUNGEN.length).toBeGreaterThanOrEqual(3 * K_ANONYMITY_SCHWELLE);
    for (let opt = 0; opt < DEMO_DOT_OPTIONEN.length; opt++) {
      const waehler = DEMO_DOT_VERTEILUNGEN.filter((v) => v[opt] > 0).length;
      expect(waehler).toBeGreaterThanOrEqual(K_ANONYMITY_SCHWELLE);
    }
  });

  it("voter_refs sind eindeutig und klar als Demo erkennbar", () => {
    const refs = DEMO_DOT_VERTEILUNGEN.map((_, i) => demoDotVoterRef(i));
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) expect(ref.startsWith("demo:")).toBe(true);
  });
});

describe("demo/seed-formate — GESCHLOSSENES Dot-Voting (Render-Moment, Gate-B MAJOR-2)", () => {
  const optionIds = DEMO_DOT_ABGESCHLOSSEN_OPTIONEN.map((_, i) => `dot-abg-opt-${i}`);

  it("Optionsanzahl liegt in den Composer-Grenzen", () => {
    expect(DEMO_DOT_ABGESCHLOSSEN_OPTIONEN.length).toBeGreaterThanOrEqual(DOT_OPTIONEN_MIN);
    expect(DEMO_DOT_ABGESCHLOSSEN_OPTIONEN.length).toBeLessThanOrEqual(DOT_OPTIONEN_MAX);
  });

  it("jede Seed-Verteilung passiert den Produktions-Validator und schöpft das Budget exakt aus", () => {
    for (const verteilung of DEMO_DOT_ABGESCHLOSSEN_VERTEILUNGEN) {
      expect(verteilung).toHaveLength(DEMO_DOT_ABGESCHLOSSEN_OPTIONEN.length);
      const input = verteilung.map((punkte, i) => ({ optionId: optionIds[i], punkte }));
      const res = validateDotAllocations(
        input,
        new Set(optionIds),
        DEMO_DOT_ABGESCHLOSSEN_BUDGET,
      );
      expect(res.ok).toBe(true);
      expect(verteilung.reduce((a, b) => a + b, 0)).toBe(DEMO_DOT_ABGESCHLOSSEN_BUDGET);
    }
  });

  it("Teilnehmerzahl ≥ 3k; jede Option von ≥ k Wählern bedacht (keine Maskierung im Render-Moment)", () => {
    expect(DEMO_DOT_ABGESCHLOSSEN_VERTEILUNGEN.length).toBeGreaterThanOrEqual(
      3 * K_ANONYMITY_SCHWELLE,
    );
    for (let opt = 0; opt < DEMO_DOT_ABGESCHLOSSEN_OPTIONEN.length; opt++) {
      const waehler = DEMO_DOT_ABGESCHLOSSEN_VERTEILUNGEN.filter((v) => v[opt] > 0).length;
      expect(waehler).toBeGreaterThanOrEqual(K_ANONYMITY_SCHWELLE);
    }
  });

  it("es gibt einen eindeutigen Gewinner (höchste Punktesumme) — der kuratierte Ergebnis-Moment", () => {
    const summen = DEMO_DOT_ABGESCHLOSSEN_OPTIONEN.map((_, opt) =>
      DEMO_DOT_ABGESCHLOSSEN_VERTEILUNGEN.reduce((acc, v) => acc + v[opt], 0),
    );
    const max = Math.max(...summen);
    expect(summen.filter((s) => s === max)).toHaveLength(1);
  });

  it("voter_refs sind eindeutig, demo-markiert und kollidieren nicht mit den aktiven Dot-Refs", () => {
    const refs = DEMO_DOT_ABGESCHLOSSEN_VERTEILUNGEN.map((_, i) =>
      demoDotAbgeschlossenVoterRef(i),
    );
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) expect(ref.startsWith("demo:")).toBe(true);
    const dotRefs = new Set(DEMO_DOT_VERTEILUNGEN.map((_, i) => demoDotVoterRef(i)));
    for (const ref of refs) expect(dotRefs.has(ref)).toBe(false);
  });
});

describe("demo/seed-formate — Widerstandsabfrage", () => {
  it("Optionsanzahl liegt in den (geteilten) Composer-Grenzen", () => {
    expect(DEMO_WIDERSTAND_OPTIONEN.length).toBeGreaterThanOrEqual(DOT_OPTIONEN_MIN);
    expect(DEMO_WIDERSTAND_OPTIONEN.length).toBeLessThanOrEqual(DOT_OPTIONEN_MAX);
  });

  it("jede Seed-Abgabe ist VOLLSTÄNDIG (Invariante) und passiert den Produktions-Validator", () => {
    for (const werte of DEMO_WIDERSTAND_WERTE) {
      // Vollständigkeit: exakt eine Bewertung je Option — 0-Werte inklusive.
      expect(werte).toHaveLength(DEMO_WIDERSTAND_OPTIONEN.length);
      const input = werte.map((wert, i) => ({ optionId: widerstandOptionIds[i], wert }));
      const res = validateWiderstandsWerte(input, new Set(widerstandOptionIds));
      expect(res.ok).toBe(true);
      if (res.ok) {
        // Der Validator filtert 0-Werte NICHT — alle Zeilen werden gespeichert.
        expect(res.werte).toHaveLength(DEMO_WIDERSTAND_OPTIONEN.length);
      }
      for (const wert of werte) {
        expect(Number.isInteger(wert)).toBe(true);
        expect(wert).toBeGreaterThanOrEqual(0);
        expect(wert).toBeLessThanOrEqual(WIDERSTAND_MAX);
      }
    }
  });

  it("mindestens ein 0-Wert wird gespeichert (belegt die 0-wird-gespeichert-Invariante sichtbar)", () => {
    expect(DEMO_WIDERSTAND_WERTE.some((werte) => werte.includes(0))).toBe(true);
  });

  it("Teilnehmerzahl liegt DEUTLICH über der k-Schwelle", () => {
    expect(DEMO_WIDERSTAND_WERTE.length).toBeGreaterThanOrEqual(3 * K_ANONYMITY_SCHWELLE);
  });

  it("es gibt einen eindeutigen Konsens-Gewinner mit geringstem Gesamtwiderstand", () => {
    const summen = DEMO_WIDERSTAND_OPTIONEN.map((_, opt) =>
      DEMO_WIDERSTAND_WERTE.reduce((acc, werte) => acc + werte[opt], 0),
    );
    const min = Math.min(...summen);
    expect(summen.filter((s) => s === min)).toHaveLength(1);
  });

  it("voter_refs sind eindeutig, demo-markiert und kollidieren nicht mit den Dot-Refs", () => {
    const refs = DEMO_WIDERSTAND_WERTE.map((_, i) => demoWiderstandVoterRef(i));
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) expect(ref.startsWith("demo:")).toBe(true);
    const dotRefs = new Set(DEMO_DOT_VERTEILUNGEN.map((_, i) => demoDotVoterRef(i)));
    for (const ref of refs) expect(dotRefs.has(ref)).toBe(false);
  });
});
