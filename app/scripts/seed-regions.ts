/**
 * seed-regions.ts — Pilot-Gebietsbaum (ADR-024, GEBIETSMODELL §0/§2/§3) +
 * rückwärtskompatibler Backfill. EIGENES, idempotentes Skript (bewusst NICHT in
 * scripts/seed.ts hineingezwängt).
 *
 * Was es tut (rein ADDITIV — es ändert NICHTS an scope_level/scope_code/
 * ortsteile/plz_regionen; die laufende App bleibt unverändert):
 *
 *   1. Amtlicher Pilot-Teilbaum, parent per ARS-Präfix, path per Trigger:
 *        Deutschland (bund)
 *          └─ Hessen (land,     AGS 06,        ARS 060000000000)
 *              └─ Rheingau-Taunus-Kreis (kreis, AGS 06439, ARS 064390000000)
 *                  └─ Taunusstein (gemeinde,   AGS 06439015, ARS 064390015015)
 *      Amtliche Schlüssel per WebSearch gegen Destatis-nahe Quellen verifiziert
 *      (openplzapi, gemeindeverzeichnis.de, factfish) — NICHT geraten.
 *
 *   2. Ortsteile spiegeln (Seed + Backfill in einem): jede Zeile aus `ortsteile`
 *      des Taunusstein-Tenants wird als regions-Ortsteil-Knoten unter Taunusstein
 *      angelegt. path_label = ortsteile.code (der in §9 geforderte stabile,
 *      synthetische Ortsteil-Code; Ortsteile haben keinen amtlichen Schlüssel).
 *
 *   3. Backfill plz_regionen (alt) → plz_regions (neu, n:m): jede PLZ-Zeile wird
 *      auf ihren Ortsteil-Knoten (falls ortsteil_code gesetzt) bzw. sonst den
 *      Gemeinde-Knoten des Tenants abgebildet.
 *
 *   4. Backfill users.ortsteil_id → users.home_region_id über die gespiegelten
 *      Ortsteil-Knoten. Setzt NUR, wo home_region_id noch NULL ist.
 *
 * Idempotenz: amtliche/Ortsteil-Knoten über ON CONFLICT (parent_id, path_label)
 * (NULLS NOT DISTINCT → auch die Wurzel), zusätzlich UNIQUE(ars). plz-Backfill
 * über PRIMARY KEY (plz, region_id) DO NOTHING. user-Backfill über WHERE
 * home_region_id IS NULL. Schritte 3+4 sind einzelne SET-Statements → race-frei.
 * Zweimal ausführen ⇒ identischer Zustand (Test deckt das ab).
 *
 * Verwendung: npm run db:seed:regions   (Env: DATABASE_URL)
 */

import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { regions, tenants } from "../src/db/schema.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

// Slug des Pilot-Tenants, dessen Gemeinde-Knoten den Ortsteil-Teilbaum + den
// operativen tenant_id-Marker trägt.
const PILOT_TENANT_SLUG = "taunusstein";

/**
 * SQL-Ausdruck, der einen (beliebigen) Ortsteil-Code ltree-sicher zu einem
 * path_label normalisiert: lowercase, Umlaute/ß transliterieren, alles außrige
 * außerhalb [a-z0-9_] → '_'. So hält der CHECK `^[a-z0-9_]+$` IMMER, auch für
 * künftige Codes mit Großbuchstaben/Hyphen/Umlaut — sonst bräche der Format-CHECK
 * das gesamte set-basierte INSERT ab. `col` ist ein von uns kontrollierter
 * Spaltenname (kein User-Input) → sichere Interpolation via sql.raw.
 *
 * WICHTIG: identisch in ALLEN Statements (Ortsteil-Insert + die beiden Backfill-
 * Joins), sonst brechen die Joins auseinander.
 */
function ltreeLabelExpr(col: string): string {
  return (
    `regexp_replace(` +
    `replace(replace(replace(replace(lower(${col}),'ä','ae'),'ö','oe'),'ü','ue'),'ß','ss'),` +
    `'[^a-z0-9_]+','_','g')`
  );
}

interface AmtlicherKnoten {
  pathLabel: string;
  name: string;
  typ: "bund" | "land" | "kreis" | "gemeinde";
  ags: string | null;
  ars: string | null;
  lat?: string | null;
  lon?: string | null;
  tenantId?: string | null;
}

export interface SeedRegionsResult {
  gemeindeId: string | null;
  ortsteile: number;
  plzRegions: number;
  usersBackfilled: number;
}

/**
 * Idempotenter Pilot-Baum-Seed + Backfill (siehe Kopfkommentar). Nimmt eine
 * offene Drizzle-Verbindung entgegen, damit Tests dieselbe Logik gegen ihre
 * Test-DB ausführen können. Öffnet/schließt selbst KEINE Verbindung.
 */
export async function seedRegions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PostgresJsDatabase<any>
): Promise<SeedRegionsResult> {
  // Pilot-Tenant (operativer Marker auf dem Gemeinde-Knoten). Fehlt er (z. B.
  // frische Test-DB), bleibt tenant_id NULL und der Ortsteil-/PLZ-/User-Backfill
  // findet schlicht 0 Zeilen — der amtliche Baum wird trotzdem gesetzt.
  const [pilotTenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, PILOT_TENANT_SLUG))
    .limit(1);
  const pilotTenantId = pilotTenant?.id ?? null;

  // ----- 1. Amtlicher Teilbaum (verifizierte ARS/AGS) ----------------------
  const kette: AmtlicherKnoten[] = [
    { pathLabel: "de", name: "Deutschland", typ: "bund", ags: null, ars: null },
    { pathLabel: "hessen", name: "Hessen", typ: "land", ags: "06", ars: "060000000000" },
    {
      pathLabel: "rtk",
      name: "Rheingau-Taunus-Kreis",
      typ: "kreis",
      ags: "06439",
      ars: "064390000000",
    },
    {
      pathLabel: "taunusstein",
      name: "Taunusstein",
      typ: "gemeinde",
      ags: "06439015",
      ars: "064390015015",
      // Ungefähres Zentrum (aus dem plz_regionen-Seed, Haversine-Auflösung).
      lat: "50.1466",
      lon: "8.1505",
      tenantId: pilotTenantId,
    },
  ];

  let parentId: string | null = null;
  let gemeindeId: string | null = null;
  for (const k of kette) {
    // Explizite Annotation: die Selbst-FK von `regions` macht den abgeleiteten
    // Zeilentyp zirkulär (TS7022) — die Rückgabe ist { id: string }.
    const inserted: { id: string }[] = await db
      .insert(regions)
      .values({
        parentId,
        typ: k.typ,
        ags: k.ags,
        ars: k.ars,
        name: k.name,
        pathLabel: k.pathLabel,
        lat: k.lat ?? null,
        lon: k.lon ?? null,
        tenantId: k.tenantId ?? null,
        // path NICHT setzen — der BEFORE-Trigger leitet ihn aus parent_id ab.
      })
      .onConflictDoUpdate({
        target: [regions.parentId, regions.pathLabel],
        set: {
          typ: k.typ,
          ags: k.ags,
          ars: k.ars,
          name: k.name,
          lat: k.lat ?? null,
          lon: k.lon ?? null,
          tenantId: k.tenantId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: regions.id });
    const row = inserted[0];
    parentId = row.id;
    if (k.typ === "gemeinde") gemeindeId = row.id;
    console.log(`region: ${k.typ.padEnd(9)} ${k.name} → ${row.id}`);
  }

  // ----- 2. Ortsteile spiegeln (Seed + Backfill) ---------------------------
  // Jede ortsteile-Zeile des Pilot-Tenants als Ortsteil-Knoten unter Taunusstein.
  // path_label = ortsteile.code (stabiler synthetischer Code, §9). Ein einzelnes
  // INSERT ... SELECT ... ON CONFLICT → idempotent & race-frei.
  const ortsteilRes = await db.execute(sql`
    INSERT INTO regions (parent_id, typ, name, path_label, tenant_id)
    SELECT g.id, 'ortsteil', o.name, ${sql.raw(ltreeLabelExpr("o.code"))}, o.tenant_id
    FROM ortsteile o
    JOIN regions g ON g.typ = 'gemeinde' AND g.tenant_id = o.tenant_id
    ON CONFLICT (parent_id, path_label)
      DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  `);
  console.log(`ortsteil-knoten gespiegelt: ${ortsteilRes.count ?? 0} (Gemeinde ${gemeindeId ?? "—"})`);

  // ----- 3. Backfill plz_regionen (alt) → plz_regions (n:m) -----------------
  // ortsteil_code gesetzt → Ortsteil-Knoten, sonst Gemeinde-Knoten des Tenants.
  const plzRes = await db.execute(sql`
    INSERT INTO plz_regions (plz, region_id, is_primary, source)
    SELECT pr.plz, COALESCE(ot.id, g.id), true, 'backfill:plz_regionen'
    FROM plz_regionen pr
    JOIN regions g ON g.typ = 'gemeinde' AND g.tenant_id = pr.tenant_id
    LEFT JOIN regions ot
      ON ot.parent_id = g.id AND ot.typ = 'ortsteil'
      AND ot.path_label = ${sql.raw(ltreeLabelExpr("pr.ortsteil_code"))}
    ON CONFLICT (plz, region_id) DO NOTHING
  `);
  console.log(`plz_regions backfilled: ${plzRes.count ?? 0}`);

  // ----- 4. Backfill users.ortsteil_id → users.home_region_id --------------
  // Nur wo home_region_id noch NULL ist (idempotent); ein SET-Statement (race-frei).
  const userRes = await db.execute(sql`
    UPDATE users u
    SET home_region_id = r.id
    FROM ortsteile o
    JOIN regions g ON g.typ = 'gemeinde' AND g.tenant_id = o.tenant_id
    JOIN regions r ON r.parent_id = g.id AND r.typ = 'ortsteil'
      AND r.path_label = ${sql.raw(ltreeLabelExpr("o.code"))}
    WHERE u.ortsteil_id = o.id AND u.home_region_id IS NULL
  `);
  console.log(`users.home_region_id backfilled: ${userRes.count ?? 0}`);

  // Konsistenz-Selbstprüfung: genau eine Wurzel.
  const [{ roots }] = await db
    .select({ roots: sql<number>`count(*)::int` })
    .from(regions)
    .where(and(isNull(regions.parentId), eq(regions.typ, "bund")));
  if (roots !== 1) throw new Error(`Erwartet genau 1 Wurzel, gefunden: ${roots}`);

  return {
    gemeindeId,
    ortsteile: ortsteilRes.count ?? 0,
    plzRegions: plzRes.count ?? 0,
    usersBackfilled: userRes.count ?? 0,
  };
}

async function main() {
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  try {
    await seedRegions(db);

    // Verifikations-Ausgabe: kompletter Pilot-Baum mit Pfad.
    const baum = await db
      .select({ typ: regions.typ, name: regions.name, path: regions.path })
      .from(regions)
      .orderBy(sql`nlevel(${regions.path})`, regions.name);
    console.log("Gebietsbaum:");
    for (const n of baum) console.log(`  [${n.typ}] ${n.name}  (${n.path})`);
    console.log("seed-regions completed.");
  } finally {
    await client.end();
  }
}

// Nur als Skript ausführen, nicht beim Import aus Tests.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("seed-regions failed:", err);
    process.exit(1);
  });
}
