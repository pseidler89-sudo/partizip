/**
 * test-upgrade-path.ts — beweist die ZWINGENDE Prod-Reihenfolge für ein Upgrade
 * einer BESTANDS-DB: `db:seed:regions` VOR `db:migrate` (ADR-024, GEBIETSMODELL §6).
 *
 * WARUM: Die CI testet sonst nur den FRESH-Pfad (leere DB → alle Migrationen).
 * Genau die Upgrade-Lücke — eine bereits bis 0023 migrierte DB MIT Fachzeilen
 * (Polls/Rollen/QR/Standorte/Einladungen), auf der der Gebietsbaum erst geseedet
 * werden muss, BEVOR 0024/0025 den strengen region_id-Backfill fahren — verursachte
 * einen realen Prod-Deploy-Ausfall. Dieser Test schließt sie.
 *
 * ABLAUF (gegen ephemere PG16):
 *   1. Schema zurücksetzen; Migrationen NUR bis 0023 anwenden (Bestands-Stand vor
 *      dem Gebietsbaum-FK-Umbau; regions/plz_regions existieren ab 0023).
 *   2. Zwei Tenants (taunusstein + demo) mit Ortsteilen und Fachzeilen einfügen —
 *      polls/roles/qr_codes/verification_locations/invitations, inkl. Ortsteil-Scope.
 *      Roh-SQL, da scope_level/scope_code im aktuellen Schema (post-0025) nicht mehr
 *      existieren.
 *   3. `seedRegions` — legt den Gebietsbaum aus db/seeds/regionen.json an (die reale
 *      Prod-Aktion `db:seed:regions`).
 *   4. Restliche Migrationen (0024, 0025) anwenden → MUSS grün durchlaufen
 *      (0 NULL region_id auf allen Fachtabellen).
 *
 * Exit 0 = grün, Exit 1 = Upgrade-Pfad gebrochen. Verdrahtet als `npm run test:upgrade`
 * und als eigener CI-Job (siehe .github/workflows/ci.yml → job "upgrade-path").
 *
 * Env: DATABASE_URL (MUSS auf eine DB mit Suffix "_test" zeigen — Sicherheitsgurt).
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { seedRegions } from "./seed-regions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../db/migrations");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("test:upgrade FEHLER: DATABASE_URL nicht gesetzt.");
  process.exit(1);
}
const dbName = new URL(databaseUrl).pathname.replace(/^\//, "");
if (!dbName.endsWith("_test")) {
  console.error(`test:upgrade SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test".`);
  process.exit(1);
}

/** Stopp-Index für den Bestands-Stand: alle Migrationen mit idx <= 23. */
const STOP_IDX = 23;

/**
 * Baut einen temporären Migrations-Ordner, dessen _journal.json nur die Einträge bis
 * STOP_IDX enthält (die `.sql`-Dateien + `when`-Zeitstempel bleiben unverändert). So
 * wendet der ECHTE Drizzle-Migrator exakt 0000..0023 an; ein späterer Lauf gegen den
 * VOLLEN Ordner erkennt via `__drizzle_migrations` (created_at = journal `when`) nur
 * 0024/0025 als ausstehend und wendet genau diese an — die reale Upgrade-Situation.
 */
function baueTeilMigrationsOrdner(): string {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf-8")
  ) as { entries: { idx: number; tag: string }[] };

  const tmp = mkdtempSync(path.join(tmpdir(), "partizip-upgrade-"));
  cpSync(migrationsFolder, tmp, { recursive: true });

  journal.entries = journal.entries.filter((e) => e.idx <= STOP_IDX);
  writeFileSync(path.join(tmp, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  return tmp;
}

/** Ein Tenant-Fixture: Slug + Ortsteil-Codes (der erste wird für Ortsteil-Scopes genutzt). */
interface TenantFixture {
  slug: string;
  name: string;
  ortsteile: string[];
}

const FIXTURES: TenantFixture[] = [
  { slug: "taunusstein", name: "Taunusstein", ortsteile: ["wehen", "hahn"] },
  { slug: "demo", name: "Musterstadt (Demo)", ortsteile: ["altstadt"] },
];

/** Fügt für einen Tenant Bestands-Fachzeilen mit scope_level/scope_code ein (0023-Stand). */
async function fuelleFachzeilen(sql: postgres.Sql, fx: TenantFixture): Promise<void> {
  const [{ id: tenantId }] = await sql<{ id: string }[]>`
    INSERT INTO tenants (slug, name) VALUES (${fx.slug}, ${fx.name}) RETURNING id
  `;

  for (const code of fx.ortsteile) {
    const name = code.charAt(0).toUpperCase() + code.slice(1);
    await sql`INSERT INTO ortsteile (tenant_id, code, name) VALUES (${tenantId}, ${code}, ${name})`;
  }

  const ort = fx.ortsteile[0];
  const [{ id: userA }] = await sql<{ id: string }[]>`
    INSERT INTO users (tenant_id, email) VALUES (${tenantId}, ${`a-${fx.slug}@t.example`}) RETURNING id
  `;
  const [{ id: userB }] = await sql<{ id: string }[]>`
    INSERT INTO users (tenant_id, email) VALUES (${tenantId}, ${`b-${fx.slug}@t.example`}) RETURNING id
  `;

  // Polls: stadt (→ Gemeinde) + kreis (→ Kreis-Vorfahr).
  await sql`INSERT INTO polls (tenant_id, scope_level, scope_code, frage)
            VALUES (${tenantId}, 'stadt', NULL, ${`Stadt-Frage ${fx.slug}?`})`;
  await sql`INSERT INTO polls (tenant_id, scope_level, scope_code, frage)
            VALUES (${tenantId}, 'kreis', NULL, ${`Kreis-Frage ${fx.slug}?`})`;

  // Rollen: userA auf Ortsteil-Scope, userB auf Stadt-Scope (verschiedene Knoten →
  // KEINE Kollision unter dem neuen (tenant,user,role_type,region_id)-UNIQUE).
  await sql`INSERT INTO roles (tenant_id, user_id, role_type, scope_level, scope_code)
            VALUES (${tenantId}, ${userA}, 'verifier', 'ortsteil', ${ort})`;
  await sql`INSERT INTO roles (tenant_id, user_id, role_type, scope_level, scope_code)
            VALUES (${tenantId}, ${userB}, 'verifier', 'stadt', NULL)`;

  // QR-Code: land-Scope (→ Land-Vorfahr).
  await sql`INSERT INTO qr_codes (tenant_id, scope_level, scope_code, token_hash, max_redemptions, expires_at)
            VALUES (${tenantId}, 'land', NULL, ${`qr-${fx.slug}`}, 5, now() + interval '1 day')`;

  // Verifikations-Standort (kein scope_level → Gemeinde-Knoten via Trigger/Backfill).
  await sql`INSERT INTO verification_locations (tenant_id, name)
            VALUES (${tenantId}, ${`Rathaus ${fx.slug}`})`;

  // Einladung (aufgeschobene Rolle) auf Ortsteil-Scope — die 0025-Neuerung.
  await sql`INSERT INTO invitations (tenant_id, email, role_type, scope_level, scope_code, token_hash, expires_at)
            VALUES (${tenantId}, ${`invite-${fx.slug}@t.example`}, 'verifier', 'ortsteil', ${ort}, ${`inv-${fx.slug}`}, now() + interval '7 days')`;
}

async function assertKeineNull(sql: postgres.Sql, table: string): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(table)} WHERE region_id IS NULL
  `;
  if (Number(n) !== 0) {
    throw new Error(`${table}: ${n} Zeile(n) mit region_id IS NULL nach dem Upgrade — Backfill unvollständig`);
  }
}

async function main(): Promise<void> {
  // 1. Schema zurücksetzen + bis 0023 migrieren (Bestands-Stand).
  const reset = postgres(databaseUrl!, { max: 1 });
  await reset`DROP SCHEMA IF EXISTS public CASCADE`;
  await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await reset`CREATE SCHEMA public`;
  await reset.end();

  const teilOrdner = baueTeilMigrationsOrdner();
  const sql = postgres(databaseUrl!, { max: 1 });
  const db = drizzle(sql);
  try {
    console.log(`[1] Migrationen bis idx ${STOP_IDX} (Bestands-Stand) …`);
    await migrate(db, { migrationsFolder: teilOrdner });

    console.log("[2] Bestands-Fachzeilen (scope_level/scope_code) einfügen …");
    for (const fx of FIXTURES) await fuelleFachzeilen(sql, fx);

    console.log("[3] db:seed:regions (Gebietsbaum aus db/seeds/regionen.json) …");
    const seedRes = await seedRegions(db);
    if (seedRes.fachOhneZweigTenantIds.length > 0) {
      throw new Error(
        `Seed meldet Fachzeilen ohne Gebietszweig: ${seedRes.fachOhneZweigTenantIds.join(", ")} ` +
          `— Config-Eintrag fehlt (der Upgrade-Pfad bräche bei 0024 ab).`
      );
    }

    console.log("[4] Restliche Migrationen (0024, 0025) …");
    await migrate(db, { migrationsFolder });

    console.log("[5] Verifikation: 0 NULL region_id auf allen Fachtabellen …");
    for (const t of ["polls", "roles", "qr_codes", "verification_locations", "invitations"]) {
      await assertKeineNull(sql, t);
    }

    // Gegenprobe: die neue roles-UNIQUE ist tatsächlich aktiv (Contract vollzogen).
    const [{ n: uniq }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'roles_tenant_user_role_region_unique'
    `;
    if (Number(uniq) !== 1) throw new Error("roles_tenant_user_role_region_unique fehlt nach 0025");

    console.log("test:upgrade OK — Upgrade-Pfad (seed vor migrate) grün.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("test:upgrade FEHLGESCHLAGEN:", err);
  process.exit(1);
});
