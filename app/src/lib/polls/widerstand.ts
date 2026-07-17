/**
 * widerstand.ts — Widerstandsabfrage / Systemisches Konsensieren (ADR-025):
 * Teilnehmende geben je Option einen Widerstandswert 0–10 ab (0 = „keine
 * Einwände", 10 = „starker Widerstand"). Gewonnen hat die Option mit dem
 * GERINGSTEN Gesamtwiderstand — Konsens statt Mehrheitssieg. Reine, testbare
 * Logik (Validierung + Aggregation) ohne DB/HTTP.
 *
 * INVARIANTE (vollständige Abgabe): JEDE Option MUSS bewertet werden — sonst
 * wäre die Summen-Auswertung verzerrt (eine unbewertete Option bekäme
 * fälschlich 0 Widerstand). 0-Werte werden deshalb GESPEICHERT, nicht gefiltert.
 *
 * PRIVACY (ADR-025 „Aggregat statt Profil" + „Mindest-N vor Ergebnis", ADR-022):
 *   - Gezeigt wird NUR das Aggregat (Gesamtwiderstand + Durchschnitt je Option),
 *     nie ein individuelles Bewertungsmuster.
 *   - Aufschlüsselung erst NACH Abstimmungsende (istBeendet) UND ab
 *     K_ANONYMITY_SCHWELLE Teilnehmenden; darunter/während der Laufzeit wird die
 *     per-Option-Aufschlüsselung zurückgehalten. Die reine Teilnehmerzahl bleibt
 *     sichtbar (wie bei Ja/Nein, ADR-014).
 *   - Widerstandswerte/Optionen dürfen NIE ins Audit; der Beleg wird nie mit der
 *     Bewertung verkettet (Secret Ballot).
 */

import { K_ANONYMITY_SCHWELLE } from "@/lib/polls/ergebnis";

/** Maximaler Widerstandswert je Option (Skala 0..WIDERSTAND_MAX). */
export const WIDERSTAND_MAX = 10;

// Optionsanzahl/Label-Grenzen sind format-neutral (geteilte poll_options-
// Grenzen): Composer + Action nutzen für widerstandsabfrage dieselben
// DOT_OPTIONEN_MIN/MAX/LABEL_MAX aus dot.ts — kein zweiter Grenzsatz.

/** Eingehender Widerstandswert vom Client (vor Validierung). */
export interface WiderstandsWertInput {
  optionId: string;
  wert: number;
}

/** Eine rohe Widerstands-Zeile (aus vote_resistances). */
export interface WiderstandsWertRow {
  optionId: string;
  wert: number;
  voterRef: string;
  warVerifiziert: boolean;
}

export interface WiderstandsOptionErgebnis {
  optionId: string;
  label: string;
  position: number;
  /** Summe der Widerstandswerte auf diese Option; null wenn zurückgehalten. */
  widerstandsSumme: number | null;
  /** Durchschnittswert (1 Nachkommastelle); null wenn zurückgehalten. */
  mittelwert: number | null;
  /** true → diese Option hat den geringsten Gesamtwiderstand (Gewinner; bei Gleichstand mehrere). */
  geringsterWiderstand: boolean;
  /**
   * k-Anonymität (defensiv): true → diese Option wurde von WENIGER Personen
   * bewertet als teilgenommen haben (verletzte Vollständigkeits-Invariante,
   * z. B. durch einen künftigen Options-Edit-Pfad) und ihre Zahlen sind
   * serverseitig redigiert — eine 1..k-1-Personen-Option würde sonst
   * Einzelwerte verraten und eine unbewertete Option (Summe 0) fälschlich
   * „gewinnen".
   */
  maskiert: boolean;
}

export interface WiderstandsErgebnis {
  format: "widerstandsabfrage";
  /** Teilnehmende (distinct voter_ref) — immer sichtbar (Teilnahme-Signal). */
  gesamtWaehler: number;
  /** Davon wohnsitz-verifiziert — immer sichtbar. */
  verifizierteWaehler: number;
  /** Bei Anzeige NACH Summe aufsteigend sortiert; bei Zurückhaltung nach Position. */
  optionen: WiderstandsOptionErgebnis[];
  /** true → per-Option-Aufschlüsselung zurückgehalten (läuft noch ODER < k). */
  aufschluesselungZurueckgehalten: boolean;
  /** Grund der Zurückhaltung (für einen ehrlichen UI-Hinweis). */
  zurueckhaltungsGrund: "laeuft_noch" | "zu_wenige_teilnehmende" | null;
}

/**
 * Validiert die Widerstandswerte eines Wählers gegen die Optionen der Umfrage.
 * VOLLSTÄNDIGKEIT ist Pflicht: jede Option genau einmal, Werte ganze Zahlen
 * 0..WIDERSTAND_MAX. 0-Werte werden NICHT gefiltert — sie werden gespeichert
 * (vollständige Abgabe, sonst verzerrte Summen). Rein serverseitig aufzurufen —
 * der Client-Input ist nie vertrauenswürdig.
 */
export function validateWiderstandsWerte(
  input: unknown,
  gueltigeOptionIds: ReadonlySet<string>,
):
  | { ok: true; werte: { optionId: string; wert: number }[] }
  | { ok: false; error: string } {
  if (!Array.isArray(input)) {
    return { ok: false, error: "Ungültige Eingabe." };
  }
  // Options-lose Umfrage (nur per DB-Manipulation/Seed-Bug möglich — der
  // Composer erzwingt ≥2 Optionen): OHNE diesen Guard wäre die leere Abgabe
  // „vollständig" (0 === 0) und der leere Insert würde erst in der Transaktion
  // mit einem 500 statt einer sauberen Fehlermeldung scheitern.
  if (gueltigeOptionIds.size === 0) {
    return { ok: false, error: "Diese Abstimmung hat keine Optionen." };
  }
  const gesehen = new Set<string>();
  const werte: { optionId: string; wert: number }[] = [];
  for (const roh of input) {
    if (
      typeof roh !== "object" ||
      roh === null ||
      typeof (roh as WiderstandsWertInput).optionId !== "string" ||
      typeof (roh as WiderstandsWertInput).wert !== "number"
    ) {
      return { ok: false, error: "Ungültige Eingabe." };
    }
    const { optionId, wert } = roh as WiderstandsWertInput;
    if (!gueltigeOptionIds.has(optionId)) {
      return { ok: false, error: "Unbekannte Option." };
    }
    if (gesehen.has(optionId)) {
      return { ok: false, error: "Doppelte Option." };
    }
    gesehen.add(optionId);
    if (!Number.isInteger(wert) || wert < 0 || wert > WIDERSTAND_MAX) {
      return {
        ok: false,
        error: "Widerstandswerte müssen ganze Zahlen von 0 bis 10 sein.",
      };
    }
    werte.push({ optionId, wert });
  }
  // Vollständigkeit: jede Option genau einmal bewertet (Duplikate/Unbekannte
  // sind oben ausgeschlossen → Längenvergleich genügt).
  if (werte.length !== gueltigeOptionIds.size) {
    return {
      ok: false,
      error: "Bitte bewerten Sie jede Option (0 = keine Einwände).",
    };
  }
  return { ok: true, werte };
}

/**
 * Aggregiert Widerstands-Zeilen zu einem Widerstandsabfrage-Ergebnis. `beendet`
 * steuert (zusammen mit der k-Schwelle) die Zurückhaltung der Aufschlüsselung.
 *
 * Per-Option-Maskierung nur DEFENSIV (anders als Dot-Voting): da jede:r
 * Teilnehmende JEDE Option bewertet (vollständige Abgabe, von der Action
 * erzwungen), ist die per-Option-Wählerzahl normal immer = gesamtWaehler —
 * keine „kleine Gruppe je Option", das Gesamt-Gate (Mindest-N) trägt den
 * Schutz. Sollte die Invariante je brechen (künftiger Options-Edit-Pfad,
 * historische Teilabgaben), würde eine Option mit 1..k-1 Zeilen Einzelwerte
 * verraten und eine unbewertete Option (Summe 0) fälschlich „gewinnen" —
 * solche Optionen werden deshalb hart maskiert und vom Gewinner-Vergleich
 * ausgeschlossen (Gate-B Block G).
 */
export function aggregateWiderstandsVotes(
  rows: readonly WiderstandsWertRow[],
  optionen: readonly { id: string; label: string; position: number }[],
  beendet: boolean,
): WiderstandsErgebnis {
  // Teilnehmende + Verifiziert-Status je voter_ref (der Status ist je Wähler
  // konstant über seine Zeilen).
  const verifiziertProWaehler = new Map<string, boolean>();
  for (const r of rows) {
    if (!verifiziertProWaehler.has(r.voterRef)) {
      verifiziertProWaehler.set(r.voterRef, r.warVerifiziert);
    }
  }
  const gesamtWaehler = verifiziertProWaehler.size;
  let verifizierteWaehler = 0;
  for (const v of verifiziertProWaehler.values()) if (v) verifizierteWaehler += 1;

  // Zurückhaltung der GESAMTEN Aufschlüsselung: läuft noch ODER zu wenige
  // Teilnehmende (Mindest-N, ADR-025). Teilnahme-Zahl bleibt sichtbar.
  let grund: WiderstandsErgebnis["zurueckhaltungsGrund"] = null;
  if (!beendet) grund = "laeuft_noch";
  else if (gesamtWaehler < K_ANONYMITY_SCHWELLE) grund = "zu_wenige_teilnehmende";

  if (grund !== null) {
    return {
      format: "widerstandsabfrage",
      gesamtWaehler,
      verifizierteWaehler,
      optionen: [...optionen]
        .sort((a, b) => a.position - b.position)
        .map((o) => ({
          optionId: o.id,
          label: o.label,
          position: o.position,
          widerstandsSumme: null,
          mittelwert: null,
          geringsterWiderstand: false,
          maskiert: false,
        })),
      aufschluesselungZurueckgehalten: true,
      zurueckhaltungsGrund: grund,
    };
  }

  // Summe + Zeilenzahl je Option. Die Vollständigkeit sichert die Action —
  // defensiv wird trotzdem nur summiert (fehlende Zeilen zählen NICHT als 0)
  // und der Mittelwert durch die Zeilenzahl der Option geteilt (nicht durch
  // gesamtWaehler — robust gegen historische Teilabgaben).
  const summeProOption = new Map<string, number>();
  const zeilenProOption = new Map<string, number>();
  for (const r of rows) {
    summeProOption.set(r.optionId, (summeProOption.get(r.optionId) ?? 0) + r.wert);
    zeilenProOption.set(r.optionId, (zeilenProOption.get(r.optionId) ?? 0) + 1);
  }

  const mitSummen = optionen.map((o) => {
    const summe = summeProOption.get(o.id) ?? 0;
    const zeilen = zeilenProOption.get(o.id) ?? 0;
    return {
      optionId: o.id,
      label: o.label,
      position: o.position,
      summe,
      // 1 Nachkommastelle; ohne Zeilen (defensiv) 0.
      mittelwert: zeilen > 0 ? Math.round((summe / zeilen) * 10) / 10 : 0,
      // Defensiv-Maskierung (siehe Funktionskommentar): Option von weniger
      // Personen bewertet als teilgenommen haben → Zahlen redigieren.
      maskiert: zeilen < gesamtWaehler,
    };
  });

  // Konsens-Sortierung: aufsteigend nach Gesamtwiderstand (geringster zuerst),
  // bei Gleichstand nach Position; maskierte Optionen ans Ende (nach Position).
  // Gewinner = ALLE nicht-maskierten Optionen mit Minimal-Summe.
  mitSummen.sort((a, b) => {
    if (a.maskiert !== b.maskiert) return a.maskiert ? 1 : -1;
    if (a.maskiert) return a.position - b.position;
    return a.summe - b.summe || a.position - b.position;
  });
  const sichtbar = mitSummen.filter((o) => !o.maskiert);
  const minSumme = sichtbar.length > 0 ? sichtbar[0].summe : null;

  return {
    format: "widerstandsabfrage",
    gesamtWaehler,
    verifizierteWaehler,
    optionen: mitSummen.map((o) => ({
      optionId: o.optionId,
      label: o.label,
      position: o.position,
      widerstandsSumme: o.maskiert ? null : o.summe,
      mittelwert: o.maskiert ? null : o.mittelwert,
      geringsterWiderstand: !o.maskiert && minSumme !== null && o.summe === minSumme,
      maskiert: o.maskiert,
    })),
    aufschluesselungZurueckgehalten: false,
    zurueckhaltungsGrund: null,
  };
}
