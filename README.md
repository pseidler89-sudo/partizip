# Partizip

[![CI](https://github.com/pseidler89-sudo/partizip/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pseidler89-sudo/partizip/actions/workflows/ci.yml) [![Lizenz: AGPL-3.0](https://img.shields.io/badge/Lizenz-AGPL--3.0-blue.svg)](LICENSE)

**Überparteiliche Beteiligungsplattform für Kommunen.** Bürgerinnen und Bürger werden
zu lokalen Themen *gefragt* — Stimmungsbilder mit geheimer Stimmabgabe, nachvollziehbaren
Ergebnissen und quellengeprüften Ratsinformationen als Tiefenschicht.

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
Kommunen stellen lokale Stimmungsbilder ein, Bürgerinnen und Bürger stimmen mit einem
E-Mail-Konto ab (Stufe 1) — verbindliche Abstimmungen erfordern eine Wohnsitz-Verifizierung
(Stufe 2, per QR-Code vor Ort oder Termin). Ergebnisse zeigen Gesamt- und verifizierte
Stimmen getrennt aus.

**Vertrauen ist Architektur, nicht Versprechen.**

- **Geheime Stimmabgabe:** Die Wahl ist mit der Person technisch nicht verkettbar
  (pseudonyme HMAC-Referenzen, kein Klartext-Bezug, Audit-Log grundsätzlich PII-frei).
  Details: [`docs/architecture/VOTE_PRIVACY.md`](docs/architecture/VOTE_PRIVACY.md)
- **Beleg-Codes:** Jede Stimme erhält einen anonymen Beleg-Code. Nach Ende der Abstimmung
  wird die Liste aller Codes veröffentlicht — jede*r kann prüfen, dass die eigene Stimme
  enthalten ist, ohne dass der Beleg je verrät, *wie* abgestimmt wurde.
- **k-Anonymität:** Kleine Teilnehmerzahlen werden maskiert, damit niemand
  rückrechenbar ist. Details: [`docs/architecture/K_ANONYMITY.md`](docs/architecture/K_ANONYMITY.md)
- **Menschliches Freigabe-Gate:** Ratsinfo-Digests werden nie automatisch veröffentlicht.
  Jede Aussage trägt einen Quellenlink ins Ratsinformationssystem; Redaktion und Freigabe
  sind getrennte Rollen (Vier-Augen-Prinzip).
- **Überparteilichkeit als Regel:** Keine Wertung, keine Empfehlung, kein Targeting.
  Die Plattform stellt Fragen und belegt Fakten — Position beziehen die Menschen.

**Digitale Souveränität.** Selbst gehostet in Deutschland, Verbreitung ausschließlich
über offene Protokolle: eigene Digest-Seiten mit RSS, ein eigener ActivityPub-Server
(Fediverse/Mastodon) und AT-Protocol (Bluesky) über einen europäischen Server. Kein
Telegram, kein WhatsApp, keine proprietären Silos in der Kette (siehe
[ADR-021](docs/decisions/ADR-021-souveraene-kanalstrategie.md)).

## Architektur in einem Absatz

Next.js 16 (App Router, TypeScript strict) · PostgreSQL 16 · Drizzle ORM mit
SQL-Migrationen · passwortlose Magic-Link-Auth (httpOnly-Sessions) · host-basierte
Multi-Tenancy (eine Instanz, viele Kommunen; im Pilot single-domain mit PLZ-Einstieg) ·
Rollen mit geografischem Scope (Ortsteil/Stadt/Kreis/Land). Alle wesentlichen
Entscheidungen sind als ADRs dokumentiert: [`docs/decisions/`](docs/decisions/).

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

## Projektstand

Partizip ist ein **laufender Pilot** (seit Juli 2026 öffentlich, Region Taunusstein /
Rheingau-Taunus-Kreis) — kein fertiges Produkt. Die Kernschleife funktioniert Ende-zu-Ende:
Frage erstellen → teilen → abstimmen → verifizieren → Ergebnis mit Beleg-Liste →
benachrichtigt werden. Vieles ist bewusst noch klein gehalten; Roadmap-Themen (u. a.
Mehr-Kommunen-Ausbau, eID-Verifizierung, Passkeys) stehen in den ADRs.

## Mitmachen

Beiträge sind willkommen — von Kommunen, Entwickler*innen und allen, die digitale
Bürgerbeteiligung ernst nehmen. Bitte zuerst [CONTRIBUTING.md](CONTRIBUTING.md) lesen
(Konventionen, Tests, Grundregeln wie Tenant-Isolation und Secret-Ballot-Schutz).
Sicherheitslücken bitte **nicht** als öffentliches Issue melden: [SECURITY.md](SECURITY.md).

Kontakt für Kommunen und alles andere: **patrick@seidler.ml**

## Lizenz

[GNU AGPL-3.0](LICENSE) — wer Partizip betreibt oder verändert (auch als Webdienst),
macht seine Änderungen wieder frei. So bleibt die Plattform das, was sie verspricht:
nachvollziehbar für alle.
