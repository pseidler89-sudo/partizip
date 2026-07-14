/**
 * vitest.setup.ts — globales Test-Setup (läuft vor jeder Test-Datei).
 *
 * Gebietsbaum-Provisioning-Netz test/demo-gaten (Gate-B MINOR, ADR-024): Die
 * SQL-Funktion `regions_resolve_region_id` legt das Baum-Sicherheitsnetz (minimaler
 * Pilot-Pfad + per-Tenant-Gemeinde/Ortsteil für ungeseedete Tenants) NUR an, wenn
 * die GUC `app.region_provision` gesetzt ist. In PRODUKTION ist sie ungesetzt →
 * kein stilles Provisioning, ein fehlender Baum schlägt hart fehl.
 *
 * Viele Integrationstests fügen Fachzeilen (polls/qr/roles/…) in frische, NICHT
 * geseedete Tenants ein und verlassen sich auf das Netz. Statt die GUC in jeder
 * Test-Datei/Verbindung zu setzen, aktivieren wir sie EINMAL zentral als Default
 * der Test-DB — alle danach geöffneten Verbindungen erben sie. Nur wenn
 * DATABASE_URL_TEST gesetzt ist (reine Unit-Läufe ohne DB tun hier nichts).
 */

import postgres from "postgres";

const TEST_DB_URL = process.env.DATABASE_URL_TEST;

if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  // Sicherheitsnetz gegen versehentliches Ausführen gegen eine echte DB.
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test"`);
  }
  const admin = postgres(TEST_DB_URL, { max: 1 });
  try {
    // DB-weiter Default (überlebt das Schema-Reset der Tests, gilt für alle neuen
    // Verbindungen). Identifier via postgres.js sicher gequotet.
    await admin`ALTER DATABASE ${admin(dbName)} SET app.region_provision = 'on'`;
  } finally {
    await admin.end();
  }
}
