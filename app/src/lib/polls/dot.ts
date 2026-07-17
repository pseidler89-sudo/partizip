/**
 * dot.ts — Dot-/Budget-Voting (ADR-025): Wähler verteilen ein festes Punkte-
 * budget auf mehrere Optionen; Ergebnis = Verteilung der Punktesummen, kein
 * Einzelsieger. Reine, testbare Logik (Validierung + Aggregation) ohne DB/HTTP.
 *
 * PRIVACY (ADR-025 „Aggregat statt Profil" + „Mindest-N vor Ergebnis", ADR-022):
 *   - Gezeigt wird NUR die Aggregat-Verteilung (Punktesumme je Option), nie ein
 *     individuelles Verteilmuster.
 *   - Aufschlüsselung erst NACH Abstimmungsende (istBeendet) UND ab
 *     K_ANONYMITY_SCHWELLE Teilnehmenden; darunter/während der Laufzeit wird die
 *     per-Option-Aufschlüsselung zurückgehalten. Die reine Teilnehmerzahl bleibt
 *     sichtbar (wie bei Ja/Nein, ADR-014).
 *   - Punkte/Optionen dürfen NIE ins Audit; der Beleg wird nie mit der Verteilung
 *     verkettet (Secret Ballot).
 */

import { K_ANONYMITY_SCHWELLE } from "@/lib/polls/ergebnis";

/** Grenzen fürs Punktebudget je Wähler (Composer + Server). */
export const DOT_BUDGET_MIN = 1;
export const DOT_BUDGET_MAX = 100;
/** Grenzen für die Optionsanzahl je dot_voting-Umfrage. */
export const DOT_OPTIONEN_MIN = 2;
export const DOT_OPTIONEN_MAX = 12;
export const DOT_OPTION_LABEL_MAX = 120;

export interface DotOption {
  id: string;
  label: string;
  position: number;
}

/** Eine rohe Zuteilungs-Zeile (aus vote_allocations). */
export interface DotAllocationRow {
  optionId: string;
  punkte: number;
  voterRef: string;
  warVerifiziert: boolean;
}

/** Eingehende Zuteilung vom Client (vor Validierung). */
export interface DotAllocationInput {
  optionId: string;
  punkte: number;
}

export interface DotOptionErgebnis {
  optionId: string;
  label: string;
  position: number;
  /** Summe der Punkte auf diese Option; null wenn zurückgehalten/maskiert. */
  punkteSumme: number | null;
  /** Anteil an allen vergebenen Punkten (0–100, gerundet); null wenn zurückgehalten/maskiert. */
  prozent: number | null;
  /**
   * k-Anonymität: true → diese Option wurde von zu wenigen (1..k-1) Personen mit
   * Punkten bedacht und ihre Zahlen sind serverseitig redigiert (null). Die
   * Wählerzahl je Option verlässt den Server bewusst NICHT (nur dieses Flag).
   */
  maskiert: boolean;
}

export interface DotVotingErgebnis {
  format: "dot_voting";
  /** Punktebudget je Wähler (für die Anzeige/Kontext). */
  budget: number;
  /** Teilnehmende (distinct voter_ref) — immer sichtbar (Teilnahme-Signal). */
  gesamtWaehler: number;
  /** Davon wohnsitz-verifiziert — immer sichtbar. */
  verifizierteWaehler: number;
  optionen: DotOptionErgebnis[];
  /** true → per-Option-Aufschlüsselung zurückgehalten (läuft noch ODER < k). */
  aufschluesselungZurueckgehalten: boolean;
  /** Grund der Zurückhaltung (für einen ehrlichen UI-Hinweis). */
  zurueckhaltungsGrund: "laeuft_noch" | "zu_wenige_teilnehmende" | null;
}

/**
 * Validiert die Zuteilungen eines Wählers gegen die Optionen der Umfrage und das
 * Budget. Gibt die BEREINIGTEN Zuteilungen (nur punkte>0, dedupliziert) zurück.
 * Rein serverseitig aufzurufen — der Client-Input ist nie vertrauenswürdig.
 */
export function validateDotAllocations(
  input: unknown,
  gueltigeOptionIds: ReadonlySet<string>,
  budget: number,
):
  | { ok: true; allocations: { optionId: string; punkte: number }[] }
  | { ok: false; error: string } {
  if (!Array.isArray(input)) {
    return { ok: false, error: "Ungültige Eingabe." };
  }
  const gesehen = new Set<string>();
  const bereinigt: { optionId: string; punkte: number }[] = [];
  let summe = 0;
  for (const roh of input) {
    if (
      typeof roh !== "object" ||
      roh === null ||
      typeof (roh as DotAllocationInput).optionId !== "string" ||
      typeof (roh as DotAllocationInput).punkte !== "number"
    ) {
      return { ok: false, error: "Ungültige Eingabe." };
    }
    const { optionId, punkte } = roh as DotAllocationInput;
    if (!gueltigeOptionIds.has(optionId)) {
      return { ok: false, error: "Unbekannte Option." };
    }
    if (gesehen.has(optionId)) {
      return { ok: false, error: "Doppelte Option." };
    }
    gesehen.add(optionId);
    if (!Number.isInteger(punkte) || punkte < 0) {
      return { ok: false, error: "Punkte müssen ganze Zahlen ≥ 0 sein." };
    }
    if (punkte > 0) {
      bereinigt.push({ optionId, punkte });
      summe += punkte;
    }
  }
  if (bereinigt.length === 0) {
    return { ok: false, error: "Bitte verteilen Sie mindestens einen Punkt." };
  }
  if (summe > budget) {
    return {
      ok: false,
      error: `Sie haben mehr als ${budget} Punkte vergeben (${summe}).`,
    };
  }
  return { ok: true, allocations: bereinigt };
}

/**
 * Aggregiert Zuteilungs-Zeilen zu einem Dot-Voting-Ergebnis. `beendet` steuert
 * (zusammen mit der k-Schwelle) die Zurückhaltung der per-Option-Aufschlüsselung.
 */
export function aggregateDotVotes(
  rows: readonly DotAllocationRow[],
  optionen: readonly DotOption[],
  budget: number,
  beendet: boolean,
): DotVotingErgebnis {
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

  // Punktesumme + Wählerzahl je Option (Wählerzahl nur serverseitig für die
  // k-Maskierung — verlässt den Server NICHT).
  const summeProOption = new Map<string, number>();
  const waehlerProOption = new Map<string, Set<string>>();
  let gesamtPunkte = 0;
  for (const r of rows) {
    summeProOption.set(r.optionId, (summeProOption.get(r.optionId) ?? 0) + r.punkte);
    gesamtPunkte += r.punkte;
    if (!waehlerProOption.has(r.optionId)) waehlerProOption.set(r.optionId, new Set());
    waehlerProOption.get(r.optionId)!.add(r.voterRef);
  }

  // (1) Zurückhaltung der GESAMTEN Aufschlüsselung: läuft noch ODER zu wenige
  //     Teilnehmende (Mindest-N, ADR-025). Teilnahme-Zahl bleibt sichtbar.
  let grund: DotVotingErgebnis["zurueckhaltungsGrund"] = null;
  if (!beendet) grund = "laeuft_noch";
  else if (gesamtWaehler < K_ANONYMITY_SCHWELLE) grund = "zu_wenige_teilnehmende";
  const zurueck = grund !== null;

  const sortiert = [...optionen].sort((a, b) => a.position - b.position);

  if (zurueck) {
    return {
      format: "dot_voting",
      budget,
      gesamtWaehler,
      verifizierteWaehler,
      optionen: sortiert.map((o) => ({
        optionId: o.id,
        label: o.label,
        position: o.position,
        punkteSumme: null,
        prozent: null,
        maskiert: false,
      })),
      aufschluesselungZurueckgehalten: true,
      zurueckhaltungsGrund: grund,
    };
  }

  // (2) per-Option-k-Maskierung (wie im Ja/Nein-Pfad, ergebnis.ts): eine Option,
  //     der 1..k-1 Personen Punkte gaben, ist eine zu kleine Gruppe → maskieren.
  //     0 Personen (Summe 0) bleiben sichtbar (niemand identifizierbar).
  const waehlerCount = (id: string) => waehlerProOption.get(id)?.size ?? 0;
  const maskiert = new Set<string>();
  for (const o of sortiert) {
    const n = waehlerCount(o.id);
    if (n >= 1 && n < K_ANONYMITY_SCHWELLE) maskiert.add(o.id);
  }
  // (3) Komplementär-Suppression gegen Rückrechnung: genau EINE maskierte Option
  //     ließe sich aus gesamtPunkte − sichtbare Summen rekonstruieren. Solange nur
  //     eine (nicht-leere) Option maskiert ist, zusätzlich die sichtbare Option mit
  //     der KLEINSTEN positiven Wählerzahl maskieren, bis es 0 oder ≥2 sind.
  const nichtLeerSichtbar = () =>
    sortiert.filter((o) => waehlerCount(o.id) >= 1 && !maskiert.has(o.id));
  while (maskiert.size === 1 && nichtLeerSichtbar().length > 0) {
    const kandidat = nichtLeerSichtbar().sort(
      (a, b) => waehlerCount(a.id) - waehlerCount(b.id),
    )[0];
    maskiert.add(kandidat.id);
  }

  const optionenErgebnis: DotOptionErgebnis[] = sortiert.map((o) => {
    if (maskiert.has(o.id)) {
      return { optionId: o.id, label: o.label, position: o.position, punkteSumme: null, prozent: null, maskiert: true };
    }
    const summe = summeProOption.get(o.id) ?? 0;
    return {
      optionId: o.id,
      label: o.label,
      position: o.position,
      punkteSumme: summe,
      prozent: gesamtPunkte > 0 ? Math.round((summe / gesamtPunkte) * 100) : 0,
      maskiert: false,
    };
  });

  return {
    format: "dot_voting",
    budget,
    gesamtWaehler,
    verifizierteWaehler,
    optionen: optionenErgebnis,
    aufschluesselungZurueckgehalten: false,
    zurueckhaltungsGrund: null,
  };
}
