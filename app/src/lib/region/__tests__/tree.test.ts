/**
 * tree.test.ts — DB-Integrationstests für das Gebietsbaum-Fundament (ADR-024,
 * GEBIETSMODELL). Prüft:
 *   - Baum-Integrität: genau eine Wurzel; path konsistent mit der parent-Kette;
 *     der Trigger pflegt path bei Insert UND bei Move (Umhängen) inkl. Nachfahren.
 *   - Baum-Primitive: Vorfahren / direkte Kinder / Nachfahren / vertikale Scheibe.
 *   - Seed + Backfill: Ortsteile & PLZ vollständig gespiegelt, users.ortsteil_id
 *     → home_region_id; amtliche Schlüssel (ARS/AGS) vorhanden; Seed idempotent
 *     (zweimal ⇒ identisch).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst geskippt).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import {
  getRegion,
  getVorfahren,
  getKinder,
  getNachfahren,
  getVertikaleScheibe,
} from "@/lib/region/tree";
import { seedRegions } from "../../../../scripts/seed-regions.js";

const { tenants, ortsteile, plzRegionen, users, regions } = schema;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");

const TEST_DB_URL = process.env.DATABASE_URL_TEST;
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test"`);
  }
}
const SKIP = !TEST_DB_URL;

type DbType = ReturnType<typeof drizzle>;

const ORTSTEIL_CODES = [
  "bleidenstadt",
  "hahn",
  "hambach",
  "neuhof",
  "niederlibbach",
  "orlen",
  "seitzenhahn",
  "watzhahn",
  "wehen",
  "wingsbach",
];

describe("region/tree + seed-regions (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let userId: string;

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

    // Pilot-Bestandsdaten (wie in db/seeds), damit der Backfill etwas findet.
    const [t] = await db
      .insert(tenants)
      .values({ slug: "taunusstein", name: "Taunusstein" })
      .returning();
    tenantId = t.id;

    await db.insert(ortsteile).values(
      ORTSTEIL_CODES.map((code) => ({
        tenantId,
        code,
        name: code.charAt(0).toUpperCase() + code.slice(1),
      }))
    );

    await db
      .insert(plzRegionen)
      .values({ tenantId, plz: "65232", ortsteilCode: null, lat: "50.1466", lon: "8.1505" });

    const [u] = await db
      .insert(users)
      .values({ tenantId, email: "buerger@example.org" })
      .returning();
    userId = u.id;
    // ortsteil_id des Users auf "wehen" setzen (Backfill-Quelle).
    const [wehen] = await db
      .select({ id: ortsteile.id })
      .from(ortsteile)
      .where(eq(ortsteile.code, "wehen"));
    await db.update(users).set({ ortsteilId: wehen.id }).where(eq(users.id, userId));

    // Der eigentliche Seed + Backfill (die zu testende Logik).
    await seedRegions(db as never);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  // helper: hole einen Knoten per path_label
  async function byLabel(label: string) {
    const [r] = await db.select().from(regions).where(eq(regions.pathLabel, label)).limit(1);
    return r;
  }

  it.skipIf(SKIP)("amtliche Schlüssel (ARS/AGS) sind korrekt gesetzt", async () => {
    const hessen = await byLabel("hessen");
    const rtk = await byLabel("rtk");
    const ts = await byLabel("taunusstein");
    const de = await byLabel("de");

    expect(de.typ).toBe("bund");
    expect(de.ars).toBeNull();
    expect(de.ags).toBeNull();
    expect(de.parentId).toBeNull();

    expect(hessen.typ).toBe("land");
    expect(hessen.ags).toBe("06");
    expect(hessen.ars).toBe("060000000000");

    expect(rtk.typ).toBe("kreis");
    expect(rtk.ags).toBe("06439");
    expect(rtk.ars).toBe("064390000000");

    expect(ts.typ).toBe("gemeinde");
    expect(ts.ags).toBe("06439015");
    expect(ts.ars).toBe("064390015015");
    // operativer tenant_id-Marker auf der Gemeinde
    expect(ts.tenantId).toBe(tenantId);
  });

  it.skipIf(SKIP)("genau EINE Wurzel", async () => {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(regions)
      .where(sql`${regions.parentId} IS NULL`);
    expect(n).toBe(1);
  });

  it.skipIf(SKIP)("path ist konsistent mit der parent-Kette (Trigger)", async () => {
    // Kinder: path == parent.path || label
    const [{ bad }] = await db.execute<{ bad: number }>(sql`
      SELECT count(*)::int AS bad
      FROM regions c JOIN regions p ON c.parent_id = p.id
      WHERE c.path <> (p.path || text2ltree(c.path_label))
    `);
    expect(Number(bad)).toBe(0);
    // Wurzel: path == label
    const de = await byLabel("de");
    expect(de.path).toBe("de");
    const wehen = await byLabel("wehen");
    expect(wehen.path).toBe("de.hessen.rtk.taunusstein.wehen");
  });

  it.skipIf(SKIP)("Trigger setzt path bei Insert (ohne manuelle Angabe)", async () => {
    const ts = await byLabel("taunusstein");
    const [neu] = await db
      .insert(regions)
      .values({ parentId: ts.id, typ: "ortsteil", name: "Testfeld", pathLabel: "testfeld" })
      .returning();
    expect(neu.path).toBe("de.hessen.rtk.taunusstein.testfeld");
    // wieder entfernen, damit die Kinder-Zählung stabil bleibt
    await db.delete(regions).where(eq(regions.id, neu.id));
  });

  it.skipIf(SKIP)("Vorfahren: Ortsteil → [de, hessen, rtk, taunusstein]", async () => {
    const wehen = await byLabel("wehen");
    const vorfahren = await getVorfahren(db as never, wehen.id);
    expect(vorfahren.map((r) => r.pathLabel)).toEqual(["de", "hessen", "rtk", "taunusstein"]);
  });

  it.skipIf(SKIP)("direkte Kinder: Taunusstein hat genau die 10 Ortsteile", async () => {
    const ts = await byLabel("taunusstein");
    const kinder = await getKinder(db as never, ts.id);
    expect(kinder).toHaveLength(ORTSTEIL_CODES.length);
    expect(kinder.every((k) => k.typ === "ortsteil")).toBe(true);
    expect(kinder.map((k) => k.pathLabel).sort()).toEqual([...ORTSTEIL_CODES].sort());
  });

  it.skipIf(SKIP)("Nachfahren: Hessen umfasst rtk, taunusstein und alle Ortsteile", async () => {
    const hessen = await byLabel("hessen");
    const nach = await getNachfahren(db as never, hessen.id);
    const labels = nach.map((r) => r.pathLabel);
    expect(labels).toContain("rtk");
    expect(labels).toContain("taunusstein");
    for (const c of ORTSTEIL_CODES) expect(labels).toContain(c);
    // 1 kreis + 1 gemeinde + 10 ortsteile = 12
    expect(nach).toHaveLength(12);
    // hessen selbst NICHT enthalten
    expect(labels).not.toContain("hessen");
  });

  it.skipIf(SKIP)("vertikale Scheibe: Taunusstein = Vorfahren + selbst + direkte Kinder", async () => {
    const ts = await byLabel("taunusstein");
    const scheibe = await getVertikaleScheibe(db as never, ts.id);
    const labels = scheibe.map((r) => r.pathLabel);
    // Vorfahren + selbst
    for (const a of ["de", "hessen", "rtk", "taunusstein"]) expect(labels).toContain(a);
    // direkte Kinder
    for (const c of ORTSTEIL_CODES) expect(labels).toContain(c);
    // 4 (Kette inkl. selbst) + 10 Kinder = 14, KEINE Nachbarorte/fremden Knoten
    expect(scheibe).toHaveLength(14);
  });

  it.skipIf(SKIP)("Backfill: Ortsteile & PLZ & user.home_region_id vollständig", async () => {
    // 10 Ortsteil-Knoten
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(regions)
      .where(eq(regions.typ, "ortsteil"));
    expect(n).toBe(ORTSTEIL_CODES.length);

    // PLZ 65232 (ortsteil_code NULL) → auf den Gemeinde-Knoten
    const ts = await byLabel("taunusstein");
    const plzRows = await db
      .select()
      .from(schema.plzRegions)
      .where(eq(schema.plzRegions.plz, "65232"));
    expect(plzRows).toHaveLength(1);
    expect(plzRows[0].regionId).toBe(ts.id);
    expect(plzRows[0].source).toBe("backfill:plz_regionen");

    // user.ortsteil_id (wehen) → home_region_id = wehen-Regionsknoten
    const wehen = await byLabel("wehen");
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.homeRegionId).toBe(wehen.id);
    expect(u.residencyRegionId).toBeNull();
    // ortsteil_id bleibt unangetastet (rückwärtskompatibel)
    expect(u.ortsteilId).not.toBeNull();
  });

  it.skipIf(SKIP)("Seed ist idempotent (zweiter Lauf ⇒ identische Knotenzahl)", async () => {
    const countAll = async () => {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(regions);
      return n;
    };
    const before = await countAll();
    const idsBefore = (await db.select({ id: regions.id, path: regions.path }).from(regions))
      .map((r) => `${r.id}:${r.path}`)
      .sort();

    await seedRegions(db as never);

    const after = await countAll();
    const idsAfter = (await db.select({ id: regions.id, path: regions.path }).from(regions))
      .map((r) => `${r.id}:${r.path}`)
      .sort();
    expect(after).toBe(before);
    expect(idsAfter).toEqual(idsBefore);
  });

  it.skipIf(SKIP)("Trigger pflegt path bei Move inkl. Nachfahren-Kaskade", async () => {
    // Isolierter Test-Teilbaum: de → moveland → movekreis → movegem
    const de = await byLabel("de");
    const [land] = await db
      .insert(regions)
      .values({ parentId: de.id, typ: "land", name: "Moveland", pathLabel: "moveland" })
      .returning();
    const [kreis] = await db
      .insert(regions)
      .values({ parentId: land.id, typ: "kreis", name: "Movekreis", pathLabel: "movekreis" })
      .returning();
    const [gem] = await db
      .insert(regions)
      .values({ parentId: kreis.id, typ: "gemeinde", name: "Movegem", pathLabel: "movegem" })
      .returning();

    expect(kreis.path).toBe("de.moveland.movekreis");
    expect(gem.path).toBe("de.moveland.movekreis.movegem");

    // Move: kreis unter Hessen umhängen → path von kreis UND Nachfahren zieht nach.
    const hessen = await byLabel("hessen");
    await db.update(regions).set({ parentId: hessen.id }).where(eq(regions.id, kreis.id));

    const kreisNow = await getRegion(db as never, kreis.id);
    const gemNow = await getRegion(db as never, gem.id);
    expect(kreisNow!.path).toBe("de.hessen.movekreis");
    expect(gemNow!.path).toBe("de.hessen.movekreis.movegem");

    // aufräumen (Kinder zuerst wegen RESTRICT)
    await db.delete(regions).where(eq(regions.id, gem.id));
    await db.delete(regions).where(eq(regions.id, kreis.id));
    await db.delete(regions).where(eq(regions.id, land.id));
  });

  it.skipIf(SKIP)("Trigger WEIST einen Zyklus ab (kein Crash/OOM)", async () => {
    // de → cyc_land → cyc_kreis. Versuch: cyc_land unter seinen eigenen
    // Nachfahren cyc_kreis hängen → muss sauber mit Exception abgewiesen werden.
    const de = await byLabel("de");
    const [land] = await db
      .insert(regions)
      .values({ parentId: de.id, typ: "land", name: "Cycland", pathLabel: "cycland" })
      .returning();
    const [kreis] = await db
      .insert(regions)
      .values({ parentId: land.id, typ: "kreis", name: "Cyckreis", pathLabel: "cyckreis" })
      .returning();

    // drizzle umhüllt den PG-Fehler ("Failed query: …"); die RAISE-Meldung liegt
    // in error.cause.message → über die gesamte Fehlerkette prüfen.
    const zyklusInKette = (e: unknown) =>
      /Zyklus/.test(
        String((e as Error)?.message) +
          String((e as { cause?: { message?: string } })?.cause?.message)
      );

    const err1 = await db
      .update(regions)
      .set({ parentId: kreis.id })
      .where(eq(regions.id, land.id))
      .then(() => null)
      .catch((e) => e);
    expect(err1).not.toBeNull();
    expect(zyklusInKette(err1)).toBe(true);

    // Nach der Abweisung sind die Pfade UNVERÄNDERT (keine Korruption).
    const landNow = await getRegion(db as never, land.id);
    const kreisNow = await getRegion(db as never, kreis.id);
    expect(landNow!.path).toBe("de.cycland");
    expect(kreisNow!.path).toBe("de.cycland.cyckreis");
    // Auch der Selbst-Zyklus (parent = self) wird abgewiesen.
    const err2 = await db
      .update(regions)
      .set({ parentId: land.id })
      .where(eq(regions.id, land.id))
      .then(() => null)
      .catch((e) => e);
    expect(err2).not.toBeNull();
    expect(zyklusInKette(err2)).toBe(true);

    await db.delete(regions).where(eq(regions.id, kreis.id));
    await db.delete(regions).where(eq(regions.id, land.id));
  });
});
