# Roadmap — Partizip

**Stand:** Juli 2026. Diese Roadmap ist bewusst ehrlich gehalten: Sie unterscheidet
zwischen dem, was heute läuft, dem, was gerade entsteht, dem, was geplant ist, dem,
was erst bei einem klaren Auslöser startet — und dem, was bewusst *nicht* gebaut wird.
Termine nennt sie keine. Hintergründe zu den Entscheidungen stehen in den ADRs unter
[`docs/decisions/`](docs/decisions/).

> **Reifegrad:** Partizip ist ein laufender, öffentlich erreichbarer Pilot
> ([partizip.online](https://partizip.online), Region Taunusstein / Rheingau-Taunus-Kreis) —
> kein fertiges Massenprodukt. „Live" heißt: im Pilot lauffähig und in der
> [Demo](https://demo.partizip.online) selbst ausprobierbar, nicht „in 100 Kommunen erprobt".

---

## Live — läuft heute im Pilot

**Mitmach-Kern**

- Vollständige Kette: Frage erstellen → teilen → abstimmen (E-Mail-Konto ohne Passwort) →
  Wohnsitz verifizieren → Ergebnis → schließen → bei neuer Abstimmung benachrichtigt werden.
- **Drei Abstimmungsformate** ([ADR-025](docs/decisions/ADR-025-beteiligungsformate.md)):
  Ja/Nein/Enthaltung, Punkte-Voting (Budget auf Optionen verteilen) und Widerstandsabfrage
  (0–10 je Option, es gewinnt der geringste Gesamtwiderstand — Konsens-Prinzip).
- **Wahlgeheimnis technisch:** anonyme Stimmen (HMAC-Pseudonyme), Beleg-Codes zum
  Selbst-Prüfen der eigenen Stimme, Auszählung erst nach Abstimmungsende
  ([ADR-022](docs/decisions/ADR-022-aufschluesselung-nach-abstimmungsende.md)),
  k-Anonymität serverseitig.

**Verifizierung**

- **Wohnsitz-Verifizierung per Konto-QR:** Bürger*in zeigt den eigenen QR-Code, eine
  verifizierende Person scannt und bestätigt — an Walk-in-Standorten mit Öffnungszeiten,
  ohne Terminzwang. Kein Ausweisabgleich wird gespeichert, kein Behördenkonto nötig.
- Verifizierung mit Ablaufdatum und Erinnerung zur Re-Verifizierung.

**Gebiet & Rollen**

- **Gebietsbaum** (Ortsteil → Gemeinde → Kreis → Land → Bund) als einzige Quelle für
  Sichtbarkeit und Zuständigkeit; Fragen, Rollen und Verifizierungs-Standorte hängen an
  Gebietsknoten. Die Bund-Ebene ist derzeit nur lesend.
- Rollen mit Gebietsbindung, Vier-Augen-Prinzip serverseitig, View-Only-Rolle,
  Einladungs-Flow per E-Mail, PII-freies Audit-Log.
- **Aufgaben-Ansicht** für Rollenträger: nach Login sichtbar ist genau das, was
  serverseitig auch erlaubt ist.

**Vertrauen & Governance**

- **KI-Neutralitäts-Check (assistiert)** mit vollständig öffentlichem, versioniertem
  Prüf-Prompt ([ADR-028](docs/decisions/ADR-028-ki-neutralitaets-check.md)): hält
  suggestive Fragen an, lehnt nie final ab — der Mensch bleibt letzte Instanz.
- DSGVO-Selbstservice (Datenexport, Konto-Löschung), Mindestalter-Durchsetzung,
  Magic-Link-Anmeldung gehärtet gegen E-Mail-Sicherheits-Scanner.
- Quellengebundene Ratsinfo-Digests mit menschlicher Freigabe (Vier-Augen).

**Reichweite & Betrieb**

- Öffentliche Selbstklick-Demo ([demo.partizip.online](https://demo.partizip.online))
  inklusive Verwaltungs-Perspektive mit Wegwerf-Zugang.
- Eigene Digest-Seiten mit RSS, eigener Fediverse-Server (ActivityPub) und Bluesky
  (AT-Protocol) — keine proprietären Silos in der Verbreitung
  ([ADR-021](docs/decisions/ADR-021-souveraene-kanalstrategie.md)).
- Multi-Tenant-Architektur (eine Instanz, mehrere Kommunen), Tenant-Export/Import,
  Barrierefreiheit als hartes Lint-Gate, quelloffen (AGPL-3.0).

---

## In Arbeit — entsteht gerade

- **Gebietsauswahl beim Erstellen von Fragen:** Auswahl des Gebietsknotens direkt im
  Frage-Composer (heute wird das Gebiet aus dem Kontext abgeleitet).
- **Zuverlässige Mail-Zustellung:** Versand-Warteschlange in der Datenbank plus
  typisierte E-Mail-Vorlagen, damit Benachrichtigungen auch unter Last robust bleiben.
- **Kleinere Betriebs-Härtungen** aus den fortlaufenden Sicherheits-Reviews.

---

## Geplant — konkret vorgesehen, ohne Termin

- **eID / EUDI-Wallet als Ausbaustufe der Verifizierung**
  ([ADR-018](docs/decisions/ADR-018-eid-eudi-verifizierung.md)): Wohnsitz-Bestätigung
  online per Online-Ausweisfunktion, datensparsam — die eID bleibt Verifizierung,
  nie Login.
- **NFC-Chip als Passkey-Träger (Inklusion):** ein physischer Chip (z. B. Karte) als
  Zugangsweg für Menschen, die mit E-Mail-Links oder Smartphones nicht zurechtkommen.
- **Zwei-Faktor-Anmeldung für Admin-Rollen** (TOTP/Passkeys) — Rollenträger-Konten
  haben mehr Rechte und verdienen eine höhere Hürde als den Magic-Link allein.
- **Offsite-Backup-Option** als dokumentierter Standard-Bestandteil des Betriebs
  (verschlüsselte Sicherung außerhalb des eigenen Servers).
- **Kreis und Land als eigene Instanzen:** größere Gebietskörperschaften erhalten
  eigene Mandanten statt einer Sammel-Instanz; der Gebietsbaum verbindet die Ebenen.
- **Föderation** zwischen Instanzen — später, nach den eigenen Instanzen für
  Kreis/Land; Grundlage sind offene Protokolle.

---

## Bedingt — startet bei einem klaren Auslöser

| Vorhaben | Startet, sobald … |
|---|---|
| **Ortsteil-genaue verbindliche Fragen** — verbindliche Abstimmungen, die nur für einen Ortsteil gelten, samt der dafür nötigen Wohnsitz-Prüfschärfe auf Ortsteil-Ebene | die erste verbindliche Ortsteil-Frage real ansteht. |
| **Automatisierter KI-Neutralitäts-Check** — der heute assistierte Check ([ADR-028](docs/decisions/ADR-028-ki-neutralitaets-check.md)) läuft automatisch bei jeder Aktivierung | fremde Instanzen die Plattform betreiben und der Betreiber die Prüfung nicht mehr selbst begleiten kann. |
| **Passkeys für Bürger-Konten** — komfortablere Anmeldung; der Magic-Link bleibt der Wiederherstellungs-Weg | Rückmeldungen aus dem Pilot den Bedarf zeigen. |
| **Push-Benachrichtigungen** (Web-Push) | die Mail-Warteschlange steht — die Reihenfolge ist bewusst. |

---

## Bewusst nicht — aktiv entschieden

- **Kein BundID-Login, kein Melderegister-Abgleich**
  ([ADR-023](docs/decisions/ADR-023-identitaetsstrategie-kein-melderegisterabgleich.md)):
  zu viel Hürde für Bürger*innen, rechtlich unklar für private Betreiber, widerspricht
  der Datensparsamkeit. Der Wohnsitz wird vor Ort (künftig optional per eID) belegt.
- **Keine Tier-Lists, keine Turnier-/Bracket-Formate**
  ([ADR-025](docs/decisions/ADR-025-beteiligungsformate.md)): Gamification-Formate, die
  Themen gegeneinander ausspielen, passen nicht zu ernsthafter Beteiligung. Die
  Format-Palette wächst nur um Verfahren mit belastbarer Beteiligungs-Methodik.
- **Identität ist nie das Login** — eID/EUDI dienen ausschließlich der Verifizierung,
  nicht der Anmeldung.
- **Keine proprietären Plattformen in der Verbreitungskette**
  ([ADR-021](docs/decisions/ADR-021-souveraene-kanalstrategie.md)) — kein Telegram,
  kein WhatsApp; Reichweite läuft über eigene Seiten, RSS und offene Protokolle.
- **Kein Nutzer-Tracking, keine Analytics-Wanzen** — Datensparsamkeit ist Grundregel,
  nicht Option.
- **Keine parteipolitische Positionierung** — die Plattform stellt Fragen und belegt
  Fakten; Position beziehen die Menschen.
