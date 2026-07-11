# Sicherheitshinweise melden

Partizip verarbeitet Abstimmungsdaten von Bürgerinnen und Bürgern. Wenn Sie eine
Sicherheitslücke finden, melden Sie sie bitte **vertraulich** — nicht als öffentliches
Issue, nicht als Pull Request, nicht in sozialen Netzwerken.

## Meldeweg

**E-Mail an: patrick@seidler.ml** — Betreff mit „SECURITY" beginnen.

Bitte beschreiben Sie:
- betroffene Komponente/URL (Produktivsystem ist partizip.online, Demo ist demo.partizip.online),
- Schritte zur Reproduktion,
- mögliche Auswirkung (was kann ein Angreifer damit?).

Sie erhalten innerhalb von **72 Stunden** eine Antwort. Wir halten Sie über die
Behebung auf dem Laufenden und nennen Sie auf Wunsch als Finder*in, sobald der Fix
veröffentlicht ist (koordinierte Offenlegung).

## Spielregeln für Tests

- **Demo-System benutzen:** demo.partizip.online ist eine öffentliche Spielwiese und
  wird nächtlich zurückgesetzt — testen Sie dort, nicht gegen echte Abstimmungen.
- Keine Tests, die Daten echter Nutzer*innen lesen, verändern oder löschen.
- Kein Social Engineering, kein Spam an echte Empfänger, keine Lasttests/DoS.

## Was besonders schützenswert ist

Die härtesten Garantien der Plattform — Funde in diesen Bereichen sind am wichtigsten:

1. **Geheime Stimmabgabe:** Jede Möglichkeit, eine abgegebene Stimme einer Person
   zuzuordnen (auch über Timing, Logs oder Beleg-Codes), ist ein kritischer Fund.
   Design-Dokumentation: `docs/architecture/VOTE_PRIVACY.md`.
2. **Tenant-Isolation:** Zugriff auf Daten einer anderen Kommune.
3. **Eligibility-Umgehung:** Abstimmen ohne Konto, doppelt abstimmen, verbindlich
   abstimmen ohne Wohnsitz-Verifizierung, Rollen-Eskalation.
4. **Auth:** Magic-Link-/Session-Schwächen.

Unterstützt wird jeweils der Stand von `main` bzw. das laufende Produktivsystem.
Danke, dass Sie verantwortungsvoll melden!
