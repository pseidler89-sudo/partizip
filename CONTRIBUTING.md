# Mitwirken an Partizip

Danke für dein Interesse! Partizip ist eine Plattform, der Menschen ihre (geheime)
Stimme anvertrauen — deshalb gelten hier ein paar Regeln strenger als anderswo.

## Entwicklung aufsetzen

Siehe [README → Quickstart](README.md#quickstart-lokale-entwicklung). Kurzfassung:
Node 22, Docker, `infra/docker-compose.dev.yml` starten, `.env.example` kopieren,
migrieren, seeden, `npm run dev`.

## Workflow

1. **Issue zuerst** bei allem, was größer als ein Tippfehler ist — kurz beschreiben,
   was und warum. Das erspart Arbeit an Dingen, die konzeptionell nicht passen
   (Überparteilichkeit und Datensparsamkeit sind nicht verhandelbar, siehe unten).
2. **Feature-Branch → Pull Request nach `main`.** Direkte Pushes auf `main` sind blockiert.
3. **CI muss grün sein:** Lint · Typecheck · Test · Build. Kleine, fokussierte Commits
   im [Conventional-Commits](https://www.conventionalcommits.org/)-Stil
   (`feat(polls): …`, `fix(auth): …`).
4. Architekturentscheidungen werden als **ADR** in `docs/decisions/` festgehalten —
   wenn dein PR eine trifft, gehört ein kurzes ADR dazu.

## Tests & Qualitätsgates

```bash
cd app
npm run typecheck        # TS strict, 0 Fehler
npm run lint             # ESLint mit --max-warnings 0, inkl. hartem jsx-a11y-Gate
npx vitest run           # volle Suite; Integrationstests brauchen DATABASE_URL_TEST
```

Integrationstests laufen gegen eine echte PostgreSQL-16-Datenbank (lokal z. B. ein
Wegwerf-Container). Zwei Konventionen sind Pflicht:

- **Tests rufen die echten Funktionen auf** — niemals die Logik im Test nachbauen.
- **Barrierefreiheit ist ein Gate, kein Nice-to-have:** 0 Lint-Warnungen, auch a11y.

## Nicht verhandelbare Grundregeln im Code

Diese Invarianten schützen das Vertrauensmodell. PRs, die sie verletzen, werden nicht
gemergt — im Zweifel vorher fragen:

- **Secret Ballot:** Die Wahl (`choice`) darf nirgends mit einer Person verkettbar
  werden — nie ins Audit-Log, nie in Belege, nie in neue Tabellen mit User-Bezug.
  Pflichtlektüre: `docs/architecture/VOTE_PRIVACY.md`.
- **Tenant-Isolation in jeder Query:** Jede Datenbankabfrage ist auf den Tenant
  gescopet; `tenantId`/`userId` kommen serverseitig aus dem Kontext, nie vom Client.
- **`"use server"`-Dateien exportieren nur Actions.** Lese-Queries leben in separaten
  Modulen — sonst entstehen client-aufrufbare RPCs mit client-kontrollierten Parametern.
- **Audit-Log ist PII-frei:** UUIDs/Pseudonyme statt E-Mail-Adressen, keine Klartext-Namen.
- **Eligibility immer über `getStufe(...)`** (mit vollständiger User-Row, wegen Abläufen) —
  nie Status-Felder direkt interpretieren.
- **Atomare Statusübergänge:** bedingte `UPDATE … WHERE status = <erwartet>` mit
  Rowcount-Prüfung statt Read-Modify-Write; Kapazitäten/Races per bedingtem Update
  oder Transaktion.
- **Kein JS-`Date` in rohem SQL** — Drizzle-Operatoren verwenden; DB-Zeit via `now()`.
- **Keine neuen Abhängigkeiten ohne Not** — insbesondere keine proprietären Dienste in
  der Verbreitungs- oder Datenkette (ADR-021).

## Sprache & Ton

Die Plattform spricht Deutsch und siezt konsequent („Sie"). UI-Texte sind neutral,
wertungsfrei und ohne parteipolitische Färbung — das gilt auch für Beispieldaten,
Seeds und Testinhalte.

## Sicherheit

Sicherheitsrelevante Funde bitte **nicht** öffentlich melden — siehe [SECURITY.md](SECURITY.md).

## Verhalten

Sachlich, respektvoll, konstruktiv. Partizip ist ein überparteiliches Projekt:
Parteipolitische Auseinandersetzungen haben im Issue-Tracker keinen Platz.
