/**
 * ergebnis.test.ts — Unit-Tests für die Ergebnis-Aggregation (M3).
 *
 * Schwerpunkte: korrekte Zählung der ZWEI Signale (gesamt + verifiziert),
 * Prozent-Rundung, leerer Fall, defensives Ignorieren ungültiger Werte —
 * und die SERVERSEITIGE k-Anonymitäts-Suppression (Projekt-Review P1-1):
 * maskierte Optionen dürfen den Server nur mit count/verifiziert/prozent
 * = null verlassen, inkl. komplementärer Suppression gegen Rückrechnung.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateVotes,
  bestimmeMaskierteOptionen,
  isValidChoice,
  K_ANONYMITY_SCHWELLE,
  type VoteRow,
} from "@/lib/polls/ergebnis";

function stimmen(ja: number, nein: number, enthaltung: number, verifJa = 0): VoteRow[] {
  return [
    ...Array.from({ length: verifJa }, () => ({ choice: "ja", warVerifiziert: true })),
    ...Array.from({ length: ja - verifJa }, () => ({ choice: "ja", warVerifiziert: false })),
    ...Array.from({ length: nein }, () => ({ choice: "nein", warVerifiziert: false })),
    ...Array.from({ length: enthaltung }, () => ({ choice: "enthaltung", warVerifiziert: false })),
  ];
}

describe("aggregateVotes", () => {
  it("leeres Ergebnis bei keinen Stimmen (nichts maskiert)", () => {
    const r = aggregateVotes([]);
    expect(r.gesamt).toBe(0);
    expect(r.verifiziert).toBe(0);
    for (const o of r.optionen) {
      expect(o.count).toBe(0);
      expect(o.prozent).toBe(0);
      expect(o.maskiert).toBe(false);
    }
  });

  it("zählt gesamt und verifiziert getrennt (oberhalb der Schwelle)", () => {
    const r = aggregateVotes(stimmen(6, 5, 5, 2));
    expect(r.gesamt).toBe(16);
    expect(r.verifiziert).toBe(2);
    expect(r.optionen.find((o) => o.choice === "ja")?.count).toBe(6);
    expect(r.optionen.find((o) => o.choice === "nein")?.count).toBe(5);
    expect(r.optionen.find((o) => o.choice === "enthaltung")?.count).toBe(5);
  });

  it("zählt verifizierte Stimmen PRO Option (für die farbigen Balken)", () => {
    const r = aggregateVotes(stimmen(7, 6, 5, 3));
    const ja = r.optionen.find((o) => o.choice === "ja")!;
    const nein = r.optionen.find((o) => o.choice === "nein")!;
    const enth = r.optionen.find((o) => o.choice === "enthaltung")!;
    expect(ja.count).toBe(7);
    expect(ja.verifiziert).toBe(3);
    expect(nein.count).toBe(6);
    expect(nein.verifiziert).toBe(0);
    expect(enth.count).toBe(5);
    expect(ja.verifiziert! + nein.verifiziert! + enth.verifiziert!).toBe(r.verifiziert);
  });

  it("rechnet Prozente (gerundet) korrekt", () => {
    const r = aggregateVotes(stimmen(10, 5, 0));
    expect(r.optionen.find((o) => o.choice === "ja")?.prozent).toBe(67); // 66.67→67
    expect(r.optionen.find((o) => o.choice === "nein")?.prozent).toBe(33);
  });

  it("ignoriert ungültige choice-Werte (zählt sie nicht in gesamt)", () => {
    const rows: VoteRow[] = [
      ...stimmen(5, 5, 0, 1),
      { choice: "vielleicht", warVerifiziert: true },
    ];
    const r = aggregateVotes(rows);
    expect(r.gesamt).toBe(10);
    expect(r.verifiziert).toBe(1);
  });

  it("k-Anonymität: maskierte Optionen liefern NULL statt Zahlen (Server-Redaktion)", () => {
    // 25/8/3 → enthaltung (3) primär maskiert, nein (8) komplementär dazu,
    // ja (25) bleibt sichtbar. Maskierte Summe 11 ≥ k.
    const r = aggregateVotes(stimmen(25, 8, 3));
    const ja = r.optionen.find((o) => o.choice === "ja")!;
    const nein = r.optionen.find((o) => o.choice === "nein")!;
    const enth = r.optionen.find((o) => o.choice === "enthaltung")!;

    expect(ja.maskiert).toBe(false);
    expect(ja.count).toBe(25);

    for (const o of [nein, enth]) {
      expect(o.maskiert).toBe(true);
      expect(o.count).toBeNull();
      expect(o.verifiziert).toBeNull();
      expect(o.prozent).toBeNull();
    }
    // Keine Rückrechnung einer EINZELNEN Option möglich: gesamt − sichtbare
    // ergibt nur die Summe der beiden maskierten (11), nicht deren Verteilung.
    expect(r.gesamt).toBe(36);
  });

  it("k-Anonymität: Grenzwert k−1 maskiert, k nicht", () => {
    const vier = aggregateVotes(stimmen(K_ANONYMITY_SCHWELLE - 1, 20, 30));
    expect(vier.optionen.find((o) => o.choice === "ja")?.maskiert).toBe(true);
    const fuenf = aggregateVotes(stimmen(K_ANONYMITY_SCHWELLE, 20, 30));
    expect(fuenf.optionen.find((o) => o.choice === "ja")?.maskiert).toBe(false);
  });

  it("serialisiert NIE eine Zahl < k für eine Option mit 1..k−1 Stimmen", () => {
    // Property-artiger Sweep über kleine Verteilungen: keine Option mit
    // 0 < echt < k darf mit count ≠ null herauskommen; sichtbare Optionen
    // zeigen exakt ihren echten Wert.
    for (let ja = 0; ja <= 7; ja++) {
      for (let nein = 0; nein <= 7; nein++) {
        for (let enth = 0; enth <= 7; enth++) {
          const r = aggregateVotes(stimmen(ja, nein, enth));
          const echt = { ja, nein, enthaltung: enth };
          for (const o of r.optionen) {
            const real = echt[o.choice];
            if (real > 0 && real < K_ANONYMITY_SCHWELLE) {
              expect(o.maskiert).toBe(true);
              expect(o.count).toBeNull();
            }
            if (!o.maskiert) {
              expect(o.count).toBe(real);
            }
          }
        }
      }
    }
  });
});

describe("bestimmeMaskierteOptionen (komplementäre Suppression)", () => {
  it("nichts maskiert, wenn alle Optionen 0 oder ≥ k sind", () => {
    expect(bestimmeMaskierteOptionen({ ja: 12, nein: 6, enthaltung: 0 }).size).toBe(0);
    expect(bestimmeMaskierteOptionen({ ja: 0, nein: 0, enthaltung: 0 }).size).toBe(0);
  });

  it("eine einzelne kleine Gruppe zieht komplementäre Maskierung nach sich", () => {
    // 3 wäre über gesamt − sichtbare exakt rückrechenbar → mindestens eine
    // weitere Option wird maskiert; die größte Option bleibt sichtbar.
    const m = bestimmeMaskierteOptionen({ ja: 20, nein: 8, enthaltung: 3 });
    expect(m.has("enthaltung")).toBe(true);
    expect(m.size).toBeGreaterThanOrEqual(2);
    expect(m.has("ja")).toBe(false);
  });

  it("maskierte Summe muss ≥ k sein — sonst wird weiter maskiert", () => {
    // enthaltung=3 primär + nein=0 komplementär wären zusammen nur 3 < k →
    // auch ja wird maskiert (vollständige Suppression, gesamt bleibt sichtbar).
    const m = bestimmeMaskierteOptionen({ ja: 5, nein: 0, enthaltung: 3 });
    expect(m.size).toBe(3);
  });

  it("zwei kleine Gruppen mit ausreichender Summe: dritte bleibt sichtbar", () => {
    const m = bestimmeMaskierteOptionen({ ja: 30, nein: 3, enthaltung: 2 });
    expect(m.has("nein")).toBe(true);
    expect(m.has("enthaltung")).toBe(true);
    expect(m.has("ja")).toBe(false);
    expect(m.size).toBe(2);
  });

  it("Gate-B H1: eindeutige Zerlegung erzwingt volle Suppression (0/4/4-Klasse)", () => {
    // Maskierte Summe 8 hätte mit sichtbarem ja=0 nur die Zerlegung (4,4) →
    // ohne den Rekonstruktions-Check wären beide Kleingruppen exakt geleakt.
    expect(bestimmeMaskierteOptionen({ ja: 0, nein: 4, enthaltung: 4 }).size).toBe(3);
    // Weitere eindeutige Klassen (per Aufzählung verifiziert): sichtbarer
    // Anker gleich k bzw. Zwei-Anker-Tie + Randgruppe von k−1.
    expect(bestimmeMaskierteOptionen({ ja: 5, nein: 4, enthaltung: 4 }).size).toBe(3);
    expect(bestimmeMaskierteOptionen({ ja: 8, nein: 8, enthaltung: 4 }).size).toBe(3);
    // Gegenprobe: großer Anker mit mehrdeutiger Zerlegung bleibt partiell —
    // (100,4,4) ist auch als (3,5)/(2,6)/… erklärbar (komplementäre Maske).
    expect(bestimmeMaskierteOptionen({ ja: 100, nein: 4, enthaltung: 4 }).size).toBe(2);
  });
});

describe("Rekonstruktions-Sweep (Gate-B H1): kein maskierter Wert eindeutig bestimmbar", () => {
  it("über alle Verteilungen bis 12³ ist keine maskierte Option exakt rekonstruierbar", () => {
    const MAX = 12;
    type Obs = string;
    // Observable = das, was den Server verlässt: gesamt + sichtbare Werte +
    // Masken-Muster. Gruppiere alle echten Verteilungen nach Observable und
    // sammle je maskierter Option die vorkommenden ECHTEN Werte.
    const beobachtungen = new Map<Obs, Map<string, Set<number>>>();

    for (let ja = 0; ja <= MAX; ja++) {
      for (let nein = 0; nein <= MAX; nein++) {
        for (let enth = 0; enth <= MAX; enth++) {
          const counts = { ja, nein, enthaltung: enth };
          const m = bestimmeMaskierteOptionen(counts);
          if (m.size === 0) continue;
          const gesamt = ja + nein + enth;
          const sichtbar = (["ja", "nein", "enthaltung"] as const)
            .map((c) => (m.has(c) ? `${c}:?` : `${c}:${counts[c]}`))
            .join(",");
          const obs: Obs = `${gesamt}|${sichtbar}`;
          let werte = beobachtungen.get(obs);
          if (!werte) {
            werte = new Map();
            beobachtungen.set(obs, werte);
          }
          for (const c of m) {
            let s = werte.get(c);
            if (!s) {
              s = new Set();
              werte.set(c, s);
            }
            s.add(counts[c]);
          }
        }
      }
    }

    // Vollständigkeit der Preimages: Kandidatenwerte maskierter Optionen sind
    // durch die maskierte Summe ≤ gesamt ≤ 3·MAX begrenzt — Verteilungen mit
    // Einzelwerten > MAX können nur in Observables mit sichtbaren Werten > MAX
    // oder gesamt > 3·MAX landen; um Randgruppen ohne vollständige Preimage-
    // Menge nicht falsch zu bewerten, prüfen wir nur Observables, deren
    // maskierte Summe ≤ MAX ist (dort liegt jede Zerlegung im Sweep-Bereich).
    let geprueft = 0;
    for (const [obs, werte] of beobachtungen) {
      const gesamt = Number(obs.split("|")[0]);
      const sichtbareSumme = obs
        .split("|")[1]
        .split(",")
        .filter((t) => !t.endsWith(":?"))
        .reduce((s, t) => s + Number(t.split(":")[1]), 0);
      if (gesamt - sichtbareSumme > MAX) continue;
      for (const [choice, s] of werte) {
        expect(
          s.size,
          `Observable ${obs}: maskierte Option ${choice} eindeutig (${[...s][0]})`
        ).toBeGreaterThanOrEqual(2);
      }
      geprueft++;
    }
    expect(geprueft).toBeGreaterThan(100); // Sanity: der Sweep prüft real etwas.
  });
});

describe("isValidChoice", () => {
  it("akzeptiert nur ja/nein/enthaltung", () => {
    expect(isValidChoice("ja")).toBe(true);
    expect(isValidChoice("nein")).toBe(true);
    expect(isValidChoice("enthaltung")).toBe(true);
    expect(isValidChoice("vielleicht")).toBe(false);
    expect(isValidChoice("")).toBe(false);
    expect(isValidChoice(null)).toBe(false);
    expect(isValidChoice(123)).toBe(false);
  });
});
