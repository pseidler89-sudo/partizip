/**
 * rss.test.ts — Tests für den RSS-Feed (M7)
 *
 * Testet:
 *   - Valides XML
 *   - Nur status='veroeffentlicht' im Feed
 *   - Feed-Struktur (RSS 2.0)
 *   - Unbekannter Tenant → 404
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 * Nutzt das bereits migrierte Schema (nach gate.test.ts oder integration.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { NextRequest } from "next/server";

const { tenants, users, risBodies, risMeetings, risDocuments, digests, digestStatements } = schema;

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

describe("RSS-Feed (Integration)", () => {
  let sql_: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  let testTenantSlug: string;
  let pubDigestTitle: string;

  beforeAll(async () => {
    if (SKIP) return;

    // Schema reset und Migration
    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    testTenantSlug = `rss-test-${Date.now()}`;
    pubDigestTitle = `Veröffentlichter Digest ${Date.now()}`;

    const [tenant] = await db.insert(tenants).values({
      slug: testTenantSlug,
      name: "RSS-Test-Tenant",
    }).returning();

    const [user] = await db.insert(users).values({
      tenantId: tenant.id,
      email: `rss-admin-${Date.now()}@test.de`,
    }).returning();

    const [body] = await db.insert(risBodies).values({
      tenantId: tenant.id,
      key: "rss-test-body",
      risType: "provox_iip",
      baseUrl: "https://rss-test.example.de",
    }).returning();

    const [meetPub] = await db.insert(risMeetings).values({
      bodyId: body.id,
      externalId: `rss-pub-${Date.now()}`,
      gremium: "Testgremium",
      sourceUrl: "https://rss-test.example.de/meeting/pub",
      fetchedAt: new Date(),
    }).returning();

    const [doc] = await db.insert(risDocuments).values({
      meetingId: meetPub.id,
      docType: "top",
      externalId: "rss-top-1",
      title: "TOP 1",
      bodyText: "Testbeschluss für RSS",
      sourceUrl: "https://rss-test.example.de/doc/1",
      fetchedAt: new Date(),
    }).returning();

    const now = new Date();
    const [digestPub] = await db.insert(digests).values({
      tenantId: tenant.id,
      meetingId: meetPub.id,
      title: pubDigestTitle,
      status: "veroeffentlicht",
      generator: "extractive_v1",
      approvedBy: user.id,
      approvedAt: now,
      publishedAt: now,
    }).returning();

    await db.insert(digestStatements).values({
      digestId: digestPub.id,
      position: 1,
      text: "TOP 1: Testgremium hat Testbeschluss gefasst.",
      sourceDocumentId: doc.id,
      sourceUrl: "https://rss-test.example.de/doc/1",
    });

    // Nicht-veröffentlichter Digest (darf NICHT im Feed erscheinen)
    const [meetEntwurf] = await db.insert(risMeetings).values({
      bodyId: body.id,
      externalId: `rss-entwurf-${Date.now()}`,
      sourceUrl: "https://rss-test.example.de/meeting/entwurf",
      fetchedAt: new Date(),
    }).returning();

    await db.insert(digests).values({
      tenantId: tenant.id,
      meetingId: meetEntwurf.id,
      title: "Nicht-öffentlicher Entwurf",
      status: "entwurf",
      generator: "extractive_v1",
    });

    // DATABASE_URL für den Route Handler setzen
    process.env.DATABASE_URL = TEST_DB_URL;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  it.skipIf(SKIP)("RSS-Feed enthält valides XML", async () => {
    const { GET } = await import("@/app/api/digest/rss/route.js");

    const req = new NextRequest("http://localhost:3000/api/digest/rss", {
      headers: { host: `${testTenantSlug}.localhost:3000` },
    });

    const response = await GET(req);
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toContain('<?xml version="1.0"');
    expect(text).toContain('<rss version="2.0"');
    expect(text).toContain("</channel>");
    expect(text).toContain("</rss>");
  });

  it.skipIf(SKIP)("RSS-Feed enthält nur veröffentlichte Digests", async () => {
    const { GET } = await import("@/app/api/digest/rss/route.js");

    const req = new NextRequest("http://localhost:3000/api/digest/rss", {
      headers: { host: `${testTenantSlug}.localhost:3000` },
    });

    const response = await GET(req);
    const text = await response.text();

    expect(text).toContain(pubDigestTitle);
    expect(text).not.toContain("Nicht-öffentlicher Entwurf");
  });

  it.skipIf(SKIP)("RSS-Feed enthält Aussagen als Beschreibung", async () => {
    const { GET } = await import("@/app/api/digest/rss/route.js");

    const req = new NextRequest("http://localhost:3000/api/digest/rss", {
      headers: { host: `${testTenantSlug}.localhost:3000` },
    });

    const response = await GET(req);
    const text = await response.text();

    expect(text).toContain("Testgremium hat Testbeschluss gefasst");
  });

  it.skipIf(SKIP)("RSS-Feed für unbekannten Tenant → 404", async () => {
    const { GET } = await import("@/app/api/digest/rss/route.js");

    const req = new NextRequest("http://localhost:3000/api/digest/rss", {
      headers: { host: "unbekannt-tenant.localhost:3000" },
    });

    const response = await GET(req);
    expect(response.status).toBe(404);
  });
});
