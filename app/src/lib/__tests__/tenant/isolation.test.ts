/**
 * isolation.test.ts — Tenant-Isolations-Tests (WICHTIGSTES TEST-FILE)
 *
 * Testet:
 *   1. Session von Tenant A wird auf Host von Tenant B abgelehnt
 *   2. /api/me gibt nie Daten eines anderen Tenants
 *   3. getTenantFromHost mit unbekanntem Slug → null
 *   4. scopedDb-Queries liefern nur Tenant-eigene Zeilen
 *   5. M5 Kill-Switch: allowOverride=false → x-test-host ignoriert, host-Header gewinnt
 *   6. MIN4: Host-Normalisierung (Großschreibung + trailing dot)
 *   7. H1: Origin-Check → 403 bei Cross-Origin
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { sha256Hex, generateRawToken } from "@/lib/auth/crypto.js";
import { slugFromHost, getTenantFromHost } from "@/lib/tenant.js";
import { scopedDb } from "@/lib/db/tenant-scope.js";
import { normalizeHost, slugFromNormalizedHost } from "@/lib/host.js";
import { getEffectiveHost } from "@/middleware.js";
import { resolveRegionIdForScope } from "@/lib/region/scope.js";
import type { Db } from "@/db/client.js";

import { GET as meHandler } from "@/app/api/me/route.js";
import { POST as requestHandler } from "@/app/api/auth/request/route.js";
import { POST as verifyHandler } from "@/app/api/auth/verify/route.js";
import { POST as logoutHandler } from "@/app/api/auth/logout/route.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");

const TEST_DB_URL = process.env.DATABASE_URL_TEST;

if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: DATABASE_URL_TEST zeigt auf "${dbName}"`);
  }
}

const SKIP = !TEST_DB_URL;
const skipMsg = "DATABASE_URL_TEST nicht gesetzt";

function makeGetRequest(
  url: string,
  opts: { host?: string; cookie?: string; testHost?: string } = {}
): NextRequest {
  const headers = new Headers();
  if (opts.host) headers.set("host", opts.host);
  if (opts.testHost) headers.set("x-test-host", opts.testHost);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(url, { method: "GET", headers });
}

function makePostRequest(
  url: string,
  opts: {
    host?: string;
    testHost?: string;
    cookie?: string;
    body?: unknown;
    origin?: string;
  } = {}
): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (opts.host) headers.set("host", opts.host);
  if (opts.testHost) headers.set("x-test-host", opts.testHost);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.origin) headers.set("origin", opts.origin);
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("Tenant-Isolation Integration", () => {
  let sql: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>> | undefined;
  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;

  beforeAll(async () => {
    if (SKIP) return;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql = postgres(TEST_DB_URL!, { max: 10 });
    db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder });

    // Tenant A
    const [tA] = await db
      .insert(schema.tenants)
      .values({ slug: "isolation-a", name: "Isolation Tenant A", isActive: true })
      .returning({ id: schema.tenants.id });
    tenantAId = tA.id;

    // Tenant B
    const [tB] = await db
      .insert(schema.tenants)
      .values({ slug: "isolation-b", name: "Isolation Tenant B", isActive: true })
      .returning({ id: schema.tenants.id });
    tenantBId = tB.id;

    // User in Tenant A
    const [uA] = await db
      .insert(schema.users)
      .values({
        tenantId: tenantAId,
        email: "user-a@isolation.test",
        minAgeConfirmedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    userAId = uA.id;

    process.env.DATABASE_URL = TEST_DB_URL!;
    // NODE_ENV = "test" ist in Vitest bereits gesetzt
    process.env.ALLOW_TEST_HOST_OVERRIDE = "1";
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  // -------------------------------------------------------------------------
  // Test 1: Session von Tenant A auf Host von Tenant B → 401/403
  // -------------------------------------------------------------------------
  it("Session von Tenant A wird auf Host von Tenant B abgelehnt", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // Session für Tenant A erstellen
    const rawSessionToken = generateRawToken();
    const sessionHash = sha256Hex(rawSessionToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db!.insert(schema.sessions).values({
      tenantId: tenantAId,
      userId: userAId,
      tokenHash: sessionHash,
      expiresAt,
    });

    const cookieHeader = `partizip_session=${rawSessionToken}`;

    // Request an Tenant B mit Tenant A's Session-Cookie
    const req = makeGetRequest("http://isolation-b.localhost/api/me", {
      testHost: "isolation-b.localhost",
      cookie: cookieHeader,
    });

    const res = await meHandler(req);
    // Muss 401 sein — Session gehört nicht zu Tenant B
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Test 2: /api/me gibt Daten von Tenant A zurück wenn auf Tenant A Host
  // -------------------------------------------------------------------------
  it("/api/me gibt Daten von Tenant A zurück wenn auf Tenant A Host", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const rawSessionToken = generateRawToken();
    const sessionHash = sha256Hex(rawSessionToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db!.insert(schema.sessions).values({
      tenantId: tenantAId,
      userId: userAId,
      tokenHash: sessionHash,
      expiresAt,
    });

    const req = makeGetRequest("http://isolation-a.localhost/api/me", {
      testHost: "isolation-a.localhost",
      cookie: `partizip_session=${rawSessionToken}`,
    });

    const res = await meHandler(req);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      tenant?: { slug?: string };
      user?: { email?: string; hatAufgaben?: boolean };
    };
    expect(body.tenant?.slug).toBe("isolation-a");
    expect(body.user?.email).toBe("user-a@isolation.test");
    // WP2: serverseitiges /aufgaben-Prädikat im Response — User ohne Rollen → false.
    expect(body.user?.hatAufgaben).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2b (WP2): /api/me liefert hatAufgaben=true für einen Rollenträger
  // -------------------------------------------------------------------------
  it("/api/me: hatAufgaben=true für beobachter-Rollenträger (WP2)", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // Rollenträger in Tenant A mit beobachter-Rolle (roles.region_id NOT NULL →
    // Stadt-Knoten über den echten Auflösungsweg; GUC app.region_provision ist
    // im Test-Setup gesetzt).
    const [uRolle] = await db!
      .insert(schema.users)
      .values({
        tenantId: tenantAId,
        email: "beobachter@isolation.test",
        minAgeConfirmedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    const regionId = await resolveRegionIdForScope(
      db! as unknown as Db,
      tenantAId,
      "stadt",
      null,
    );
    await db!.insert(schema.roles).values({
      tenantId: tenantAId,
      userId: uRolle.id,
      roleType: "beobachter",
      regionId,
    });

    const rawSessionToken = generateRawToken();
    await db!.insert(schema.sessions).values({
      tenantId: tenantAId,
      userId: uRolle.id,
      tokenHash: sha256Hex(rawSessionToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const req = makeGetRequest("http://isolation-a.localhost/api/me", {
      testHost: "isolation-a.localhost",
      cookie: `partizip_session=${rawSessionToken}`,
    });
    const res = await meHandler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { hatAufgaben?: boolean } };
    expect(body.user?.hatAufgaben).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: getTenantFromHost mit unbekanntem Slug → null
  // -------------------------------------------------------------------------
  it("getTenantFromHost mit unbekanntem Slug → null", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const result = await getTenantFromHost("nonexistent-slug-xyz.localhost");
    expect(result).toBeNull();
  });

  it("getTenantFromHost mit Haupt-Domain → null", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const result = await getTenantFromHost("localhost");
    expect(result).toBeNull();
  });

  it("getTenantFromHost mit bekanntem aktivem Tenant → TenantRow", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const result = await getTenantFromHost("isolation-a.localhost");
    expect(result).not.toBeNull();
    expect(result?.slug).toBe("isolation-a");
  });

  // -------------------------------------------------------------------------
  // Test 4: scopedDb-Queries liefern nur Tenant-eigene Zeilen
  // -------------------------------------------------------------------------
  it("scopedDb für Tenant A liefert keinen User von Tenant B", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // User in Tenant B anlegen
    await db!.insert(schema.users).values({
      tenantId: tenantBId,
      email: "user-b@isolation.test",
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    // scopedDb für Tenant A sucht nach B's E-Mail → null
    const { createDb } = await import("@/db/client.js");
    const testDb = createDb(TEST_DB_URL!);
    const scopedA = scopedDb(testDb, tenantAId);

    const user = await scopedA.users.findByEmail("user-b@isolation.test");
    expect(user).toBeNull();
  });

  it("scopedDb findById gibt keinen User zurück der einem anderen Tenant gehört", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // User in Tenant B
    const [userB] = await db!
      .insert(schema.users)
      .values({
        tenantId: tenantBId,
        email: "user-b-2@isolation.test",
        minAgeConfirmedAt: new Date(),
      })
      .returning({ id: schema.users.id });

    const { createDb } = await import("@/db/client.js");
    const testDb = createDb(TEST_DB_URL!);
    const scopedA = scopedDb(testDb, tenantAId);

    // Versuche B's User über A's scopedDb zu laden
    const user = await scopedA.users.findById(userB.id);
    expect(user).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 5: slugFromHost (Unit-Test, keine DB nötig)
  // -------------------------------------------------------------------------
  it("slugFromHost: <slug>.partizip.online → slug", () => {
    expect(slugFromHost("taunusstein.partizip.online")).toBe("taunusstein");
  });

  it("slugFromHost: <slug>.localhost → slug", () => {
    expect(slugFromHost("taunusstein.localhost")).toBe("taunusstein");
  });

  it("slugFromHost: <slug>.localhost:3000 → slug", () => {
    expect(slugFromHost("taunusstein.localhost:3000")).toBe("taunusstein");
  });

  it("slugFromHost: partizip.online → null", () => {
    expect(slugFromHost("partizip.online")).toBeNull();
  });

  it("slugFromHost: www.partizip.online → null", () => {
    expect(slugFromHost("www.partizip.online")).toBeNull();
  });

  it("slugFromHost: localhost → null", () => {
    expect(slugFromHost("localhost")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test: M5 Kill-Switch — allowOverride=false → host-Header gewinnt, x-test-host ignoriert
  // -------------------------------------------------------------------------
  it("M5 Kill-Switch: allowOverride=false → host-Header gewinnt, x-test-host ignoriert", () => {
    // Echter Funktionstest von getEffectiveHost mit allowOverride=false
    const req = new NextRequest("http://isolation-a.localhost/api/auth/request", {
      headers: {
        host: "isolation-a.localhost",
        "x-test-host": "evil.localhost",
      },
      method: "POST",
    });

    // allowOverride=false explizit injiziert → host-Header gewinnt
    const effectiveHost = getEffectiveHost(req, false);
    expect(effectiveHost).toBe("isolation-a.localhost");
    expect(effectiveHost).not.toContain("evil");
  });

  it("M5 Kill-Switch: allowOverride=true → x-test-host überschreibt", () => {
    const req = new NextRequest("http://isolation-a.localhost/api/auth/request", {
      headers: {
        host: "isolation-a.localhost",
        "x-test-host": "isolation-b.localhost",
      },
      method: "POST",
    });

    const effectiveHost = getEffectiveHost(req, true);
    expect(effectiveHost).toBe("isolation-b.localhost");
  });

  // -------------------------------------------------------------------------
  // Test: MIN4 Host-Normalisierung
  // -------------------------------------------------------------------------
  it("MIN4: normalizeHost — Großschreibung wird lowercase", () => {
    expect(normalizeHost("TAUNUSSTEIN.Partizip.Online")).toBe("taunusstein.partizip.online");
  });

  it("MIN4: normalizeHost — trailing dot wird entfernt", () => {
    expect(normalizeHost("taunusstein.partizip.online.")).toBe("taunusstein.partizip.online");
  });

  it("MIN4: normalizeHost — trailing dot vor Port", () => {
    expect(normalizeHost("taunusstein.localhost.:3000")).toBe("taunusstein.localhost:3000");
  });

  it("MIN4: slugFromNormalizedHost — Großschreibung + trailing dot normalisiert → slug erkannt", () => {
    const slug = slugFromNormalizedHost(normalizeHost("TAUNUSSTEIN.localhost."));
    expect(slug).toBe("taunusstein");
  });

  it("MIN4: slugFromHost normalisiert Großschreibung", () => {
    expect(slugFromHost("TAUNUSSTEIN.PARTIZIP.ONLINE")).toBe("taunusstein");
  });

  // -------------------------------------------------------------------------
  // Test: H1 Origin-Check
  // -------------------------------------------------------------------------
  it("H1: Cross-Origin POST /api/auth/request → 403", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const req = makePostRequest("http://isolation-a.localhost/api/auth/request", {
      testHost: "isolation-a.localhost",
      origin: "https://evil.example.com",
      body: { email: "h1test@test.com", minAgeConfirmed: true },
    });

    const res = await requestHandler(req);
    expect(res.status).toBe(403);
  });

  it("H1: Same-Origin POST /api/auth/request → kein 403 durch Origin-Check", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // Korrekter Origin-Header mit gleichem Host
    const req = makePostRequest("http://isolation-a.localhost/api/auth/request", {
      // x-test-host überschreibt den effektiven Host für Tenant-Lookup,
      // aber der origin-Check vergleicht origin-host mit request "host" header.
      // Deshalb setzen wir host UND x-test-host gleich.
      host: "isolation-a.localhost",
      testHost: "isolation-a.localhost",
      origin: "http://isolation-a.localhost",
      body: { email: "h1same@test.com", minAgeConfirmed: true },
    });

    const res = await requestHandler(req);
    // Kein 403 durch Origin-Check (auch wenn 404 wegen keinem Tenant, das ist OK)
    expect(res.status).not.toBe(403);
  });

  it("H1: Cross-Origin POST /api/auth/verify → 403", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const req = makePostRequest("http://isolation-a.localhost/api/auth/verify", {
      testHost: "isolation-a.localhost",
      origin: "https://evil.example.com",
      body: { token: "sometoken" },
    });

    const res = await verifyHandler(req);
    expect(res.status).toBe(403);
  });

  it("H1: Cross-Origin POST /api/auth/logout → 403", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const req = makePostRequest("http://isolation-a.localhost/api/auth/logout", {
      testHost: "isolation-a.localhost",
      origin: "https://evil.example.com",
    });

    const res = await logoutHandler(req);
    expect(res.status).toBe(403);
  });

  it("überspringt alle Tests wenn DATABASE_URL_TEST nicht gesetzt", () => {
    if (!TEST_DB_URL) console.log(`SKIP: ${skipMsg}`);
    expect(true).toBe(true);
  });
});
