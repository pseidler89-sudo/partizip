/**
 * pilot-resolution.test.ts — DB-Integrationstests der ECHTEN Tenant-Auflösung
 * für den Single-Domain-Pilot (ADR-015): getTenantBySlug + getTenantFromHost.
 *
 * Sicherheits-Kern: der Pilot-Mapping (Haupt-Domain → Pilot-Tenant) darf die
 * Subdomain-Isolation NICHT aufweichen — eine echte Subdomain löst weiter ihren
 * eigenen Tenant auf, ein Fremd-Host bekommt NIE den Pilot-Tenant, und eine
 * nicht existierende Subdomain fällt NICHT auf den Pilot zurück.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist. getTenantFromHost liest
 * DATABASE_URL + PILOT_TENANT_SLUG zur Laufzeit aus der Umgebung — beide werden
 * hier gesetzt und in afterAll/afterEach sauber zurückgesetzt.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { getTenantBySlug, getTenantFromHost } from "@/lib/tenant";

const { tenants } = schema;

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

const PILOT_SLUG = "pilotstadt";
const ANDERE_SLUG = "anderestadt";

type DbType = ReturnType<typeof drizzle>;

describe("tenant — Single-Domain-Pilot-Auflösung (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let origDbUrl: string | undefined;
  let origPilot: string | undefined;

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

    await db.insert(tenants).values([
      { slug: PILOT_SLUG, name: "Pilotstadt" },
      { slug: ANDERE_SLUG, name: "Anderestadt" },
      { slug: "inaktiv", name: "Inaktiv", isActive: false },
    ]);

    // getTenantFromHost/getTenantBySlug lesen DATABASE_URL zur Laufzeit.
    origDbUrl = process.env.DATABASE_URL;
    origPilot = process.env.PILOT_TENANT_SLUG;
    process.env.DATABASE_URL = TEST_DB_URL;
  });

  afterAll(async () => {
    if (SKIP) return;
    if (origDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDbUrl;
    if (origPilot === undefined) delete process.env.PILOT_TENANT_SLUG;
    else process.env.PILOT_TENANT_SLUG = origPilot;
    if (sql_) await sql_.end();
  });

  beforeEach(() => {
    delete process.env.PILOT_TENANT_SLUG;
  });
  afterEach(() => {
    delete process.env.PILOT_TENANT_SLUG;
  });

  it.skipIf(SKIP)("getTenantBySlug liefert aktive Tenants, null für unbekannt/inaktiv", async () => {
    expect((await getTenantBySlug(PILOT_SLUG))?.slug).toBe(PILOT_SLUG);
    expect(await getTenantBySlug("gibtsnicht")).toBeNull();
    expect(await getTenantBySlug("inaktiv")).toBeNull();
  });

  it.skipIf(SKIP)("Subdomain löst ihren eigenen Tenant auf (unverändert)", async () => {
    expect((await getTenantFromHost(`${PILOT_SLUG}.partizip.online`))?.slug).toBe(PILOT_SLUG);
    expect((await getTenantFromHost(`${ANDERE_SLUG}.partizip.online`))?.slug).toBe(ANDERE_SLUG);
  });

  it.skipIf(SKIP)("ohne PILOT_TENANT_SLUG: Haupt-Domain → null (neutral)", async () => {
    expect(await getTenantFromHost("partizip.online")).toBeNull();
    expect(await getTenantFromHost("www.partizip.online")).toBeNull();
    expect(await getTenantFromHost("localhost")).toBeNull();
  });

  it.skipIf(SKIP)("mit PILOT_TENANT_SLUG: alle Haupt-Domains → Pilot-Tenant", async () => {
    process.env.PILOT_TENANT_SLUG = PILOT_SLUG;
    expect((await getTenantFromHost("partizip.online"))?.slug).toBe(PILOT_SLUG);
    expect((await getTenantFromHost("www.partizip.online"))?.slug).toBe(PILOT_SLUG);
    expect((await getTenantFromHost("localhost"))?.slug).toBe(PILOT_SLUG);
    expect((await getTenantFromHost("127.0.0.1"))?.slug).toBe(PILOT_SLUG);
  });

  it.skipIf(SKIP)("ISOLATION: Fremd-Host bekommt NIE den Pilot-Tenant", async () => {
    process.env.PILOT_TENANT_SLUG = PILOT_SLUG;
    expect(await getTenantFromHost("evil.com")).toBeNull();
    expect(await getTenantFromHost("partizip.online.evil.com")).toBeNull();
  });

  it.skipIf(SKIP)("ISOLATION: echte Subdomain gewinnt weiter über das Pilot-Mapping", async () => {
    process.env.PILOT_TENANT_SLUG = PILOT_SLUG;
    expect((await getTenantFromHost(`${ANDERE_SLUG}.partizip.online`))?.slug).toBe(ANDERE_SLUG);
  });

  it.skipIf(SKIP)("ISOLATION: nicht existierende Subdomain fällt NICHT auf den Pilot zurück", async () => {
    process.env.PILOT_TENANT_SLUG = PILOT_SLUG;
    expect(await getTenantFromHost("gibtsnicht.partizip.online")).toBeNull();
  });

  it.skipIf(SKIP)("PILOT_TENANT_SLUG zeigt auf nicht existierenden Tenant → null (graceful)", async () => {
    process.env.PILOT_TENANT_SLUG = "nichtvorhanden";
    expect(await getTenantFromHost("partizip.online")).toBeNull();
  });
});
