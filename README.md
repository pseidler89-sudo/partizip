# Partizip

[![CI](https://github.com/pseidler89-sudo/partizip/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pseidler89-sudo/partizip/actions/workflows/ci.yml) [![Lizenz: AGPL-3.0](https://img.shields.io/badge/Lizenz-AGPL--3.0-blue.svg)](LICENSE)

**Überparteiliche Beteiligungsplattform für Kommunen.** Bürgerinnen und Bürger werden
zu lokalen Themen *gefragt* — Stimmungsbilder und verbindliche Abstimmungen mit geheimer
Stimmabgabe, nachvollziehbaren Ergebnissen und quellengeprüften Ratsinformationen als
Tiefenschicht.

> *Partizip is a non-partisan civic participation platform for German municipalities:
> local polls with secret ballots and verifiable inclusion receipts, plus source-linked
> council digests. German-first; contributions welcome.*

**Live:** [partizip.online](https://partizip.online) (Pilot: Taunusstein / Rheingau-Taunus-Kreis) ·
**Ausprobieren ohne Anmeldung:** [demo.partizip.online](https://demo.partizip.online) ·
**Kanäle:** [@durchblick@partizip.online](https://mastodon.partizip.online/@durchblick) (Fediverse) ·
[@durchblick.partizip.online](https://bsky.app/profile/durchblick.partizip.online) (Bluesky)

---

## Was Partizip anders macht

**Mitmachen zuerst.** Die Haustür ist nicht ein Dokumentenberg, sondern eine Frage:
Kommunen stellen lokale Fragen ein, Bürgerinnen und Bürger stimmen mit einem
E-Mail-Konto ab (Stufe 1) — verbindliche Abstimmungen erfordern eine Wohnsitz-Verifizierung
(Stufe 2). Ergebnisse zeigen Gesamt- und verifizierte Stimmen getrennt aus.

**Drei Abstimmungsformate** (siehe [ADR-025](docs/decisions/ADR-025-beteiligungsformate.md)):

- **Ja / Nein / Enthaltung** — das klassische Stimmungsbild oder die verbindliche Frage.
- **Punkte-Voting (Dot-Voting)** — ein Punktebudget wird auf mehrere Optionen verteilt,
  z. B. für Bürgerbudgets. Ergebnis ist eine Verteilung, kein Einzelsieger.
- **Widerstandsabfrage** (Systemisches Konsensieren) — je Option ein Widerstandswert
  von 0 bis 10; es gewinnt die Option mit dem *geringsten* Gesamtwiderstand.
  Konsens-Prinzip statt knapper Mehrheitssieg.

**Wohnsitz-Verifizierung ohne Behördenkonto.** Bürgerinnen und Bürger zeigen ihren
persönlichen Konto-QR-Code, eine verifizierende Person der Kommune scannt und bestätigt
ihn — bei Walk-in-Standorten (z. B. Bürgerbüro) während der Öffnungszeiten, ohne
Terminzwang. Gespeichert wird nur die Bestätigung selbst, kein Ausweisabgleich, kein
Melderegister-Zugriff ([ADR-023](docs/decisions/ADR-023-identitaetsstrategie-kein-melderegisterabgleich.md)).
Die Online-Ausweisfunktion (eID/EUDI-Wallet) ist als künftige Ausbaustufe vorgesehen
([ADR-018](docs/decisions/ADR-018-eid-eudi-verifizierung.md)).

**Vertrauen ist Architektur, nicht Versprechen.**

- **Geheime Stimmabgabe:** Die Wahl ist mit der Person technisch nicht verkettbar
  (pseudonyme HMAC-Referenzen, kein Klartext-Bezug, Audit-Log grundsätzlich PII-frei).
  Details: [`docs/architecture/VOTE_PRIVACY.md`](docs/architecture/VOTE_PRIVACY.md)
- **Beleg-Codes:** Jede Stimme erhält einen anonymen Beleg-Code. Nach Ende der Abstimmung
  wird die Liste aller Codes veröffentlicht — jede*r kann prüfen, dass die eigene Stimme
  enthalten ist, ohne dass der Beleg je verrät, *wie* abgestimmt wurde.
- **Auszählung erst nach Abstimmungsende:** Zwischenstände werden nicht angezeigt
  ([ADR-022](docs/decisions/ADR-022-aufschluesselung-nach-abstimmungsende.md)) — wie
  bei einer echten Wahl bleibt jede Stimme unbeeinflusst von Trends.
- **k-Anonymität serverseitig:** Kleine Teilnehmerzahlen werden bereits auf dem Server
  maskiert, damit niemand rückrechenbar ist. Details:
  [`docs/architecture/K_ANONYMITY.md`](docs/architecture/K_ANONYMITY.md)
- **KI-Neutralitäts-Check mit öffentlichem Prompt:** Neue Fragen werden vor
  Veröffentlichung gegen einen versionierten, vollständig öffentlichen Prüfmaßstab auf
  suggestive Rahmung geprüft ([ADR-028](docs/decisions/ADR-028-ki-neutralitaets-check.md)).
  Die Prüfung hält im Zweifel an, lehnt aber nie final ab — der Mensch bleibt letzte
  Instanz. Der komplette Prompt ist auf der Transparenzseite der Plattform einsehbar.
- **Menschliches Freigabe-Gate:** Ratsinfo-Digests werden nie automatisch veröffentlicht.
  Jede Aussage trägt einen Quellenlink ins Ratsinformationssystem; Redaktion und Freigabe
  sind getrennte Rollen (Vier-Augen-Prinzip).
- **DSGVO-Selbstservice:** Datenexport und Konto-Löschung direkt im eigenen Konto,
  ohne Anfrage an den Betreiber.
- **Überparteilichkeit als Regel:** Keine Wertung, keine Empfehlung, kein Targeting.
  Die Plattform stellt Fragen und belegt Fakten — Position beziehen die Menschen.

**Digitale Souveränität.** Selbst gehostet in Deutschland, Verbreitung ausschließlich
über offene Protokolle: eigene Digest-Seiten mit RSS, ein eigener ActivityPub-Server
(Fediverse/Mastodon) und AT-Protocol (Bluesky) über einen europäischen Server. Kein
Telegram, kein WhatsApp, keine proprietären Silos in der Kette (siehe
[ADR-021](docs/decisions/ADR-021-souveraene-kanalstrategie.md)).

## Screenshots

Alle Aufnahmen stammen aus der öffentlichen Demo
([demo.partizip.online](https://demo.partizip.online), fiktive „Musterstadt",
nächtlicher Reset — ausprobieren ohne Anmeldung).

| | |
|---|---|
| ![Startseite der Demo: aktuelle verbindliche Abstimmung mit Hinweis „Ausgezählt wird nach Abstimmungsende" und Stufen-Erklärung](docs/assets/startseite-demo.png) | ![Abstimmungs-Übersicht: laufende Fragen mit Format-Badges (Verbindlich, Stimmungsbild, Punkte-Voting, Widerstandsabfrage) und Ergebnisse-Sektion beendeter Abstimmungen](docs/assets/umfragen-uebersicht.png) |
| ![Ergebnis eines beendeten Punkte-Votings: Punkteverteilung auf vier Optionen eines Bürgerbudgets, mit Teilnehmer- und Verifizierten-Zahl sowie Beleg-Prüfung](docs/assets/punkte-voting-ergebnis.png) | ![Ergebnis einer Widerstandsabfrage: vier Varianten mit Gesamtwiderstand und Durchschnitt, die Variante mit dem geringsten Widerstand ist als Konsens-Gewinner markiert](docs/assets/widerstandsabfrage-ergebnis.png) |
| ![Verifizierungs-Seite: Drei-Schritte-Anleitung (Stelle finden, hingehen, Konto-QR zeigen), Walk-in-Standorte mit Öffnungszeiten und Ausblick auf die künftige eID-Option](docs/assets/verifizieren-walkin.png) | ![Mobile Ansicht der Abstimmungs-Übersicht im Smartphone-Format](docs/assets/umfragen-uebersicht-mobil.png) |

## Architektur in einem Absatz

Next.js 16 (App Router, TypeScript strict) · PostgreSQL 16 · Drizzle ORM mit
SQL-Migrationen · passwortlose Magic-Link-Auth (httpOnly-Sessions) · host-basierte
Multi-Tenancy (eine Instanz, viele Kommunen; im Pilot single-domain mit PLZ-Einstieg).
Gebiete sind ein **hierarchischer Gebietsbaum** (`regions`, PostgreSQL `ltree`) mit den
Ebenen Ortsteil → Gemeinde → Kreis → Land → Bund; Fragen, Rollen und
Verifizierungs-Standorte hängen an einem Gebietsknoten (`region_id`), die Sichtbarkeit
ergibt sich aus der Baum-Hierarchie (die Bund-Ebene ist derzeit nur lesend). Rollenträger
(Verifizierung, Redaktion, Verwaltung, Beobachter) erhalten nach Login eine eigene
**Aufgaben-Ansicht**, die ausschließlich serverseitig erlaubte Aktionen zeigt. Alle
wesentlichen Entscheidungen sind als ADRs dokumentiert:
[`docs/decisions/`](docs/decisions/).

## Quickstart (lokale Entwicklung)

Voraussetzungen: Node 22, Docker mit Compose-Plugin.

```bash
# 1. Dev-Infrastruktur starten (PostgreSQL 16 auf 127.0.0.1:5433 + Mailpit)
docker compose -f infra/docker-compose.dev.yml up -d

# 2. Abhängigkeiten installieren
cd app && npm ci

# 3. Umgebungsvariablen anlegen (Platzhalter ersetzen — niemals echte Secrets committen)
cp ../.env.example ../.env

# 4. Migrationen anwenden
DATABASE_URL=postgres://partizip:partizip@127.0.0.1:5433/partizip npm run db:migrate

# 5. Demo-Daten laden (idempotent)
npm run db:seed

# 6. Entwicklungsserver starten
npm run dev   # → http://localhost:3000
```

Magic-Link-E-Mails landen lokal in Mailpit (`http://localhost:8025`).

**Tests:** `npm run typecheck && npm run lint && npx vitest run` — die Integrationstests
erwarten eine PostgreSQL-Testdatenbank (`DATABASE_URL_TEST`), siehe
[CONTRIBUTING.md](CONTRIBUTING.md). Lint läuft mit hartem Barrierefreiheits-Gate
(`--max-warnings 0`, jsx-a11y).

**Eigener Betrieb:** Eine Produktions-Anleitung (Docker, Migrationen, Backups, neue
Kommune anlegen) steht in [`docs/manual/SELBST_HOSTING.md`](docs/manual/SELBST_HOSTING.md).

## Projektstand

Partizip ist ein **laufender Pilot** (seit Juli 2026 öffentlich, Region Taunusstein /
Rheingau-Taunus-Kreis) — kein fertiges Produkt. Die Kernschleife funktioniert Ende-zu-Ende:
Frage erstellen → teilen → abstimmen → verifizieren → Ergebnis mit Beleg-Liste →
benachrichtigt werden. Heute enthalten: die drei Abstimmungsformate, die
Wohnsitz-Verifizierung per Konto-QR mit Walk-in-Standorten, der Gebietsbaum, der
KI-Neutralitäts-Check (assistiert), die Aufgaben-Ansicht für Rollenträger, serverseitige
k-Anonymität und der DSGVO-Selbstservice. Vieles ist bewusst noch klein gehalten —
was geplant ist, was auf einen Auslöser wartet und was bewusst nicht gebaut wird,
steht ehrlich in der [ROADMAP.md](ROADMAP.md).

## Mitmachen

Beiträge sind willkommen — von Kommunen, Entwickler*innen und allen, die digitale
Bürgerbeteiligung ernst nehmen. Bitte zuerst [CONTRIBUTING.md](CONTRIBUTING.md) lesen
(Konventionen, Tests, Grundregeln wie Tenant-Isolation und Secret-Ballot-Schutz).
Sicherheitslücken bitte **nicht** als öffentliches Issue melden: [SECURITY.md](SECURITY.md).

Kontakt für Kommunen und alles andere: **kontakt@partizip.online**

## Lizenz

[GNU AGPL-3.0](LICENSE) — wer Partizip betreibt oder verändert (auch als Webdienst),
macht seine Änderungen wieder frei. So bleibt die Plattform das, was sie verspricht:
nachvollziehbar für alle.
