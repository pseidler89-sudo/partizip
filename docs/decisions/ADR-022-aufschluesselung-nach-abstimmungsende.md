# ADR-022 — Ergebnis-Aufschlüsselung erst nach Abstimmungsende

**Status:** umgesetzt (2026-07-11) · **Entscheider:** Patrick (Produktentscheidung
2026-07-11), Umsetzung Projektleiter.

## Kontext

Die serverseitige k-Anonymitäts-Suppression (`docs/architecture/K_ANONYMITY.md`,
`app/src/lib/polls/ergebnis.ts`) garantiert seit dem Gate-B-Review H1: Aus einem
EINZELNEN Ergebnis-Payload ist kein exakter Kleingruppen-Wert rekonstruierbar
(primäre + komplementäre Suppression + Rekonstruktions-Check, per Sweep-Test
abgesichert).

Diese Garantie gilt jedoch **pro Einzel-Snapshot**. Solange eine Umfrage läuft,
ändert sich das Ergebnis über die Zeit — und ein Beobachter, der regelmäßig
Snapshots zieht, kann maskierte Kleingruppen über **zeitliche Differenzbildung**
teils exakt rekonstruieren (Beispiel: eine Option kippt zwischen zwei Snapshots
von „sichtbar 0" auf „maskiert" — die Differenz verrät den Zuwachs). Eine
Suppression, die auch alle Snapshot-Differenzen abdeckt, wäre erheblich
komplexer und bliebe fehleranfällig.

## Entscheidung

**Die per-Option-Aufschlüsselung (Zählstände, Prozente, Verifiziert-Anteile je
ja/nein/enthaltung) verlässt den Server erst nach Abstimmungsende — für ALLE
Umfragen.**

1. **Laufende Umfrage:** `getPollErgebnis`/`getMeineTeilnahmen` liefern die
   Optionen OHNE Zahlen (`count`/`verifiziert`/`prozent = null` für ALLE
   Optionen) plus das explizite Flag `aufschluesselungNachSchluss: true`.
   Sichtbar bleibt nur die Poll-Ebene: `gesamt` + davon `verifiziert`
   (ADR-014-Signale). Die Redaktion ist **serverseitig hart**
   (`ohneAufschluesselung` in `ergebnis.ts`), nie nur UI.
2. **Beendete Umfrage:** Volle Aufschlüsselung als EIN finaler Stand — mit
   unveränderter k-Suppression für Kleingruppen. „Beendet" heißt: Status
   `geschlossen` ODER `closesAt` erreicht — exakt dieselbe Semantik wie die
   Freigabe der Beleg-Liste (gemeinsamer Helfer `istBeendet` in `ergebnis.ts`,
   genutzt von `queries.ts`, `beleg.ts` und der Detailseite).
3. **UI:** Bei laufenden Umfragen zeigen Detailseite und Karten statt Balken
   einen positiven Hinweis („Ausgezählt wird nach Abstimmungsende — bisher N
   Stimmen, davon M verifiziert."). Die eigene Stimm-Bestätigung + der
   einmalige Beleg-Code bleiben unverändert. Beendete Umfragen zeigen das
   Ergebnis wie bisher (inklusive „Aufschlüsselung ausgeblendet" bei
   Kleingruppen).
4. **Kein Schema-Change:** In dieser Stufe gibt es kein per-Poll-Flag — die
   Regel gilt global.

**Erwünschter Nebeneffekt:** Keine Anker-/Herdeneffekte durch Zwischenstände.
Wie bei echten Wahlen wird nach Schluss ausgezählt — jede Stimme fällt
unbeeinflusst vom laufenden Trend.

## Konsequenzen

- Die k-Anonymitäts-Garantie gilt damit praktisch **fürs Endergebnis**: Es gibt
  pro Umfrage nur noch EINEN öffentlichen Aufschlüsselungs-Snapshot, zeitliche
  Differenzbildung entfällt („Bekannte Grenze" Punkt 1 in K_ANONYMITY.md ist
  adressiert).
- Bewusst weiter öffentlich während des Laufs: `gesamt` + `verifiziert` auf
  Poll-Ebene (ADR-014) — Beteiligung sichtbar machen bleibt Produktziel.
  Unverändert bleibt auch die Grenze, dass die per-Option-Verifiziert-Zahlen
  sichtbarer Optionen im Endergebnis < k sein können (ADR-014-gewollt).
- Die Demo-Seeds geben der GESCHLOSSENEN Beispiel-Frage eine Verteilung mit
  jeder Option ≥ k (9/6/5), damit der Rundgang den Ergebnis-Moment mit voller
  Aufschlüsselung zeigt (laufende Demo-Fragen zeigen den Auszählungs-Hinweis).
- **Roadmap:** Falls je gewünscht (z. B. für unkritische Stimmungsbilder), ist
  eine per-Poll-Opt-in-Erweiterung für Live-Aufschlüsselung denkbar (neues
  Poll-Feld + Admin-Entscheidung beim Anlegen) — dann mit dokumentiertem
  Restrisiko der Differenzbildung. Nicht Teil dieser Stufe.
