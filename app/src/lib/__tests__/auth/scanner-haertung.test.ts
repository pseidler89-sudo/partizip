/**
 * scanner-haertung.test.ts — Magic-Link-Härtung gegen E-Mail-Scanner
 *
 * HINTERGRUND: Security-Scanner und Client-Prefetch folgen Links in E-Mails
 * automatisch per GET. Die Bestätigungsseite prüft den Token deshalb nur noch
 * (getTokenStatus, reiner Lesezugriff); eingelöst wird erst per bewusstem
 * POST /api/auth/verify.
 *
 * Testet (echte Funktionen, Integration gegen DATABASE_URL_TEST):
 *   1. KERN-REGRESSION: GET-Prüfung verbraucht den Token NICHT —
 *      danach ist er weiterhin einlösbar.
 *   2. Scanner-Szenario: zwei GET-Prüfungen (Scanner + Mensch),
 *      POST funktioniert danach weiterhin.
 *   3. POST löst genau einmal ein; zweiter POST → TOKEN_USED,
 *      keine zweite Session.
 *   4. Abgelaufener Token: GET-Prüfung → "expired", POST → TOKEN_EXPIRED.
 *   5. Statusdiagnose: verbrauchter Token → "used", unbekannter → "unknown".
 *   6. GET-Prüfung schreibt auch kein Audit-Event (vollständig
 *      nebenwirkungsfrei — Scanner dürfen das Protokoll nicht fluten).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { eq, count, and } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex, generateRawToken } from "@/lib/auth/crypto.js";
import { getTokenStatus } from "@/lib/auth/token-status.js";
import { scopedDb } from "@/lib/db/tenant-scope.js";
import { createTestDb, TEST_DB_URL, type TestDb } from "./test-helpers.js";

import { POST as verifyHandler } from "@/app/api/auth/verify/route.js";

const SKIP = !TEST_DB_URL;
const skipMsg = "DATABASE_URL_TEST nicht gesetzt";

function makeVerifyRequest(rawToken: string): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("x-test-host", "test-a.localhost");
  return new NextRequest("http://test-a.localhost/api/auth/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({ token: rawToken }),
  });
}

describe("Magic-Link Scanner-Härtung (GET prüft nur, POST konsumiert)", () => {
  let sql: Awaited<ReturnType<typeof createTestDb>>["sql"] | undefined;
  let db: TestDb | undefined;
  let tenantAId: string;

  beforeAll(async () => {
    if (SKIP) return;

    ({ sql, db } = await createTestDb());

    const [tA] = await db!
      .insert(schema.tenants)
      .values({ slug: "test-a", name: "Test Tenant A", isActive: true })
      .returning({ id: schema.tenants.id });
    tenantAId = tA.id;

    process.env.DATABASE_URL = TEST_DB_URL!;
    process.env.ALLOW_TEST_HOST_OVERRIDE = "1";
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  async function seedUserAndToken(
    email: string,
    opts: { expiresAt?: Date } = {}
  ): Promise<{ rawToken: string; tokenHash: string }> {
    await db!
      .insert(schema.users)
      .values({ tenantId: tenantAId, email, minAgeConfirmedAt: new Date() })
      .onConflictDoNothing();

    const rawToken = generateRawToken();
    const tokenHash = sha256Hex(rawToken);
    await db!.insert(schema.authTokens).values({
      tenantId: tenantAId,
      email,
      tokenHash,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
    });
    return { rawToken, tokenHash };
  }

  async function loadToken(tokenHash: string) {
    const rows = await db!
      .select()
      .from(schema.authTokens)
      .where(eq(schema.authTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Test 1 (KERN-REGRESSION): GET-Prüfung verbraucht den Token NICHT
  // -------------------------------------------------------------------------
  it("KERN-REGRESSION: GET-Prüfung verbraucht den Token nicht — danach weiterhin einlösbar", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const { rawToken, tokenHash } = await seedUserAndToken("get-no-consume@test.com");
    const scoped = scopedDb(db!, tenantAId);

    // GET-Semantik der Bestätigungsseite: nur prüfen
    const status = await getTokenStatus(scoped, rawToken);
    expect(status).toBe("valid");

    // Kein Verbrauch: consumed_at ist weiterhin NULL
    const row = await loadToken(tokenHash);
    expect(row?.consumedAt).toBeNull();

    // Danach ist der Token weiterhin einlösbar (POST → 200)
    const res = await verifyHandler(makeVerifyRequest(rawToken));
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Test 2: Scanner-Szenario — zwei GETs (Scanner + Mensch), dann POST
  // -------------------------------------------------------------------------
  it("zwei GET-Prüfungen (Scanner + Mensch) → POST funktioniert danach weiterhin", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const { rawToken, tokenHash } = await seedUserAndToken("scanner-then-human@test.com");
    const scoped = scopedDb(db!, tenantAId);

    // 1. GET: E-Mail-Scanner folgt dem Link automatisch
    expect(await getTokenStatus(scoped, rawToken)).toBe("valid");
    // 2. GET: der Mensch öffnet den Link
    expect(await getTokenStatus(scoped, rawToken)).toBe("valid");

    // Token unverändert unverbraucht
    const row = await loadToken(tokenHash);
    expect(row?.consumedAt).toBeNull();

    // Bewusster Klick (POST) → Anmeldung gelingt
    const res = await verifyHandler(makeVerifyRequest(rawToken));
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Test 3: POST genau einmal — zweiter POST → TOKEN_USED, keine 2. Session
  // -------------------------------------------------------------------------
  it("POST löst genau einmal ein; zweiter POST → TOKEN_USED, keine zweite Session", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const email = "post-once@test.com";
    const { rawToken } = await seedUserAndToken(email);

    const res1 = await verifyHandler(makeVerifyRequest(rawToken));
    expect(res1.status).toBe(200);

    const res2 = await verifyHandler(makeVerifyRequest(rawToken));
    const body2 = (await res2.json()) as { error?: { code?: string } };
    expect(res2.status).toBe(400);
    expect(body2.error?.code).toBe("TOKEN_USED");
    // Zweite Antwort setzt KEINE Session
    expect(res2.headers.get("Set-Cookie")).toBeNull();

    // Genau EINE Session in der DB für diesen User
    const userRows = await db!
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantAId), eq(schema.users.email, email)))
      .limit(1);
    const sessionRows = await db!
      .select({ n: count() })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userRows[0].id));
    expect(sessionRows[0]?.n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: Abgelaufener Token — GET zeigt "expired", POST wird abgewiesen
  // -------------------------------------------------------------------------
  it("abgelaufener Token: GET-Prüfung → 'expired', POST → TOKEN_EXPIRED", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const { rawToken } = await seedUserAndToken("expired-check@test.com", {
      expiresAt: new Date(Date.now() - 1000),
    });
    const scoped = scopedDb(db!, tenantAId);

    expect(await getTokenStatus(scoped, rawToken)).toBe("expired");

    const res = await verifyHandler(makeVerifyRequest(rawToken));
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("TOKEN_EXPIRED");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 5: Statusdiagnose — verbraucht → "used", unbekannt → "unknown"
  // -------------------------------------------------------------------------
  it("Statusdiagnose: verbrauchter Token → 'used', unbekannter Token → 'unknown'", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const { rawToken } = await seedUserAndToken("used-check@test.com");
    const scoped = scopedDb(db!, tenantAId);

    // Einlösen, dann prüfen
    const res = await verifyHandler(makeVerifyRequest(rawToken));
    expect(res.status).toBe(200);
    expect(await getTokenStatus(scoped, rawToken)).toBe("used");

    // Nie ausgestellter Token
    expect(await getTokenStatus(scoped, generateRawToken())).toBe("unknown");
  });

  // -------------------------------------------------------------------------
  // Test 6: GET-Prüfung ist vollständig nebenwirkungsfrei (kein Audit-Event)
  // -------------------------------------------------------------------------
  it("GET-Prüfung schreibt kein Audit-Event (Scanner fluten das Protokoll nicht)", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);

    const { rawToken } = await seedUserAndToken("no-audit-on-get@test.com");
    const scoped = scopedDb(db!, tenantAId);

    const before = await db!
      .select({ n: count() })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.tenantId, tenantAId));

    // 5 Scanner-artige Prüfungen — auch für abgelaufene/unbekannte Tokens
    for (let i = 0; i < 3; i++) {
      await getTokenStatus(scoped, rawToken);
    }
    await getTokenStatus(scoped, generateRawToken());
    await getTokenStatus(scoped, generateRawToken());

    const after = await db!
      .select({ n: count() })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.tenantId, tenantAId));

    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
