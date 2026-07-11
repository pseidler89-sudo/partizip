/**
 * tenant-import.ts — legt aus einer exportierten Tenant-Config einen NEUEN Tenant an.
 *
 * Transaktional + zod-validiert; bricht ab, wenn der Ziel-Slug bereits existiert.
 * Legt nur die regionale Struktur an (Tenant + Ortsteile + PLZ-Mapping), keine
 * Personen-/Laufzeitdaten. Siehe lib/tenant-portability.ts.
 *
 * Verwendung:  npm run tenant:import -- <datei.json> [neuer-slug]
 * Env:         DATABASE_URL
 */

import { readFileSync } from "node:fs";
import { createDb } from "../src/db/client.js";
import { importTenantConfig } from "../src/lib/tenant-portability.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  const file = process.argv[2];
  const slugOverride = process.argv[3];
  if (!file) {
    console.error("Verwendung: npm run tenant:import -- <datei.json> [neuer-slug]");
    process.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`Datei "${file}" konnte nicht gelesen/geparst werden:`, e);
    process.exit(1);
  }

  const db = createDb(databaseUrl);
  const res = await importTenantConfig(db, data, slugOverride ? { slug: slugOverride } : undefined);
  console.log(
    `Import ok: Tenant "${res.slug}" (${res.tenantId}) — ` +
      `${res.ortsteile} Ortsteile, ${res.plzRegionen} PLZ-Einträge.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Import fehlgeschlagen:", err);
  process.exit(1);
});
