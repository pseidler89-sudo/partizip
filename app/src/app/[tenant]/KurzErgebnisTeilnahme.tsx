/**
 * KurzErgebnisTeilnahme — kompakte Teilnahme-Zeile für Options-Format-Karten
 * (dot_voting + widerstandsabfrage) in Listen (Startseite + /umfragen;
 * M1-Nachzug Block F, generalisiert in Block G — vorher KurzErgebnisDot).
 *
 * Zeigt AUSSCHLIESSLICH Aggregat-Signale, die die Ergebnis-Queries ohnehin
 * freigeben: gesamtWaehler/verifizierteWaehler sind laut ADR-025 immer sichtbar,
 * die per-Option-Aufschlüsselung bleibt serverseitig zurückgehalten/maskiert —
 * hier werden nie Options-Zahlen gerendert. Rein präsentational (keine Hooks).
 */

/**
 * Minimales gemeinsames Interface von DotVotingErgebnis UND WiderstandsErgebnis
 * — die Zeile braucht nur die immer sichtbaren Teilnahme-Signale.
 */
interface TeilnahmeAggregat {
  gesamtWaehler: number;
  verifizierteWaehler: number;
  zurueckhaltungsGrund: "laeuft_noch" | "zu_wenige_teilnehmende" | null;
}

export function KurzErgebnisTeilnahme({
  ergebnis,
  mitVerifiziert = false,
}: {
  ergebnis: TeilnahmeAggregat;
  /** /umfragen-Variante: Verifiziert-Anteil mit anzeigen (wie KurzErgebnis dort). */
  mitVerifiziert?: boolean;
}) {
  const n = ergebnis.gesamtWaehler;
  return (
    <div className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
      {n === 0 ? (
        <span>Noch keine Teilnahmen — machen Sie den Anfang.</span>
      ) : (
        <span>
          <strong>{n}</strong> {n === 1 ? "Teilnehmende:r" : "Teilnehmende"}
          {mitVerifiziert && <>, davon {ergebnis.verifizierteWaehler} wohnsitz-verifiziert</>}
          {ergebnis.zurueckhaltungsGrund === "laeuft_noch" ? (
            <> · Ausgezählt wird nach Abstimmungsende</>
          ) : ergebnis.zurueckhaltungsGrund === "zu_wenige_teilnehmende" ? (
            <> · Aufschlüsselung zum Schutz kleiner Gruppen ausgeblendet</>
          ) : null}
        </span>
      )}
    </div>
  );
}
