/**
 * gebiet.test.ts — DB-Integrationstest der Gebiets-Zuständigkeit (Audit M2).
 *
 * Prüft die ECHTE Funktion istGebietsZustaendig gegen einen echten ltree-Baum
 * (Bund→Land→Kreis→Gemeinde→2 Ortsteile; path wird per Trigger berechnet).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { istGebietsZustaendig, waehleAnkerRegionId } from "@/lib/polls/gebiet";

const { tenants, regions } = schema;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");
const TEST_DB_URL = process.env.DATABASE_URL_TEST;
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}"`);
}
const SKIP = !TEST_DB_URL;
type DbType = ReturnType<typeof drizzle>;

describe("polls/gebiet — istGebietsZustaendig (Audit M2)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let gemeindeId: string, wehenId: string, hahnId: string, kreisId: string;

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql_ = postgres(TEST_DB_URL!, { max: 4 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [t] = await db.insert(tenants).values({ slug: `geb-${Date.now()}`, name: "Gebiet-Test" }).returning();
    tenantId = t.id;

    // Baum (path wird per Trigger aus parent_id + path_label berechnet).
    const [de] = await db.insert(regions).values({ typ: "bund", pathLabel: "de", name: "Deutschland" }).returning();
    const [land] = await db.insert(regions).values({ typ: "land", pathLabel: "hessen", name: "Hessen", parentId: de.id }).returning();
    const [kreis] = await db.insert(regions).values({ typ: "kreis", pathLabel: "rtk", name: "RTK", parentId: land.id }).returning();
    kreisId = kreis.id;
    const [gem] = await db.insert(regions).values({ typ: "gemeinde", pathLabel: "taunusstein", name: "Taunusstein", parentId: kreis.id, tenantId }).returning();
    gemeindeId = gem.id;
    const [wehen] = await db.insert(regions).values({ typ: "ortsteil", pathLabel: "wehen", name: "Wehen", parentId: gem.id, tenantId }).returning();
    wehenId = wehen.id;
    const [hahn] = await db.insert(regions).values({ typ: "ortsteil", pathLabel: "hahn", name: "Hahn", parentId: gem.id, tenantId }).returning();
    hahnId = hahn.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("Ortsteil-Frage: Bewohner desselben Ortsteils darf", async () => {
    expect(await istGebietsZustaendig(db as never, tenantId, wehenId, wehenId)).toBe(true);
  });

  it.skipIf(SKIP)("Ortsteil-Frage: Bewohner eines ANDEREN Ortsteils darf NICHT (M2-Kern)", async () => {
    expect(await istGebietsZustaendig(db as never, tenantId, wehenId, hahnId)).toBe(false);
  });

  it.skipIf(SKIP)("Gemeinde-Frage: Ortsteil-Bewohner darf (Gemeinde ist Vorfahre)", async () => {
    expect(await istGebietsZustaendig(db as never, tenantId, gemeindeId, hahnId)).toBe(true);
  });

  it.skipIf(SKIP)("Kreis-Frage: Ortsteil-Bewohner darf (Kreis ist Vorfahre)", async () => {
    expect(await istGebietsZustaendig(db as never, tenantId, kreisId, wehenId)).toBe(true);
  });

  it.skipIf(SKIP)("Ohne Anker: Gemeinde-Fallback → Gemeinde-Frage ja, Ortsteil-Frage nein", async () => {
    expect(await istGebietsZustaendig(db as never, tenantId, gemeindeId, null)).toBe(true);
    expect(await istGebietsZustaendig(db as never, tenantId, wehenId, null)).toBe(false);
  });

  it.skipIf(SKIP)("Bund-Frage: jeder Tenant-Nutzer darf (Wurzel ist Vorfahre)", async () => {
    // Bund-Knoten 'de' ist Vorfahre jedes Ankers → immer zuständig.
    const [de] = await db.select({ id: regions.id }).from(regions).where(eq(regions.pathLabel, "de"));
    expect(await istGebietsZustaendig(db as never, tenantId, de.id, wehenId)).toBe(true);
    expect(await istGebietsZustaendig(db as never, tenantId, de.id, null)).toBe(true);
  });

  it("waehleAnkerRegionId: verbindlich = NUR residency (kein home-Fallback, Gate-B MAJOR)", () => {
    const u = { residencyRegionId: "res", homeRegionId: "home" };
    expect(waehleAnkerRegionId(u, true)).toBe("res");
    expect(waehleAnkerRegionId(u, false)).toBe("home");
    // Kernfix: verbindlich + residency NULL → null (→ Gemeinde-Fallback), NICHT home.
    expect(waehleAnkerRegionId({ residencyRegionId: null, homeRegionId: "home" }, true)).toBeNull();
    // unverbindlich fällt weiter auf residency zurück, wenn home fehlt.
    expect(waehleAnkerRegionId({ residencyRegionId: "res", homeRegionId: null }, false)).toBe("res");
  });

  it.skipIf(SKIP)("Gate-B MAJOR: verbindliche Ortsteil-Frage — residency NULL + selbst-gesetztes home darf NICHT", async () => {
    // Bestands-Verifizierter ohne residency-Anker, home selbst auf Ortsteil B gesetzt.
    const anker = waehleAnkerRegionId({ residencyRegionId: null, homeRegionId: hahnId }, true);
    // Anker ist null → Gemeinde-Fallback → Ortsteil-Frage (Wehen) NICHT zuständig.
    expect(await istGebietsZustaendig(db as never, tenantId, wehenId, anker)).toBe(false);
    // Gegenprobe: dieselbe Person darf die verbindliche GEMEINDE-Frage (Fallback greift).
    expect(await istGebietsZustaendig(db as never, tenantId, gemeindeId, anker)).toBe(true);
  });
});
