# Selbst-Hosting — Partizip in Produktion betreiben

Diese Anleitung beschreibt einen generischen Produktions-Betrieb mit Docker.
Sie ist bewusst knapp gehalten; die verbindliche Quelle für Details ist der Code
(`Dockerfile`, `app/package.json`, `.env.example`). Für die lokale Entwicklung
siehe den Quickstart in der [README](../../README.md).

## Voraussetzungen

- **Docker** mit Compose-Plugin auf einem Linux-Server.
- **PostgreSQL 16** — als Container oder extern. Die Datenbank-Rolle braucht
  einmalig das Recht, `CREATE EXTENSION ltree` auszuführen (der Gebietsbaum
  nutzt `ltree`; die Migration legt die Extension selbst an, wenn sie darf).
- **Reverse-Proxy mit TLS** (z. B. Traefik, Caddy, nginx) vor der App. Die App
  selbst spricht nur HTTP auf Port 3000. Die Multi-Tenancy ist host-basiert —
  der Proxy muss den `Host`-Header unverändert durchreichen.
- **SMTP-Zugang** für Magic-Link-Anmeldung und Benachrichtigungen. Ohne
  funktionierenden Mailversand können sich Nutzer nicht anmelden.

## Images bauen

Das `Dockerfile` im Repo-Root hat zwei Ziele (Build-Kontext ist das Repo-Root,
weil `db/migrations` gebraucht wird):

```bash
docker build -t partizip-app   --target runner .   # schlankes Laufzeit-Image
docker build -t partizip-tools --target tools  .   # Migrationen, Seeds, CLI-Skripte
```

## Compose-Grundriss

Ein minimaler Produktions-Stack besteht aus `db`, `app` und einem `tools`-Dienst
in einem eigenen Compose-Profil (läuft nur auf Zuruf, nie dauerhaft):

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: partizip
      POSTGRES_USER: partizip
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data

  app:
    image: partizip-app
    env_file: .env
    depends_on: [db]
    # Port 3000 hinter dem Reverse-Proxy veröffentlichen

  tools:
    image: partizip-tools
    profiles: [tools]
    env_file: .env
    depends_on: [db]

volumes:
  dbdata:
```

Migrationen und Seeds laufen dann so:

```bash
docker compose --profile tools run --rm tools npm run db:migrate
```

## Erstinstallation

1. **Umgebungsvariablen** in einer `.env` neben der Compose-Datei anlegen.
   Vorlage und Dokumentation jeder Variable: [`.env.example`](../../.env.example)
   im Repo-Root. Die wichtigsten (hier bewusst ohne Werte):

   - `DATABASE_URL` — Verbindung zur Produktions-Datenbank.
   - `IP_HASH_SALT` und `ANLIEGEN_REF_SALT` — Secrets, je mit
     `openssl rand -base64 32` erzeugen. **`ANLIEGEN_REF_SALT` nach dem Start
     nie mehr ändern** (er verankert den Doppelstimmen-Schutz) und **separat
     vom Datenbank-Backup sichern** — ein Restore ohne identischen Salt macht
     alle pseudonymen Referenzen wertlos.
   - `APP_BASE_URL`, `TENANT_BASE_DOMAIN` — öffentliche URL bzw. Basis-Domain
     (z. B. `https://partizip.online` / `partizip.online`).
   - `PILOT_TENANT_SLUG` — gesetzt läuft die ganze App single-domain auf diesem
     Tenant (PLZ-Einstieg); leer gilt das Subdomain-Modell `<slug>.<domain>`.
   - `DEMO_TENANT_SLUG` — optional; macht einen Tenant zur öffentlichen
     Demo-Spielwiese (ephemere Demo-Sessions, kein echter Mailversand).
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` sowie
     `MAIL_FROM_NAME`, `MAIL_FROM_ADDRESS`, `MAIL_ADMIN_ADDRESS`.
   - Optional: `MAGIC_LINK_TTL_MIN`, `SESSION_TTL_DAYS`,
     `ALLOW_SELF_APPROVAL` (nur im dokumentierten Ein-Personen-Pilotfall,
     siehe `.env.example`).

2. **Tenant und Gebietsbaum konfigurieren** (siehe „Neue Kommune" unten):
   `db/seeds/tenants.json` und `db/seeds/regionen.json` um die eigene Kommune
   ergänzen, dann die Images bauen.

3. **Datenbank aufbauen** (frische Datenbank — Reihenfolge: Migrationen,
   dann Stammdaten, dann Gebietsbaum):

   ```bash
   docker compose --profile tools run --rm tools npm run db:migrate
   docker compose --profile tools run --rm tools npm run db:seed
   docker compose --profile tools run --rm tools npm run db:seed:regions
   ```

4. **App starten** (`docker compose up -d app`) und den Reverse-Proxy auf
   Port 3000 zeigen lassen.

5. **Ersten Admin anlegen** — nur der allererste Admin kommt per CLI, alle
   weiteren Mitwirkenden danach über den auditierten Einladungs-Flow in der App:

   ```bash
   docker compose --profile tools run --rm tools \
     npm run grant-role -- --tenant <slug> --email admin@example.org --role kommune_admin
   ```

## Migrationen & Upgrades

- Für das **Upgrade einer Bestands-Datenbank** gibt es `npm run db:upgrade`:
  es führt **erst den Gebietsbaum-Seed, dann die Migrationen** aus
  (`db:seed:regions` → `db:migrate`). Diese Reihenfolge ist Absicht — Migrationen
  können voraussetzen, dass der Baum für alle Tenants existiert (die CI testet
  genau diesen Upgrade-Pfad).
- Sichere Update-Reihenfolge bei Schema-Änderungen:
  **App stoppen → neue Images bauen → `db:upgrade` → Ergebnis prüfen →
  erst dann die neue App starten.** Die alte App gegen ein neues Schema (oder
  die neue App gegen ein altes Schema) laufen zu lassen, riskiert Fehler.
- Der Gebietsbaum-Seed ist idempotent und rein additiv; er läuft standardmäßig
  **fail-fast**: Existiert ein Tenant mit Fachdaten, aber ohne Eintrag in
  `regionen.json`, bricht er ab, statt einen halben Zustand zu hinterlassen
  (`--no-strict` schaltet diese Härte ab — nicht empfohlen).

## Neue Kommune anlegen

Eine neue Kommune ist ein Konfigurations-Eintrag, kein Code:

1. Tenant in `db/seeds/tenants.json` ergänzen (Slug, Name, Branding).
2. Gebietszweig in `db/seeds/regionen.json` ergänzen — Land → Kreis → Gemeinde
   mit amtlichen Schlüsseln (AGS/ARS), Ortsteile werden aus den
   Ortsteil-Seed-Daten des Tenants gespiegelt.
3. Seeds ausführen:

   ```bash
   docker compose --profile tools run --rm tools npm run db:seed
   docker compose --profile tools run --rm tools npm run db:seed:regions
   ```

4. Ersten Admin der Kommune per `grant-role` anlegen (siehe oben).

## Backups

- **Nächtlicher `pg_dump`** per Cron, z. B.:

  ```bash
  docker compose exec -T db pg_dump -U partizip -Fc partizip > backup-$(date +%F).dump
  ```

- **Restore regelmäßig proben** — ein Backup, das nie zurückgespielt wurde,
  ist keins. Probe gegen eine Wegwerf-Datenbank, nicht gegen die Produktion.
- Die **Salt-Secrets gehören mit ins Backup-Konzept** (getrennt von den Dumps
  aufbewahren): Datenbank plus identische Salts = wiederherstellbar; Datenbank
  ohne Salts = pseudonyme Referenzen unbrauchbar.
- Eine Kopie außer Haus (Offsite) wird empfohlen — verschlüsselt.

## Betrieb

- **Feature-Flags:** Build-Zeit-Schalter liegen zentral in
  [`app/src/lib/features.ts`](../../app/src/lib/features.ts) (z. B. das geparkte
  Anliegen-Einreichen). Ändern = Flag umstellen und Image neu bauen.
- **Betreiber-CLIs** (alle über das tools-Profil, jede Aktion landet PII-frei
  im Audit-Log):
  - `npm run grant-role -- --tenant <slug> --email <mail> --role <rolle>` —
    Bootstrap/Notfall; im Regelbetrieb läuft Rollenvergabe über den
    Einladungs-Flow in der App.
  - `npm run grant-residency -- --tenant <slug> --email <mail>` —
    Wohnsitz-Verifizierung als Betreiber-Override (Regelweg ist die
    Verifizierung vor Ort per Konto-QR).
- **Demo-Tenant** (optional): mit `DEMO_TENANT_SLUG` markieren,
  `npm run db:seed:musterstadt` füllt ihn, `npm run demo:reset` (z. B. als
  nächtlicher Cron) setzt ihn zurück.
- **Logs beobachten:** `docker compose logs -f app`. Die App loggt keine
  Klartext-E-Mails und keine Stimm-Inhalte — das soll beim Betrieb so bleiben.
