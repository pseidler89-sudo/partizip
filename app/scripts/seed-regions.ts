/**
 * seed-regions.ts — CONFIG-GETRIEBENER Gebietsbaum-Seed (ADR-024, GEBIETSMODELL
 * §0/§2/§3/§6) + rückwärtskompatibler Backfill. EIGENES, idempotentes Skript
 * (bewusst NICHT in scripts/seed.ts hineingezwängt).
 *
 * WARUM CONFIG-GETRIEBEN (statt hartkodierter Zweige):
 *   Jeder Tenant mit Fachzeilen (polls/roles/qr_codes/verification_locations/
 *   invitations) braucht VOR der region-Migration (0024/0025-Backfill) einen
 *   Gebietsbaum-Zweig mit EINEM Gemeinde-Knoten, der seine tenant_id trägt —
 *   sonst findet der strenge Backfill (provision=false) keinen Anker und bricht
 *   hart ab (genau der Prod-Ausfall, den dieses Skript verhindert). Früher waren
 *   Taunusstein (amtlich) + Musterstadt (Demo) HIER im Code hartkodiert; ein neuer
 *   Tenant ⇒ Code-Change. Jetzt sind die Zweige DATEN: db/seeds/regionen.json.
 *   ⇒ „neue Kommune = Config-Eintrag, kein Code" (§6).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SO FÜGEN SIE EINE NEUE KOMMUNE HINZU (kein Code, kein Deploy-Sonderfall):
 *   1. Tenant anlegen (db/seeds/tenants.json + `npm run db:seed`, oder Import).
 *   2. In db/seeds/regionen.json EINEN Eintrag ergänzen:
 *        {
 *          "tenantSlug": "<slug wie in tenants.json>",
 *          "fiktiv": false,                       // true = Demo/Beispiel, KEINE
 *                                                 //        amtlichen Schlüssel
 *          "zweig": [                             // Kette land → kreis → gemeinde
 *            { "typ":"land",     "pathLabel":"…","name":"…","ags":"…","ars":"…" },
 *            { "typ":"kreis",    "pathLabel":"…","name":"…","ags":"…","ars":"…" },
 *            { "typ":"gemeinde", "pathLabel":"…","name":"…","ags":"…","ars":"…",
 *              "lat":"…","lon":"…" }              // lat/lon optional
 *          ]
 *        }
 *      Die Bund-Wurzel „Deutschland" (de) ist geteilt und wird automatisch
 *      sichergestellt — NICHT in den Zweig aufnehmen. Der letzte Knoten MUSS
 *      typ=gemeinde sein; er bekommt die tenant_id des Tenants (operativer Marker
 *      + Backfill-Anker). Amtliche AGS/ARS gegen Destatis-nahe Quellen prüfen
 *      (openplzapi/gemeindeverzeichnis.de) — NICHT raten. Für fiktiv=true: ags/ars
 *      WEGLASSEN (bleibt NULL; mehrere NULL-ars sind unter dem partiellen
 *      ars-Unique-Index erlaubt).
 *   3. Ortsteile NICHT hier pflegen: sie werden generisch aus der `ortsteile`-
 *      Tabelle des Tenants unter dessen Gemeinde-Knoten gespiegelt (§2 unten).
 *      Ortsteil-Quelle = ortsteile(tenant_id) → das reicht.
 *   4. `npm run db:seed:regions` — idempotent, legt/aktualisiert den Zweig an.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WARUM CONFIG-DATEI statt Tenant-Spalte (Migration): kein Schema-Change (kein
 * Drift gegen drizzle-kit generate — der CI-Schema-Drift-Check bleibt grün), kein
 * Backfill, portabel/export-freundlich, und deckungsgleich mit der bestehenden
 * Seed-JSON-Konvention (tenants.json / ortsteile.json). Ein JSON-Eintrag ist die
 * kleinste, wartbarste Einheit für „neue Kommune".
 *
 * Was das Skript tut (rein ADDITIV — es ändert NICHTS am Verhalten der App):
 *   1. Bund-Wurzel „Deutschland" (de) sicherstellen (von ALLEN Zweigen geteilt).
 *   1a. Pro Config-Eintrag den Zweig (land→kreis→gemeinde) idempotent upserten;
 *       Gemeinde-Knoten trägt tenant_id. Eintrag, dessen Tenant (noch) nicht
 *       existiert (frische DB) ⇒ KLAR geloggt übersprungen, KEIN Fehler.
 *   1b. Diagnose: Tenants MIT Fachzeilen, aber OHNE Gemeinde-Knoten (= ohne
 *       Config-Zweig) ⇒ deutliche WARN-Zeile. Das ist genau der Tenant, an dem der
 *       strenge region-Backfill sonst hart abbräche — hier früh & klar sichtbar.
 *   2. Ortsteile spiegeln (generisch, tenant-getrieben): jede `ortsteile`-Zeile →
 *      Ortsteil-Knoten unter dem Gemeinde-Knoten ihres Tenants. path_label =
 *      ltree-normalisierter ortsteile.code (§9). Ein set-basiertes INSERT.
 *   3. Backfill plz_regionen (alt) → plz_regions (neu, n:m).
 *   4. Backfill users.ortsteil_id → users.home_region_id über die Spiegelknoten.
 *
 * Idempotenz: Knoten über ON CONFLICT (parent_id, path_label) (NULLS NOT DISTINCT
 * → auch die Wurzel), zusätzlich UNIQUE(ars). plz-Backfill über PRIMARY KEY
 * (plz, region_id) DO NOTHING. user-Backfill über WHERE home_region_id IS NULL.
 * Zweimal ausführen ⇒ identischer Zustand (Tests decken das ab).
 *
 * Verwendung: npm run db:seed:regions   (Env: DATABASE_URL; DEMO_TENANT_SLUG
 *   überschreibt den Slug eines Config-Eintrags mit "slugEnv":"DEMO_TENANT_SLUG").
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { regions, tenants } from "../src/db/schema.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// db/seeds liegt auf Repo-Ebene (../../db/seeds relativ zu app/scripts) — dieselbe
// Auflösung wie scripts/seed.ts.
const seedsDir = path.resolve(__dirname, "../../db/seeds");

/**
 * SQL-Ausdruck, der einen (beliebigen) Ortsteil-Code ltree-sicher zu einem
 * path_label normalisiert: lowercase, Umlaute/ß transliterieren, alles außerhalb
 * [a-z0-9_] → '_'. So hält der CHECK `^[a-z0-9_]+$` IMMER, auch für künftige Codes
 * mit Großbuchstaben/Hyphen/Umlaut — sonst bräche der Format-CHECK das gesamte
 * set-basierte INSERT ab. `col` ist ein von uns kontrollierter Spaltenname (kein
 * User-Input) → sichere Interpolation via sql.raw.
 *
 * WICHTIG: identisch in ALLEN Statements (Ortsteil-Insert + die beiden Backfill-
 * Joins) UND deckungsgleich mit regions_ltree_label() in db/migrations/0024.
 */
function ltreeLabelExpr(col: string): string {
  return (
    `regexp_replace(` +
    `replace(replace(replace(replace(lower(${col}),'ä','ae'),'ö','oe'),'ü','ue'),'ß','ss'),` +
    `'[^a-z0-9_]+','_','g')`
  );
}

interface Gebietsknoten {
  pathLabel: string;
  name: string;
  typ: "bund" | "land" | "kreis" | "gemeinde";
  ags: string | null;
  ars: string | null;
  lat?: string | null;
  lon?: string | null;
  tenantId?: string | null;
}

/** Ein Zweig-Knoten wie in db/seeds/regionen.json (Bund-Wurzel NICHT enthalten). */
interface RegionZweigKnoten {
  typ: "land" | "kreis" | "gemeinde";
  pathLabel: string;
  name: string;
  ags?: string | null;
  ars?: string | null;
  lat?: string | null;
  lon?: string | null;
}

/** Ein Config-Eintrag = ein Tenant-Gebietszweig. */
interface RegionConfigEintrag {
  tenantSlug: string;
  /** Optionaler ENV-Name, dessen Wert den Slug überschreibt (z. B. DEMO_TENANT_SLUG). */
  slugEnv?: string;
  /** true = Demo/Beispiel-Kommune ohne amtliche Schlüssel. */
  fiktiv: boolean;
  /** Kette land → kreis → gemeinde (Bund-Wurzel implizit). */
  zweig: RegionZweigKnoten[];
}

export interface SeedRegionsResult {
  /** Angelegte/aktualisierte Gemeinde-Knoten je verarbeitetem Tenant-Slug. */
  gemeindeIdBySlug: Record<string, string>;
  /** Config-Einträge, deren Tenant (noch) nicht existiert (klar übersprungen). */
  uebersprungeneSlugs: string[];
  /** Tenants mit Fachzeilen, aber ohne Gebietszweig (WARN, kein Fehler). */
  fachOhneZweigTenantIds: string[];
  ortsteile: number;
  plzRegions: number;
  usersBackfilled: number;
}

/** Effektiver Slug eines Eintrags: slugEnv-Override (getrimmt/lowercase) ODER tenantSlug. */
function effektiverSlug(e: RegionConfigEintrag): string {
  const override = e.slugEnv ? process.env[e.slugEnv]?.trim().toLowerCase() : undefined;
  return override || e.tenantSlug.trim().toLowerCase();
}

/**
 * Lädt + validiert die Gebiets-Config. Wirft bei struktureller Fehlkonfiguration
 * (früh & klar, nicht erst mitten im INSERT).
 */
export function ladeRegionConfig(): RegionConfigEintrag[] {
  const raw = readFileSync(path.join(seedsDir, "regionen.json"), "utf-8");
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("regionen.json: erwartet ein Array von Config-Einträgen");
  }
  return data.map((e, i) => validiereEintrag(e, i));
}

function validiereEintrag(e: unknown, i: number): RegionConfigEintrag {
  const c = e as Partial<RegionConfigEintrag>;
  const wo = `regionen.json[${i}]`;
  if (typeof c.tenantSlug !== "string" || !c.tenantSlug.trim()) {
    throw new Error(`${wo}: tenantSlug fehlt`);
  }
  if (typeof c.fiktiv !== "boolean") {
    throw new Error(`${wo} (${c.tenantSlug}): fiktiv (boolean) fehlt`);
  }
  if (!Array.isArray(c.zweig) || c.zweig.length === 0) {
    throw new Error(`${wo} (${c.tenantSlug}): zweig fehlt/leer`);
  }
  const gemeinden = c.zweig.filter((k) => k.typ === "gemeinde");
  if (gemeinden.length !== 1) {
    throw new Error(
      `${wo} (${c.tenantSlug}): genau EIN gemeinde-Knoten erwartet, gefunden ${gemeinden.length}`
    );
  }
  if (c.zweig[c.zweig.length - 1].typ !== "gemeinde") {
    throw new Error(`${wo} (${c.tenantSlug}): letzter Knoten muss typ=gemeinde sein`);
  }
  for (const k of c.zweig) {
    if (!k.typ || !k.pathLabel || !k.name) {
      throw new Error(`${wo} (${c.tenantSlug}): jeder Knoten braucht typ/pathLabel/name`);
    }
    // pathLabel MUSS ein gültiges ltree-Label sein (deckungsgleich mit dem DB-CHECK
    // `^[a-z0-9_]+$` auf regions.path_label). Sonst bräche eine Fehlkonfiguration
    // (Großbuchstabe/Hyphen/Umlaut) erst spät am DB-CHECK ab statt hier früh & klar.
    if (!/^[a-z0-9_]+$/.test(k.pathLabel)) {
      throw new Error(
        `${wo} (${c.tenantSlug}): pathLabel '${k.pathLabel}' ist kein gültiges ltree-Label — ` +
          `nur [a-z0-9_] erlaubt (kein Großbuchstabe/Hyphen/Umlaut; Umlaute transliterieren, z. B. ö→oe)`
      );
    }
    if (c.fiktiv && (k.ags || k.ars)) {
      throw new Error(
        `${wo} (${c.tenantSlug}): fiktiv=true, aber Knoten '${k.pathLabel}' trägt ags/ars — ` +
          `fiktive Kommunen dürfen KEINE amtlichen Schlüssel tragen`
      );
    }
    if (!c.fiktiv && !k.ars) {
      throw new Error(
        `${wo} (${c.tenantSlug}): fiktiv=false, aber Knoten '${k.pathLabel}' ohne ars — ` +
          `amtliche Knoten brauchen einen ARS (Destatis-verifiziert)`
      );
    }
  }
  return c as RegionConfigEintrag;
}

/**
 * Upsertet EINEN Gebietsknoten unter `parentId` und gibt seine id zurück.
 * Idempotent über (parent_id, path_label) (NULLS NOT DISTINCT → auch die Wurzel).
 * path wird NICHT gesetzt — der BEFORE-Trigger leitet ihn aus parent_id ab.
 */
async function upsertKnoten(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PostgresJsDatabase<any>,
  k: Gebietsknoten,
  parentId: string | null
): Promise<string> {
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
  return inserted[0].id;
}

/**
 * Idempotenter, CONFIG-GETRIEBENER Baum-Seed + Backfill (siehe Kopfkommentar).
 * Nimmt eine offene Drizzle-Verbindung entgegen, damit Tests dieselbe Logik gegen
 * ihre Test-DB ausführen können. Öffnet/schließt selbst KEINE Verbindung.
 *
 * `config` überschreibt optional die geladene db/seeds/regionen.json (für Tests
 * mit synthetischen Tenants).
 */
export async function seedRegions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PostgresJsDatabase<any>,
  config?: RegionConfigEintrag[]
): Promise<SeedRegionsResult> {
  const eintraege = config ?? ladeRegionConfig();

  // ----- 1. Wurzel „Deutschland" (bund) — von ALLEN Zweigen geteilt. --------
  const bundId = await upsertKnoten(
    db,
    { pathLabel: "de", name: "Deutschland", typ: "bund", ags: null, ars: null },
    null
  );
  console.log(`region: bund      Deutschland → ${bundId}`);

  // ----- 1a. Pro Config-Eintrag den Zweig upserten (tenant-getrieben). ------
  const gemeindeIdBySlug: Record<string, string> = {};
  const uebersprungeneSlugs: string[] = [];

  for (const eintrag of eintraege) {
    const slug = effektiverSlug(eintrag);
    const [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);

    if (!tenant) {
      // Config-Eintrag ohne (noch) existierenden Tenant → klar überspringen.
      uebersprungeneSlugs.push(slug);
      console.log(
        `region: Zweig '${slug}' übersprungen — Tenant nicht vorhanden (Config ohne Tenant; kein Fehler).`
      );
      continue;
    }

    let parentId = bundId;
    let gemeindeId: string | null = null;
    for (const k of eintrag.zweig) {
      const nodeId = await upsertKnoten(
        db,
        {
          pathLabel: k.pathLabel,
          name: k.name,
          typ: k.typ,
          ags: k.ags ?? null,
          ars: k.ars ?? null,
          lat: k.lat ?? null,
          lon: k.lon ?? null,
          // Nur der Gemeinde-Knoten trägt den operativen tenant_id-Marker/Anker.
          tenantId: k.typ === "gemeinde" ? tenant.id : null,
        },
        parentId
      );
      parentId = nodeId;
      if (k.typ === "gemeinde") gemeindeId = nodeId;
      console.log(
        `region: ${k.typ.padEnd(9)} ${k.name}${eintrag.fiktiv ? " [fiktiv]" : ""} → ${nodeId}`
      );
    }
    // Validierung garantiert genau einen gemeinde-Knoten je Zweig.
    gemeindeIdBySlug[slug] = gemeindeId!;
  }

  // ----- 1b. Diagnose: Fachzeilen ohne Gebietszweig (WARN, kein Fehler) -----
  // Genau die Tenants, an denen der strenge region-Backfill (0024/0025,
  // provision=false) sonst HART abbräche — hier früh & deutlich sichtbar, damit
  // ein fehlender Config-Eintrag VOR dem Deploy auffällt (der Prod-Ausfall, den
  // dieses Skript adressiert).
  const fachOhneZweig = await db.execute(sql`
    SELECT t.id, t.slug FROM tenants t
    WHERE EXISTS (
      SELECT 1 FROM (
        SELECT tenant_id FROM polls
        UNION SELECT tenant_id FROM roles
        UNION SELECT tenant_id FROM qr_codes
        UNION SELECT tenant_id FROM verification_locations
      ) f WHERE f.tenant_id = t.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM regions g WHERE g.typ = 'gemeinde' AND g.tenant_id = t.id
    )
    ORDER BY t.slug
  `);
  const fachOhneZweigTenantIds: string[] = [];
  for (const row of fachOhneZweig as unknown as { id: string; slug: string }[]) {
    fachOhneZweigTenantIds.push(row.id);
    console.warn(
      `region: WARN Tenant '${row.slug}' (${row.id}) hat Fachzeilen, aber KEINEN ` +
        `Gebietszweig — Config-Eintrag in db/seeds/regionen.json ergänzen, sonst ` +
        `bricht der region-Backfill (Migration 0024/0025) für diesen Tenant ab.`
    );
  }

  // ----- 2. Ortsteile spiegeln (Seed + Backfill), tenant-getrieben ----------
  // Jede ortsteile-Zeile → Ortsteil-Knoten unter dem Gemeinde-Knoten ihres Tenants.
  // path_label = ltree-normalisierter ortsteile.code (stabiler synthetischer Code,
  // §9). Ein einzelnes INSERT ... SELECT ... ON CONFLICT → idempotent & race-frei.
  const ortsteilRes = await db.execute(sql`
    INSERT INTO regions (parent_id, typ, name, path_label, tenant_id)
    SELECT g.id, 'ortsteil', o.name, ${sql.raw(ltreeLabelExpr("o.code"))}, o.tenant_id
    FROM ortsteile o
    JOIN regions g ON g.typ = 'gemeinde' AND g.tenant_id = o.tenant_id
    ON CONFLICT (parent_id, path_label)
      DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  `);
  console.log(`ortsteil-knoten gespiegelt: ${ortsteilRes.count ?? 0}`);

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
    gemeindeIdBySlug,
    uebersprungeneSlugs,
    fachOhneZweigTenantIds,
    ortsteile: ortsteilRes.count ?? 0,
    plzRegions: plzRes.count ?? 0,
    usersBackfilled: userRes.count ?? 0,
  };
}

async function main() {
  // FAIL-FAST-Runner: default strict=an. Ein Tenant MIT Fachzeilen ohne
  // Gebietszweig-Config ist der GENAUE Fehler, an dem der strenge region-Backfill
  // (0024/0025) später hart abbräche. In einer verketteten Pipeline (db:upgrade =
  // seed:regions && migrate) muss deshalb schon der Seed-Schritt scheitern, sonst
  // kommt der harte Abbruch erst bei der Migration (das war der reale Prod-Ausfall).
  // Die exportierte seedRegions()-Funktion bleibt bewusst nicht-exitend (für Tests);
  // NUR dieser Runner erzwingt den Exit. `--no-strict` schaltet die Härte ab.
  const strict = !process.argv.includes("--no-strict");
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  let fachOhneZweigTenantIds: string[] = [];
  try {
    const result = await seedRegions(db);
    fachOhneZweigTenantIds = result.fachOhneZweigTenantIds;

    // Verifikations-Ausgabe: kompletter Baum mit Pfad.
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

  if (strict && fachOhneZweigTenantIds.length > 0) {
    console.error(
      `seed-regions FEHLER (--strict): ${fachOhneZweigTenantIds.length} Tenant(s) mit Fachzeilen, ` +
        `aber OHNE Gebietszweig — Config-Eintrag in db/seeds/regionen.json ergänzen. ` +
        `Tenant-IDs: ${fachOhneZweigTenantIds.join(", ")}. ` +
        `Die Pipeline stoppt HIER (Seed), damit der harte Abbruch nicht erst bei db:migrate ` +
        `auftritt. (--no-strict überspringt diese Prüfung.)`
    );
    process.exit(1);
  }
}

// Nur als Skript ausführen, nicht beim Import aus Tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("seed-regions failed:", err);
    process.exit(1);
  });
}
