/**
 * ergebnis.ts — Ergebnis-Aggregation für Umfragen (M3)
 *
 * Reine Funktionen für die Verdichtung von Stimm-Zeilen zu einem Ergebnis.
 * Bewusst ohne DB-Zugriff, damit die Zähl-/Prozent-Logik deterministisch
 * unit-testbar ist (die DB-Abfrage liegt in queries.getPollErgebnis).
 *
 * ZWEI Signale (Entscheidung Patrick):
 *   - gesamt:      alle Stimmen
 *   - verifiziert: davon Stimmen mit war_verifiziert = true
 *
 * k-ANONYMITÄT IST SERVERSEITIG (Projekt-Review 2026-07-02, P1-1):
 * Maskierte Optionen verlassen den Server mit count/verifiziert/prozent = null.
 * Vorher war `maskiert` nur ein Anzeige-Flag und die exakte Kleingruppen-Zahl
 * stand trotzdem im RSC-/HTML-Payload (Seitenquelltext). Algorithmus nach
 * docs/architecture/K_ANONYMITY.md:
 *   1. Primäre Suppression: Optionen mit 0 < count < k maskieren.
 *   2. Komplementäre Suppression (gegen Rückrechnung gesamt − sichtbare):
 *      solange genau eine Option maskiert ist ODER die maskierte Summe < k
 *      bleibt, zusätzlich die kleinste noch sichtbare Option maskieren.
 *   3. Rekonstruktions-Check (Gate-B H1): Lässt die maskierte Summe nur EINE
 *      konsistente Zerlegung zu (z. B. 0/4/4 → sichtbar 0, Summe 8 = zwingend
 *      4+4), volle Suppression. Garantie (PRO EINZEL-SNAPSHOT): kein exakter
 *      Kleingruppen-Wert ist aus dem Payload rekonstruierbar (Sweep-Test);
 *      Wertebereiche bleiben naturgemäß eingrenzbar. GRENZEN (Gate-B-Review
 *      2026-07-11): (a) Wer ein LAUFENDES Ergebnis über die Zeit beobachtet,
 *      kann Kleingruppen per Differenzbildung teils rekonstruieren — für
 *      sensible Fragen ist "Aufschlüsselung erst nach Schluss" die saubere
 *      Antwort (Roadmap). (b) `gesamt`/`verifiziert` (Poll-Ebene) bleiben
 *      bewusst öffentlich (ADR-014); die k-Garantie erstreckt sich NICHT auf
 *      die per-Option-Verifiziert-Zahlen sichtbarer Optionen (können < k sein).
 * Segment-Aufschlüsselungen (PLZ/Ortsteil) bleiben Roadmap (K_ANONYMITY.md).
 */

export type Choice = "ja" | "nein" | "enthaltung";

export const CHOICES: readonly Choice[] = ["ja", "nein", "enthaltung"] as const;

/**
 * k-Anonymität-Schwelle (M6): Optionen mit 1..k-1 Stimmen werden maskiert
 * (Re-Identifikation kleiner Gruppen). Schwellwert-Änderung ist eine
 * Produktentscheidung (Patrick) — die Vorstellungs-Präsentation kommuniziert
 * aktuell „Gruppen mit weniger als 5 Stimmen zeigen wir nicht".
 */
export const K_ANONYMITY_SCHWELLE = 5;

export function isValidChoice(value: unknown): value is Choice {
  return value === "ja" || value === "nein" || value === "enthaltung";
}

export interface VoteRow {
  choice: string;
  warVerifiziert: boolean;
}

export interface OptionErgebnis {
  choice: Choice;
  /** Stimmen der Option; null wenn maskiert (Zahl verlässt den Server nicht). */
  count: number | null;
  /** Davon wohnsitz-verifizierte Stimmen; null wenn maskiert. */
  verifiziert: number | null;
  /** Anteil an gesamt in Prozent (0–100, gerundet); null wenn maskiert. */
  prozent: number | null;
  /** k-Anonymität: true → Zahlen sind serverseitig redigiert (null). */
  maskiert: boolean;
}

export interface PollErgebnis {
  gesamt: number;
  verifiziert: number;
  optionen: OptionErgebnis[];
}

/**
 * Aggregiert Stimm-Zeilen zu einem Ergebnis — inklusive serverseitiger
 * k-Anonymitäts-Suppression (siehe Datei-Header). Unbekannte choice-Werte
 * (sollte es dank CHECK nicht geben) werden ignoriert und zählen NICHT in
 * gesamt — defensiv gegen kaputte Daten.
 */
export function aggregateVotes(rows: VoteRow[]): PollErgebnis {
  const counts: Record<Choice, number> = { ja: 0, nein: 0, enthaltung: 0 };
  const verifCounts: Record<Choice, number> = { ja: 0, nein: 0, enthaltung: 0 };
  let gesamt = 0;
  let verifiziert = 0;

  for (const row of rows) {
    if (!isValidChoice(row.choice)) continue;
    counts[row.choice] += 1;
    gesamt += 1;
    if (row.warVerifiziert) {
      verifiziert += 1;
      verifCounts[row.choice] += 1;
    }
  }

  const maskiertSet = bestimmeMaskierteOptionen(counts);

  const optionen: OptionErgebnis[] = CHOICES.map((choice) => {
    const maskiert = maskiertSet.has(choice);
    if (maskiert) {
      return { choice, count: null, verifiziert: null, prozent: null, maskiert };
    }
    return {
      choice,
      count: counts[choice],
      verifiziert: verifCounts[choice],
      prozent: gesamt === 0 ? 0 : Math.round((counts[choice] / gesamt) * 100),
      maskiert,
    };
  });

  return { gesamt, verifiziert, optionen };
}

/**
 * Basis-Maskierung: primäre + komplementäre Suppression (Algorithmus aus
 * docs/architecture/K_ANONYMITY.md, angewandt auf die Options-Ebene
 * ja/nein/enthaltung). NUR intern — die exportierte Funktion ergänzt den
 * Rekonstruktions-Check (Gate-B H1).
 */
function basisMaskierung(counts: Record<Choice, number>): Set<Choice> {
  const maskiert = new Set<Choice>();

  // 1. Primäre Suppression: kleine Gruppen (1..k-1).
  for (const choice of CHOICES) {
    if (counts[choice] > 0 && counts[choice] < K_ANONYMITY_SCHWELLE) {
      maskiert.add(choice);
    }
  }
  if (maskiert.size === 0) return maskiert;

  // 2. Komplementäre Suppression: eine einzelne maskierte Option wäre über
  //    gesamt − sichtbare exakt rückrechenbar; ebenso muss die maskierte
  //    Gesamtmasse mindestens k betragen, damit sie sich keiner einzelnen
  //    Gruppe zuordnen lässt. Solange das verletzt ist: kleinste noch
  //    sichtbare Option zusätzlich maskieren (Ties in CHOICES-Reihenfolge).
  const maskierteSumme = (): number =>
    [...maskiert].reduce((sum, c) => sum + counts[c], 0);

  while (maskiert.size < CHOICES.length && (maskiert.size === 1 || maskierteSumme() < K_ANONYMITY_SCHWELLE)) {
    const sichtbare = CHOICES.filter((c) => !maskiert.has(c));
    const kleinste = sichtbare.reduce((min, c) =>
      counts[c] < counts[min] ? c : min
    );
    maskiert.add(kleinste);
  }

  return maskiert;
}

/**
 * Bestimmt die zu maskierenden Optionen. Exportiert für gezielte Unit-Tests.
 *
 * Rekonstruktions-Check (Gate-B-Review H1, 2026-07-02): Die Basis-Invarianten
 * („nie genau 1 maskiert", „maskierte Summe ≥ k") verhindern die
 * Ein-Segment-Rückrechnung, NICHT aber die eindeutige Zerlegung der bekannten
 * maskierten Summe — Beispiel (ja=0, nein=4, enthaltung=4): sichtbar ja=0,
 * maskierte Summe 8, und (4,4) ist die EINZIGE Belegung, die exakt dieses
 * Masken-Muster reproduziert → beide Kleingruppen-Zahlen exakt geleakt.
 * Deshalb: Sind bei zwei maskierten Optionen die Werte über die Aufzählung
 * aller konsistenten Belegungen eindeutig bestimmt, fallen wir auf VOLLE
 * Suppression zurück (alle Optionen maskiert, nur gesamt bleibt sichtbar).
 * Für das All-maskiert-Muster selbst existieren für jedes gesamt ≥ 1 mehrere
 * konsistente Verteilungen (u. a. weil auch (1, gesamt−1, 0)-Formen dorthin
 * eskalieren) — per Rekonstruktions-Sweep im Test abgesichert. Eingrenzbar
 * bleiben naturgemäß WerteBEREICHE; exakte Werte nicht.
 */
export function bestimmeMaskierteOptionen(
  counts: Record<Choice, number>
): Set<Choice> {
  const maskiert = basisMaskierung(counts);

  if (maskiert.size === 2) {
    const [erste, zweite] = CHOICES.filter((c) => maskiert.has(c));
    const summe = counts[erste] + counts[zweite];

    // Alle Belegungen (a, summe−a) durchgehen, die dasselbe Masken-Muster
    // erzeugen würden. Nur eine einzige konsistente Belegung → eindeutig
    // rekonstruierbar → volle Suppression. Early-Exit bei 2 Belegungen.
    const konsistenteWerte = new Set<number>();
    for (let a = 0; a <= summe; a++) {
      const kandidat: Record<Choice, number> = {
        ...counts,
        [erste]: a,
        [zweite]: summe - a,
      };
      const kandidatMaske = basisMaskierung(kandidat);
      if (
        kandidatMaske.size === maskiert.size &&
        [...maskiert].every((c) => kandidatMaske.has(c))
      ) {
        konsistenteWerte.add(a);
        if (konsistenteWerte.size >= 2) break;
      }
    }
    if (konsistenteWerte.size <= 1) {
      return new Set<Choice>(CHOICES);
    }
  }

  return maskiert;
}
