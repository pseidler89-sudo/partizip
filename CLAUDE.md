# CLAUDE.md — Partizip

Überparteiliche kommunale Beteiligungsplattform. Bürger werden zu lokalen Fragen
gefragt; Ergebnisse weisen aus, wie viele Stimmen wohnsitzverifiziert sind.

Next.js 16 (App Router, TS strict) · Tailwind 4 · PostgreSQL 16 · Drizzle ORM mit
SQL-Migrationen in `db/migrations/` · eigene Magic-Link-Auth · Vitest · Docker/Traefik.
Multi-Tenant host-basiert (Subdomain → Tenant via Middleware). Gebiete als Baum
(`regions`, ltree) — Sichtbarkeit ergibt sich aus der Hierarchie, nicht aus einem Enum.

Hintergrund und Begründungen: `docs/decisions/ADR-*` · `docs/architecture/`.

## Kommandos

Alles aus `app/`:

```bash
npm run lint          # --max-warnings 0, hartes a11y-Gate (jsx-a11y) — 0 Warnungen Pflicht
npm run typecheck
npm run test

# Volle Suite gegen ephemere Datenbank
docker run -d --name verify -e POSTGRES_PASSWORD=partizip -e POSTGRES_USER=partizip \
  -e POSTGRES_DB=partizip_test -p 127.0.0.1:55460:5432 postgres:16-alpine
DATABASE_URL_TEST=postgres://partizip:partizip@127.0.0.1:55460/partizip_test npx vitest run
docker rm -f verify

# Migration: erst src/db/schema.ts editieren, dann
npm run db:generate                    # Ausgabe nach ../db/migrations
npx drizzle-kit generate --custom      # Daten-Migration
npm run db:upgrade                     # seed:regions + migrate, in dieser Reihenfolge
```

CI prüft zusätzlich Schema-Drift und den Upgrade-Pfad gegen die Konstellation
beider Tenants. Jeder Push braucht grüne CI; main ist geschützt.

## Fallstricke (real passiert — nicht wiederholen)

- **Kein JS-`Date` in Roh-``sql`` `` ** → Treiber-Abbruch, 500. Drizzle-Operatoren nutzen; `sql\`now()\`` ist ok.
- **`"use server"`-Dateien exportieren nur Actions.** Lese-Queries gehören in ein eigenes Modul — sonst entsteht eine client-aufrufbare RPC mit client-kontrolliertem `tenantId`.
- **Tenant-Filter in jeder Query** (`eq(..tenantId)`). `tenantId` und `userId` kommen serverseitig aus dem Kontext, nie vom Client.
- **Stufe-2-Gates immer über `getStufe(volle user-row)`** — `verificationStatus` direkt zu lesen übersieht den 24-Monats-Ablauf der Wohnsitzverifizierung.
- **Wahlgeheimnis:** die Wahl (`choice`) nie ins Audit; Audit-Einträge bleiben PII-frei (UUID statt E-Mail).
- **Atomare Statuswechsel:** `UPDATE … WHERE status=<erwartet> RETURNING` und rowCount prüfen; Caps und Races über Transaktion bzw. `pg_advisory_xact_lock`. Best-effort-Nebeneffekte (Mailversand) außerhalb der Transaktion, mit try/catch.
- **Tests müssen die echten Funktionen aufrufen**, nicht deren Logik nachbauen — sonst schlüpfen Query-Bugs durch. Muster: `src/lib/polls/__tests__/queries.test.ts`.
- **Fixtures sind eingefangene echte Antworten, nie handgeschriebenes Wunsch-HTML.** Ein erfundenes Fixture lässt die Suite gegen eine Struktur grün laufen, die es draußen nicht gibt — genau das hat den AllRIS-Bug (#61) ermöglicht *und* danach verdeckt: Tests grün, Parser blind. Neues Fixture = echte Antwort speichern, Quelle und Abrufdatum im Kopf vermerken, dann den Parser dagegen schreiben. Fixture anzupassen, damit ein Test grün wird, ist die Fehlerrichtung.
- **Migrationen laufen gegen alle Tenants**, nicht nur den Pilot. Additiv arbeiten (Expand/Contract); eine Migration muss auch dann durchlaufen, wenn ein Tenant Vorbedingungen nicht erfüllt. Neue Kommune = Eintrag in `db/seeds/regionen.json`.
- Pfade mit `[tenant]` in Globs quoten.

## Sicherheitskritische Flächen

Änderungen an Auth, Tenant-Isolation, Voting/Verifizierung, Rollen, Migrationen
oder DSGVO-Funktionen brauchen einen adversarialen Zweit-Review, bevor sie
gemergt werden. `.env` wird nie gelesen, geändert oder geloggt.
