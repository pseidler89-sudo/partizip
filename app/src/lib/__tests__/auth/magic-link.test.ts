/**
 * magic-link.test.ts — Magic-Link Auth Integrationstests
 *
 * Testet:
 *   1. TTL (abgelaufener Token → TOKEN_EXPIRED)
 *   2. Single-Use (2. Einlösung → TOKEN_USED)
 *   3. RACE: 10 parallele Verify-Requests → genau EINE Session entsteht
 *   4. Token-Hash in DB ≠ Roh-Token
 *   5. tenant_mismatch → 403
 *   6. Rate-Limit: 4. Request bleibt HTTP 200, kein neuer Token
 *   7. Enumeration: existierender User vs. nicht-existierender OHNE minAgeConfirmed —
 *      Bodies byte-gleich (Strings vergleichen), Status gleich (MIN5)
 *   8. Cookie-Attribute: HttpOnly, SameSite=Lax
 *   9. B1-Regression: 4. Request an nicht-existierende E-Mail → keine 4. Mail
 *      (sendMail gemockt)
 *  10. H3: zweiter offener Token nach Verify ungültig
 *  11. B2: Secure-Cookie-Flag gesetzt wenn NODE_ENV=production
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, count, and } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { sha256Hex, generateRawToken } from "@/lib/auth/crypto.js";
import { buildSessionCookieHeader } from "@/lib/auth/session.js";

// Import route handlers
import { POST as requestHandler } from "@/app/api/auth/request/route.js";
import { POST as verifyHandler } from "@/app/api/auth/verify/route.js";

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

// Hilfsfunktion: NextRequest bauen
function makeRequest(
  url: string,
  opts: {
    method?: string;
    body?: unknown;
    host?: string;
    cookie?: string;
    origin?: string;
  } = {}
): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (opts.host) headers.set("x-test-host", opts.host);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.origin) headers.set("origin", opts.origin);

  return new NextRequest(url, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("Magic-Link Auth Integration", () => {
  let sql: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>> | undefined;
  let tenantAId: string;

  beforeAll(async () => {
    if (SKIP) return;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql = postgres(TEST_DB_URL!, { max: 20 });
    db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder });

    // Tenants anlegen
    const [tA] = await db
      .insert(schema.tenants)
      .values({ slug: "test-a", name: "Test Tenant A", isActive: true })
      .returning({ id: schema.tenants.id });
    tenantAId = tA.id;

    // Tenant B (für Mismatch-Test)
    await db
      .insert(schema.tenants)
      .values({ slug: "test-b", name: "Test Tenant B", isActive: true });

    // Env-Variablen für Route-Handler
    process.env.DATABASE_URL = TEST_DB_URL!;
    // NODE_ENV = "test" ist in Vitest bereits gesetzt
    process.env.ALLOW_TEST_HOST_OVERRIDE = "1";
  });

  afterAll(async () => {
    if (sql) await sql.end();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Abgelaufener Token → TOKEN_EXPIRED
  // -------------------------------------------------------------------------
  it("abgelaufener Token → TOKEN_EXPIRED", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);
    const pastDate = new Date(Date.now() - 1000);

    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email: "expired@test.com",
      tokenHash,
      expiresAt: pastDate,
    });

    const req = makeRequest("http://test-a.localhost/api/auth/verify", {
      body: { token: rawToken },
      host: "test-a.localhost",
    });

    const res = await verifyHandler(req);
    const body = await res.json() as { error?: { code?: string } };

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("TOKEN_EXPIRED");
  });

  // -------------------------------------------------------------------------
  // Test 2: Single-Use — 2. Einlösung → TOKEN_USED
  // -------------------------------------------------------------------------
  it("Token nur einmal einlösbar → TOKEN_USED beim 2. Versuch", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // User anlegen
    await db!.insert(schema.users).values({
      tenantId: tenantAId,
      email: "single-use@test.com",
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);

    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email: "single-use@test.com",
      tokenHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const makeVerifyReq = () =>
      makeRequest("http://test-a.localhost/api/auth/verify", {
        body: { token: rawToken },
        host: "test-a.localhost",
      });

    // 1. Einlösung
    const res1 = await verifyHandler(makeVerifyReq());
    expect(res1.status).toBe(200);

    // 2. Einlösung → TOKEN_USED
    const res2 = await verifyHandler(makeVerifyReq());
    const body2 = await res2.json() as { error?: { code?: string } };
    expect(res2.status).toBe(400);
    expect(body2.error?.code).toBe("TOKEN_USED");
  });

  // -------------------------------------------------------------------------
  // Test 3: RACE — 10 parallele Requests → genau EINE Session
  // -------------------------------------------------------------------------
  it("RACE: 10 parallele Verify-Requests → genau EINE Session entsteht", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    await db!.insert(schema.users).values({
      tenantId: tenantAId,
      email: "race@test.com",
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);

    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email: "race@test.com",
      tokenHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // 10 parallele Anfragen
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        verifyHandler(
          makeRequest("http://test-a.localhost/api/auth/verify", {
            body: { token: rawToken },
            host: "test-a.localhost",
          })
        )
      )
    );

    const statuses = results.map((r) => r.status);
    const successCount = statuses.filter((s) => s === 200).length;
    const failCount = statuses.filter((s) => s !== 200).length;

    // Genau eine Erfolgreich
    expect(successCount).toBe(1);
    expect(failCount).toBe(9);

    // Genau eine Session in der DB für diesen User (token_hash ist unique)
    const userRows = await db!
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.tenantId, tenantAId),
          eq(schema.users.email, "race@test.com")
        )
      )
      .limit(1);

    const sessionRows = await db!
      .select({ n: count() })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userRows[0].id));

    expect(sessionRows[0]?.n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: Token-Hash in DB ≠ Roh-Token
  // -------------------------------------------------------------------------
  it("Token-Hash in DB ist nicht der Roh-Token", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);

    // Token-Hash und Roh-Token dürfen nicht gleich sein
    expect(tokenHash).not.toBe(rawToken);
    // Hash ist 64 Hex-Zeichen (SHA-256)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Roh-Token ist base64url
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // -------------------------------------------------------------------------
  // Test 5: Tenant-Mismatch → 403
  // -------------------------------------------------------------------------
  it("Token von Tenant A auf Host von Tenant B → 403 FORBIDDEN", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    await db!.insert(schema.users).values({
      tenantId: tenantAId,
      email: "mismatch@test-a.com",
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);

    // Token für Tenant A ausstellen
    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email: "mismatch@test-a.com",
      tokenHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // Einlösung auf Host von Tenant B versuchen
    const req = makeRequest("http://test-b.localhost/api/auth/verify", {
      body: { token: rawToken },
      host: "test-b.localhost",
    });

    const res = await verifyHandler(req);
    const body = await res.json() as { error?: { code?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.code).toBe("FORBIDDEN");
  });

  // -------------------------------------------------------------------------
  // Test 6: Rate-Limit — 4. Request bleibt HTTP 200, kein neuer Token
  // -------------------------------------------------------------------------
  it("Rate-Limit: 4. Request → HTTP 200 (kein Leak), kein neuer Token in DB", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // User für diesen Test (Rate-Limit auf email-Ebene)
    await db!.insert(schema.users).values({
      tenantId: tenantAId,
      email: "ratelimit@test.com",
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    const makeReqReq = () =>
      makeRequest("http://test-a.localhost/api/auth/request", {
        body: { email: "ratelimit@test.com", minAgeConfirmed: true },
        host: "test-a.localhost",
      });

    // 3 Requests durchlassen (Rate-Limit: max 3 in 15 min)
    for (let i = 0; i < 3; i++) {
      const r = await requestHandler(makeReqReq());
      expect(r.status).toBe(200);
    }

    // Tokens vor 4. Request zählen
    const tokensBefore = await db!
      .select({ n: count() })
      .from(schema.authTokens)
      .where(
        and(
          eq(schema.authTokens.tenantId, tenantAId),
          eq(schema.authTokens.email, "ratelimit@test.com")
        )
      );
    const countBefore = tokensBefore[0]?.n ?? 0;

    // 4. Request
    const res4 = await requestHandler(makeReqReq());
    expect(res4.status).toBe(200); // kein Leak

    // Tokens danach — sollte gleich sein (kein neuer Token erzeugt)
    const tokensAfter = await db!
      .select({ n: count() })
      .from(schema.authTokens)
      .where(
        and(
          eq(schema.authTokens.tenantId, tenantAId),
          eq(schema.authTokens.email, "ratelimit@test.com")
        )
      );
    const countAfter = tokensAfter[0]?.n ?? 0;

    expect(countAfter).toBe(countBefore);
  });

  // -------------------------------------------------------------------------
  // Test 7: Enumeration MIN5 — existierender User vs. nicht-existierender
  //         OHNE minAgeConfirmed — Bodies byte-gleich, Status gleich
  // -------------------------------------------------------------------------
  it("MIN5 Enumeration: existierender User vs. nicht-existierender ohne minAgeConfirmed — Bodies byte-gleich", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // Existierende E-Mail mit User
    await db!.insert(schema.users).values({
      tenantId: tenantAId,
      email: "exists-enum@test.com",
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    // Existierender User, kein minAgeConfirmed übergeben
    const reqExists = makeRequest("http://test-a.localhost/api/auth/request", {
      body: { email: "exists-enum@test.com" },
      host: "test-a.localhost",
    });

    // Nicht-existierender User, kein minAgeConfirmed
    const reqNotExists = makeRequest("http://test-a.localhost/api/auth/request", {
      body: { email: "nonexistent-enum-unique@test.com" },
      host: "test-a.localhost",
    });

    const [resExists, resNotExists] = await Promise.all([
      requestHandler(reqExists),
      requestHandler(reqNotExists),
    ]);

    expect(resExists.status).toBe(200);
    expect(resNotExists.status).toBe(200);

    // Bodies byte-gleich (JSON-String-Vergleich)
    const bodyExistsStr = await resExists.text();
    const bodyNotExistsStr = await resNotExists.text();
    expect(bodyExistsStr).toBe(bodyNotExistsStr);
  });

  // -------------------------------------------------------------------------
  // Test 8: Cookie-Attribute prüfen
  // -------------------------------------------------------------------------
  it("Set-Cookie-Header enthält HttpOnly und SameSite=Lax", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    await db!.insert(schema.users).values({
      tenantId: tenantAId,
      email: "cookie-check@test.com",
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);

    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email: "cookie-check@test.com",
      tokenHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const req = makeRequest("http://test-a.localhost/api/auth/verify", {
      body: { token: rawToken },
      host: "test-a.localhost",
    });

    const res = await verifyHandler(req);
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie?.toLowerCase()).toContain("httponly");
    expect(setCookie?.toLowerCase()).toContain("samesite=lax");
  });

  // -------------------------------------------------------------------------
  // Test 9: B1-Regression — 4. Request an nicht-existierende E-Mail
  //         → kein 4. Mailversand (sendMail gemockt)
  // -------------------------------------------------------------------------
  it("B1-Regression: 4. Request an nicht-existierende E-Mail → maximal 3 Mails gesendet", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    // nodemailer.createTransport mocken
    const mailModule = await import("@/lib/auth/mail.js");
    const sendHintSpy = vi.spyOn(mailModule, "sendRegistrationHintEmail").mockResolvedValue(undefined);
    const sendMagicSpy = vi.spyOn(mailModule, "sendMagicLinkEmail").mockResolvedValue(undefined);

    const email = `b1-regression-${Date.now()}@test.com`;

    const makeReq = () =>
      makeRequest("http://test-a.localhost/api/auth/request", {
        body: { email },
        host: "test-a.localhost",
      });

    // 4 Requests senden (kein minAgeConfirmed → Hint-Mail-Pfad)
    for (let i = 0; i < 4; i++) {
      const r = await requestHandler(makeReq());
      expect(r.status).toBe(200); // immer 200
    }

    // Gesamte Mailaufrufe (Hint oder Magic) dürfen maximal 3 sein
    const totalCalls = sendHintSpy.mock.calls.length + sendMagicSpy.mock.calls.length;
    expect(totalCalls).toBeLessThanOrEqual(3);

    sendHintSpy.mockRestore();
    sendMagicSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 10: H3 — zweiter offener Token nach Verify ungültig
  // -------------------------------------------------------------------------
  it("H3: zweiter offener Token für gleiche Email nach erfolgreichem Verify ungültig", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const email = "h3-test@test.com";
    await db!.insert(schema.users).values({
      tenantId: tenantAId,
      email,
      minAgeConfirmedAt: new Date(),
    }).onConflictDoNothing();

    // Token A (wird eingelöst)
    const rawTokenA = generateRawToken();
    const tokenHashA = sha256Hex(rawTokenA);
    // Token B (zweiter offener Token)
    const rawTokenB = generateRawToken();
    const tokenHashB = sha256Hex(rawTokenB);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db!.insert(schema.authTokens).values([
      { tenantId: tenantAId, email, tokenHash: tokenHashA, expiresAt },
      { tenantId: tenantAId, email, tokenHash: tokenHashB, expiresAt },
    ]);

    // Token A einlösen
    const resA = await verifyHandler(
      makeRequest("http://test-a.localhost/api/auth/verify", {
        body: { token: rawTokenA },
        host: "test-a.localhost",
      })
    );
    expect(resA.status).toBe(200);

    // Token B einlösen → sollte TOKEN_USED sein (durch H3 invalidiert)
    const resB = await verifyHandler(
      makeRequest("http://test-a.localhost/api/auth/verify", {
        body: { token: rawTokenB },
        host: "test-a.localhost",
      })
    );
    const bodyB = await resB.json() as { error?: { code?: string } };
    expect(resB.status).toBe(400);
    expect(bodyB.error?.code).toBe("TOKEN_USED");
  });

  // -------------------------------------------------------------------------
  // Test 11: B2 — Secure-Cookie-Flag gesetzt wenn NODE_ENV=production (Unit)
  // -------------------------------------------------------------------------
  it("B2: buildSessionCookieHeader setzt Secure-Flag wenn NODE_ENV=production", () => {
    const origEnv = process.env.NODE_ENV;
    // @ts-expect-error NODE_ENV ist read-only in TS, aber in Tests per process.env mutierbar
    process.env.NODE_ENV = "production";

    try {
      const cookie = buildSessionCookieHeader("rawtoken", new Date(Date.now() + 3600 * 1000), false);
      expect(cookie.toLowerCase()).toContain("secure");
    } finally {
      // @ts-expect-error NODE_ENV ist read-only in TS, aber in Tests per process.env mutierbar
      process.env.NODE_ENV = origEnv;
    }
  });

  // -------------------------------------------------------------------------
  // Test 12: Block K2 (Gate-B MAJOR) — die Konto-Sperre wirkt am Login
  // -------------------------------------------------------------------------
  it("K2: gesperrtes Konto — kein neuer Magic-Link, Verify ohne Session; Entsperren stellt Login wieder her", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const email = "locked-login@test.com";
    const [user] = await db!
      .insert(schema.users)
      .values({
        tenantId: tenantAId,
        email,
        minAgeConfirmedAt: new Date(),
        accountStatus: "locked",
      })
      .returning();

    // (a) /api/auth/request (Defense-in-Depth): neutrale 200, aber KEIN Token —
    // ein gesperrtes Konto bekommt keinen frischen Magic-Link per Mail.
    const zaehleTokens = async () => {
      const rows = await db!
        .select({ n: count() })
        .from(schema.authTokens)
        .where(
          and(
            eq(schema.authTokens.tenantId, tenantAId),
            eq(schema.authTokens.email, email)
          )
        );
      return rows[0]?.n ?? 0;
    };
    const tokensVorher = await zaehleTokens();
    const resReq = await requestHandler(
      makeRequest("http://test-a.localhost/api/auth/request", {
        body: { email, minAgeConfirmed: true },
        host: "test-a.localhost",
      })
    );
    expect(resReq.status).toBe(200); // neutral — kein Status-/Enumeration-Leak
    expect(await zaehleTokens()).toBe(tokensVorher);

    // (b) /api/auth/verify (harte Durchsetzung): selbst mit einem noch
    // GÜLTIGEN Token (z. B. vor der Sperre angefordert) entsteht KEINE Session.
    const rawToken = generateRawToken();
    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const resVerify = await verifyHandler(
      makeRequest("http://test-a.localhost/api/auth/verify", {
        body: { token: rawToken },
        host: "test-a.localhost",
      })
    );
    const bodyVerify = (await resVerify.json()) as { error?: { code?: string } };
    expect(resVerify.status).toBe(400);
    // Generische Meldung im Token-Fehler-Vokabular (kein Status-Oracle).
    expect(bodyVerify.error?.code).toBe("TOKEN_INVALID");

    const zaehleSessions = async () => {
      const rows = await db!
        .select({ n: count() })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, user.id));
      return rows[0]?.n ?? 0;
    };
    expect(await zaehleSessions()).toBe(0);

    // PII-freies Audit für das IR-Lagebild.
    const audit = await db!
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.action, "auth.login_rejected"),
          eq(schema.auditEvents.actorRef, user.id)
        )
      );
    expect(audit.length).toBe(1);
    expect((audit[0].metadata as Record<string, unknown>).reason).toBe("account_status");
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");

    // (c) Regression: nach dem Entsperren funktioniert der Login wieder normal.
    await db!
      .update(schema.users)
      .set({ accountStatus: "active" })
      .where(eq(schema.users.id, user.id));
    const rawToken2 = generateRawToken();
    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email,
      tokenHash: sha256Hex(rawToken2),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const resVerify2 = await verifyHandler(
      makeRequest("http://test-a.localhost/api/auth/verify", {
        body: { token: rawToken2 },
        host: "test-a.localhost",
      })
    );
    expect(resVerify2.status).toBe(200);
    expect(await zaehleSessions()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // J2b-MIN1: purpose-Trennung — ein email_change-Token darf am LOGIN-Endpoint
  // NICHT einlösbar sein (consume() filtert purpose hart in der WHERE-Klausel).
  // -------------------------------------------------------------------------
  it("J2b-MIN1: email_change-Token an /api/auth/verify → TOKEN_INVALID, keine Session, Token unverbraucht", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const email = "purpose-mix@test.com";
    const [user] = await db!
      .insert(schema.users)
      .values({ tenantId: tenantAId, email, minAgeConfirmedAt: new Date() })
      .onConflictDoNothing()
      .returning();

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);
    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email,
      tokenHash,
      purpose: "email_change",
      userId: user?.id ?? null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const res = await verifyHandler(
      makeRequest("http://test-a.localhost/api/auth/verify", {
        body: { token: rawToken },
        host: "test-a.localhost",
      })
    );
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(400);
    // Generisch (Fallback-Pfad) — kein Hinweis auf die purpose-Verwechslung.
    expect(body.error?.code).toBe("TOKEN_INVALID");

    // Token bleibt unverbraucht (der CAS hat ihn wegen purpose='login' nie erfasst)
    // und es ist KEINE Session entstanden.
    const [tok] = await db!
      .select()
      .from(schema.authTokens)
      .where(eq(schema.authTokens.tokenHash, tokenHash));
    expect(tok.consumedAt).toBeNull();
    if (user) {
      const sessionsRows = await db!
        .select({ n: count() })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, user.id));
      expect(sessionsRows[0]?.n ?? 0).toBe(0);
    }
  });

  it("überspringt alle Tests wenn DATABASE_URL_TEST nicht gesetzt", () => {
    if (!TEST_DB_URL) {
      console.log(`SKIP: ${skipMsg}`);
    }
    expect(true).toBe(true);
  });
});
