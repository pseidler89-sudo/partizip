# ADR-004 — Drizzle ORM + drizzle-kit generate für versionierte SQL-Migrationen

**Datum:** 2026-06-10 · **Status:** Entschieden (M1) · **Bezug:** SALVAGE_REPORT Kap. 3, 6

**Entscheidung:** ORM: Drizzle (drizzle-orm + drizzle-kit), SQL-Dialekt PostgreSQL.
Migrationen werden per `drizzle-kit generate` als versionierte `.sql`-Dateien in
`db/migrations/` erzeugt und via `drizzle-orm/postgres-js/migrator` angewandt
(`app/scripts/migrate.ts`). Design-Referenz: `planning/db/migrations/0001_init.sql`
(Trust-Layer-Qualität). Eigener Seed-Runner (`app/scripts/seed.ts`) mit
`ON CONFLICT`-Idempotenz.

**Gründe:** SQL-first passt zu versionierten Migrationen; kein Prisma-Bestandsschutz
nötig (Neubau); `drizzle-kit generate` erzeugt prüfbares SQL im Repo.

**Konsequenz:** `drizzle-kit generate` läuft lokal; generiertes SQL wird committet
und ist damit Code-reviewed; kein `db push` in Produktion.
