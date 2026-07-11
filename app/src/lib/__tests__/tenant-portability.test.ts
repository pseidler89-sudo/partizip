/**
 * tenant-portability.test.ts — Export/Import der Tenant-Config (Skalierungs-Roadmap).
 *
 * ECHTE Funktionen gegen PG16: Round-Trip (export → import unter neuem Tenant),
 * Tenant-Isolation, Slug-Kollision (kein Überschreiben), referenzielle Integrität
 * (Dangling-Ortsteil), Format-Validierung (zod), PII-Freiheit.
 * Läuft NUR mit DATABASE_URL_TEST.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import {
  exportTenantConfig,
  importTenantConfig,
  tenantExportSchema,
  TENANT_EXPORT_VERSION,
} from "@/lib/tenant-portability";

const { tenants, ortsteile, plzRegionen } = schema;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../db/migrations");

const TEST_DB_URL = process.env.DATABASE_URL_TEST;
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test"`);
  }
}
const SKIP = !TEST_DB_URL;
type DbType = ReturnType<typeof drizzle>;

describe("tenant-portability (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;

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
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("Round-Trip: export → import legt identische Struktur unter neuem Tenant an (isoliert)", async () => {
    const [tA] = await db
      .insert(tenants)
      .values({ slug: `src-${Date.now()}`, name: "Quelle", primaryColor: "#0d6a70", welcomeText: "Hallo", vierAugenPflicht: true })
      .returning();
    await db.insert(ortsteile).values([
      { tenantId: tA.id, code: "OT-A", name: "Ortsteil A" },
      { tenantId: tA.id, code: "OT-B", name: "Ortsteil B" },
    ]);
    await db.insert(plzRegionen).values([
      { tenantId: tA.id, plz: "65232", ortsteilCode: "OT-A" },
      { tenantId: tA.id, plz: "65233", ortsteilCode: "OT-B" },
      { tenantId: tA.id, plz: "65234", ortsteilCode: null }, // Stadt-Ebene
    ]);

    const exported = await exportTenantConfig(db as never, tA.id);
    expect(() => tenantExportSchema.parse(exported)).not.toThrow();
    expect(exported.version).toBe(TENANT_EXPORT_VERSION);
    expect(exported.tenant.slug).toBe(tA.slug);
    expect(exported.ortsteile).toHaveLength(2);
    expect(exported.plzRegionen).toHaveLength(3);
    // PII-Freiheit: keine personenbezogenen Schlüssel im Export.
    const blob = JSON.stringify(exported);
    for (const verboten of ["email", "voterRef", "creatorRef", "tokenHash", "userId"]) {
      expect(blob).not.toContain(verboten);
    }

    // PLZ sind GLOBAL eindeutig → für den Round-Trip auf derselben DB die Quell-PLZ
    // freigeben (simuliert eine frische Ziel-DB). Ortsteile bleiben (tenant-scoped).
    await db.delete(plzRegionen).where(eq(plzRegionen.tenantId, tA.id));

    const newSlug = `dst-${Date.now()}`;
    const res = await importTenantConfig(db as never, exported, { slug: newSlug });
    expect(res.slug).toBe(newSlug);
    expect(res.tenantId).not.toBe(tA.id);
    expect(res.ortsteile).toBe(2);
    expect(res.plzRegionen).toBe(3);

    const [tB] = await db.select().from(tenants).where(eq(tenants.id, res.tenantId)).limit(1);
    expect(tB.slug).toBe(newSlug);
    expect(tB.name).toBe("Quelle");
    expect(tB.primaryColor).toBe("#0d6a70");
    expect(tB.vierAugenPflicht).toBe(true);

    const otsB = await db.select().from(ortsteile).where(eq(ortsteile.tenantId, res.tenantId));
    expect(otsB.map((o: { code: string }) => o.code).sort()).toEqual(["OT-A", "OT-B"]);
    const prsB = await db.select().from(plzRegionen).where(eq(plzRegionen.tenantId, res.tenantId));
    expect(prsB).toHaveLength(3);

    // Quelle isoliert unangetastet: ihre Ortsteile bleiben (eigener tenantId).
    const otsA = await db.select().from(ortsteile).where(eq(ortsteile.tenantId, tA.id));
    expect(otsA).toHaveLength(2);
  });

  it.skipIf(SKIP)("Import bricht ab, wenn der Ziel-Slug bereits existiert (kein Überschreiben)", async () => {
    const slug = `dup-${Date.now()}`;
    await db.insert(tenants).values({ slug, name: "Existiert" });
    const data = { version: 1, tenant: { slug, name: "Neu" }, ortsteile: [], plzRegionen: [] };
    await expect(importTenantConfig(db as never, data)).rejects.toThrow(/existiert bereits/);
    const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    expect(row.name).toBe("Existiert"); // nicht überschrieben
  });

  it.skipIf(SKIP)("Import lehnt Dangling-Ortsteil-Referenz ab und legt nichts an (transaktional)", async () => {
    const slug = `dang-${Date.now()}`;
    const data = {
      version: 1,
      tenant: { slug, name: "X" },
      ortsteile: [{ code: "OT-A", name: "A" }],
      plzRegionen: [{ plz: "65999", ortsteilCode: "OT-Z" }], // OT-Z fehlt
    };
    await expect(importTenantConfig(db as never, data)).rejects.toThrow(/fehlt in ortsteile/);
    const rows = await db.select().from(tenants).where(eq(tenants.slug, slug));
    expect(rows).toHaveLength(0); // kein halb angelegter Tenant
  });

  it.skipIf(SKIP)("Import lehnt ungültiges Format ab (zod: Slug-Form, Version)", async () => {
    await expect(
      importTenantConfig(db as never, { version: 1, tenant: { slug: "Bad Slug!", name: "X" }, ortsteile: [], plzRegionen: [] })
    ).rejects.toThrow();
    await expect(
      importTenantConfig(db as never, { version: 99, tenant: { slug: "ok", name: "X" }, ortsteile: [], plzRegionen: [] })
    ).rejects.toThrow();
  });
});
