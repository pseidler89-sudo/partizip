/**
 * demo/seed-formate.ts — kuratierte Seed-Daten der Format-Fragen (P1
 * „Demo-Alleinstellung"): Dot-Voting + Widerstandsabfrage auf dem Demo-Mandanten.
 *
 * BEWUSST als reines Daten-Modul ohne DB-/Skript-Abhängigkeit: scripts/seed-demo.ts
 * schreibt diese Definitionen in die DB; die Unit-Tests
 * (__tests__/seed-formate.test.ts) prüfen die Invarianten maschinell mit den
 * ECHTEN Produktions-Validatoren (validateDotAllocations/validateWiderstandsWerte):
 *
 *   - Dot-Voting: jede Verteilung schöpft das Budget exakt aus; jede Option wird
 *     von ≥ K_ANONYMITY_SCHWELLE Wählern bedacht (keine per-Option-Maskierung im
 *     Demo-Ergebnis).
 *   - Widerstandsabfrage: jede Abgabe ist VOLLSTÄNDIG (jede Option von jedem
 *     Wähler bewertet, 0-Werte werden gespeichert — Invariante aus ADR-025).
 *   - Beide: Teilnehmerzahl DEUTLICH über K_ANONYMITY_SCHWELLE, damit das
 *     Ergebnis nach Abstimmungsende rendert (kein Suppressions-Fall).
 *
 * Alle Inhalte sind Musterstadt-fiktiv (Ehrlichkeits-Regel des Demo-Mandanten).
 */

/** Frage der Dot-Voting-Beispielfrage (unverbindlich, Stufe 1, aktiv). */
export const DEMO_DOT_FRAGE =
  "Wofür sollen die 20.000 € aus dem Musterstadt-Bürgerbudget eingesetzt werden?";

/** Punktebudget je Wähler:in (dot_voting, polls.punkte_budget). */
export const DEMO_DOT_BUDGET = 5;

/** Optionen der Dot-Voting-Frage (Index = position). */
export const DEMO_DOT_OPTIONEN = [
  "Spielplatz-Sanierung am Stadtpark",
  "Bänke und Schatten im Stadtpark",
  "Trinkbrunnen am Marktplatz",
  "Öffentlicher Bücherschrank",
  "Ausbesserung des Radwegs zur Grundschule",
] as const;

/**
 * Punkte-Verteilungen der Seed-Wähler (eine Zeile je Wähler, Spalten = Optionen
 * in position-Reihenfolge). Jede Zeile summiert exakt auf DEMO_DOT_BUDGET;
 * 0-Spalten werden beim Seed NICHT gespeichert (vote_allocations speichert nur
 * punkte > 0 — CHECK-Constraint). Jede Option erhält Punkte von ≥ k Wählern.
 * Erzählung: Spielplatz führt, Trinkbrunnen dicht dahinter — kein Erdrutsch.
 */
export const DEMO_DOT_VERTEILUNGEN: ReadonlyArray<readonly number[]> = [
  [3, 0, 2, 0, 0],
  [3, 0, 2, 0, 0],
  [3, 0, 2, 0, 0],
  [3, 0, 2, 0, 0],
  [3, 0, 2, 0, 0],
  [3, 0, 2, 0, 0],
  [2, 1, 0, 0, 2],
  [2, 1, 0, 0, 2],
  [2, 1, 0, 0, 2],
  [2, 1, 0, 0, 2],
  [0, 2, 2, 1, 0],
  [0, 2, 2, 1, 0],
  [0, 2, 2, 1, 0],
  [0, 0, 1, 2, 2],
  [0, 0, 1, 2, 2],
  [0, 0, 1, 2, 2],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
];

/**
 * Frage der GESCHLOSSENEN Dot-Voting-Beispielfrage (Gate-B MAJOR-2): die aktive
 * Dot-Frage hält ihre Aufschlüsselung laut ADR-022/-025 bis zum Ende zurück und
 * kann vom Demo-Admin wegen des Seed-Guards nicht geschlossen werden — der
 * Render-Moment des Formats (Punkte-Balken) wäre im Schaufenster unsichtbar.
 * Darum ZWEI Dot-Fragen: die aktive zum Mitmachen (oben), diese geschlossene
 * „Vorjahres-Runde" mit sofort sichtbarem Ergebnis.
 */
export const DEMO_DOT_ABGESCHLOSSEN_FRAGE =
  "Wofür sollten die 15.000 € aus dem Bürgerbudget des Vorjahres eingesetzt werden?";

/** Punktebudget je Wähler:in der geschlossenen Dot-Frage. */
export const DEMO_DOT_ABGESCHLOSSEN_BUDGET = 5;

/** Optionen der geschlossenen Dot-Frage (Index = position). */
export const DEMO_DOT_ABGESCHLOSSEN_OPTIONEN = [
  "Neue Sitzgruppen am Flussufer",
  "Boule-Bahn im Stadtpark",
  "Obstbäume für die Streuobstwiese",
  "Reparatur-Café im Bürgerhaus",
] as const;

/**
 * Punkte-Verteilungen der geschlossenen Dot-Frage — gleiche Invarianten wie
 * DEMO_DOT_VERTEILUNGEN (Budget exakt ausgeschöpft, jede Option ≥ k Wähler,
 * Teilnehmerzahl ≥ 3k, eindeutiger Gewinner). Erzählung: die Sitzgruppen am
 * Flussufer gewannen klar, aber ohne Erdrutsch.
 * Punktesummen: 28 / 24 / 20 / 18 (Wähler je Option: 12 / 14 / 12 / 12).
 */
export const DEMO_DOT_ABGESCHLOSSEN_VERTEILUNGEN: ReadonlyArray<readonly number[]> = [
  [3, 2, 0, 0],
  [3, 2, 0, 0],
  [3, 2, 0, 0],
  [3, 2, 0, 0],
  [3, 2, 0, 0],
  [3, 2, 0, 0],
  [2, 0, 2, 1],
  [2, 0, 2, 1],
  [2, 0, 2, 1],
  [2, 0, 2, 1],
  [0, 2, 1, 2],
  [0, 2, 1, 2],
  [0, 2, 1, 2],
  [0, 2, 1, 2],
  [0, 1, 2, 2],
  [0, 1, 2, 2],
  [1, 1, 2, 1],
  [1, 1, 2, 1],
];

/** Frage der Widerstandsabfrage (geschlossen geseedet → Ergebnis rendert sofort). */
export const DEMO_WIDERSTAND_FRAGE =
  "Verkehrsberuhigung Marktstraße: Welche Variante erzeugt den geringsten Widerstand?";

/** Optionen der Widerstandsabfrage (Index = position). */
export const DEMO_WIDERSTAND_OPTIONEN = [
  "Tempo 20 in der gesamten Marktstraße",
  "Einbahnstraße stadtauswärts",
  "Durchfahrt nur für Anlieger frei",
  "Alles lassen wie bisher",
] as const;

/**
 * Widerstandswerte der Seed-Wähler (eine Zeile je Wähler, Spalten = Optionen in
 * position-Reihenfolge, Werte 0–10). Jede Zeile ist VOLLSTÄNDIG (jede Option
 * bewertet) — 0-Werte („keine Einwände") werden MIT gespeichert (Invariante).
 * Erzählung: „Durchfahrt nur für Anlieger" erzeugt den geringsten Widerstand
 * (Konsens-Gewinner), „alles lassen" den größten — der Kern-Moment des Formats.
 */
export const DEMO_WIDERSTAND_WERTE: ReadonlyArray<readonly number[]> = [
  [2, 6, 1, 7],
  [2, 6, 1, 7],
  [2, 6, 1, 7],
  [2, 6, 1, 7],
  [2, 6, 1, 7],
  [2, 6, 1, 7],
  [2, 6, 1, 7],
  [3, 7, 0, 8],
  [3, 7, 0, 8],
  [3, 7, 0, 8],
  [3, 7, 0, 8],
  [3, 7, 0, 8],
  [3, 7, 0, 8],
  [3, 7, 0, 8],
  [5, 4, 2, 3],
  [5, 4, 2, 3],
  [5, 4, 2, 3],
  [5, 4, 2, 3],
  [1, 8, 3, 9],
  [1, 8, 3, 9],
  [1, 8, 3, 9],
];

/** voter_ref der Seed-Teilnahme (klar erkennbare Demo-Refs, kein echter HMAC). */
export function demoDotVoterRef(index: number): string {
  return `demo:dot:${index}`;
}

/** voter_ref der Seed-Teilnahme der Widerstandsabfrage. */
export function demoWiderstandVoterRef(index: number): string {
  return `demo:widerstand:${index}`;
}

/** voter_ref der Seed-Teilnahme der GESCHLOSSENEN Dot-Frage. */
export function demoDotAbgeschlossenVoterRef(index: number): string {
  return `demo:dot-abgeschlossen:${index}`;
}
