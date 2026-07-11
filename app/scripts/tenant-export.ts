/**
 * tenant-export.ts — exportiert die Konfiguration eines Tenants als JSON (stdout).
 *
 * Exportiert NUR die regionale Struktur (Tenant-Config + Ortsteile + PLZ-Mapping),
 * KEINE Personen-/Laufzeitdaten (PII-frei). Siehe lib/tenant-portability.ts.
 *
 * Verwendung:  npm run tenant:export -- <slug> > kommune.json
 * Env:         DATABASE_URL
 */

import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { tenants } from "../src/db/schema.js";
import { exportTenantConfig } from "../src/lib/tenant-portability.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Verwendung: npm run tenant:export -- <slug> > kommune.json");
    process.exit(1);
  }

  const db = createDb(databaseUrl);
  const [t] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (!t) {
    console.error(`Tenant "${slug}" nicht gefunden.`);
    process.exit(1);
  }

  const data = await exportTenantConfig(db, t.id);
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Export fehlgeschlagen:", err);
  process.exit(1);
});
