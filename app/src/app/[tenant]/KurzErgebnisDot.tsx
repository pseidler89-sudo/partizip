/**
 * KurzErgebnisDot — kompakte Teilnahme-Zeile für dot_voting-Karten in Listen
 * (Startseite + /umfragen; M1-Nachzug Block F).
 *
 * Zeigt AUSSCHLIESSLICH Aggregat-Signale, die getDotErgebnis ohnehin freigibt:
 * gesamtWaehler/verifizierteWaehler sind laut ADR-025 immer sichtbar, die
 * per-Option-Aufschlüsselung bleibt serverseitig zurückgehalten/maskiert —
 * hier werden nie Options-Zahlen gerendert. Rein präsentational (keine Hooks).
 */

import type { DotVotingErgebnis } from "@/lib/polls/dot";

export function KurzErgebnisDot({
  ergebnis,
  mitVerifiziert = false,
}: {
  ergebnis: DotVotingErgebnis;
  /** /umfragen-Variante: Verifiziert-Anteil mit anzeigen (wie KurzErgebnis dort). */
  mitVerifiziert?: boolean;
}) {
  const n = ergebnis.gesamtWaehler;
  return (
    <div className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
      {n === 0 ? (
        <span>Noch keine Teilnahmen — verteilen Sie als Erste:r Ihre Punkte.</span>
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
