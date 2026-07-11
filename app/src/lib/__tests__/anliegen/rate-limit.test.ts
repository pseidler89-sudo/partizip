/**
 * rate-limit.test.ts — Integrationstests für das Anliegen-Rate-Limit (H2a).
 *
 * Deterministisch über rate_limit_events (echte DB). Läuft NUR wenn
 * DATABASE_URL_TEST gesetzt ist (Muster aus digest/__tests__/pruef-workflow.test.ts).
 *
 * Getestet:
 *   - User-Limit: 5/60min, das 6. Anliegen wird geblockt (count > MAX)
 *   - IP-Limit: 15/60min greift auch über mehrere User hinweg
 *   - Ohne IP wird nur das User-Limit geprüft
 *   - Block schreibt Audit-Event anliegen.rate_limited (PII-frei, {dimension})
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import {
  checkAnliegenRateLimit,
  ANLIEGEN_RATE_LIMITS,
} from "@/lib/anliegen/rate-limit";
import type { Db } from "@/db/client";

const { tenants, auditEvents } = schema;

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

describe("Anliegen-Rate-Limit (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;
  let tenantId: string;

  beforeAll(async () => {
    if (SKIP) return;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_) as unknown as Db;
    await migrate(db as never, { migrationsFolder });

    const [tenant] = await db
      .insert(tenants)
      .values({ slug: `rl-${Date.now()}`, name: "RL-Test-Tenant" })
      .returning();
    tenantId = tenant.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("erlaubt bis zum User-Limit, blockt das übernächste", async () => {
    const userId = `user-${Date.now()}-a`;
    // MAX erlaubte Aufrufe (jeder schreibt ein Event, count steigt 1..MAX → erlaubt)
    for (let i = 0; i < ANLIEGEN_RATE_LIMITS.USER_MAX; i++) {
      const r = await checkAnliegenRateLimit(db, { tenantId, userId, ipAddress: null });
      expect(r.allowed).toBe(true);
    }
    // Der (MAX+1)-te Aufruf: count = MAX+1 > MAX → blockiert
    const blocked = await checkAnliegenRateLimit(db, { tenantId, userId, ipAddress: null });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe("user");
  });

  it.skipIf(SKIP)("IP-Limit greift über mehrere User hinweg", async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 250) + 1}`;
    // Jeder Aufruf nutzt einen frischen User (User-Limit greift nie),
    // aber dieselbe IP. Nach IP_MAX erlaubten Aufrufen blockt der nächste.
    for (let i = 0; i < ANLIEGEN_RATE_LIMITS.IP_MAX; i++) {
      const r = await checkAnliegenRateLimit(db, {
        tenantId,
        userId: `user-ip-${Date.now()}-${i}`,
        ipAddress: ip,
      });
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkAnliegenRateLimit(db, {
      tenantId,
      userId: `user-ip-${Date.now()}-final`,
      ipAddress: ip,
    });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe("ip");
  });

  it.skipIf(SKIP)("schreibt PII-freies Audit-Event bei Block (user-Dimension)", async () => {
    const userId = `user-${Date.now()}-audit`;
    for (let i = 0; i < ANLIEGEN_RATE_LIMITS.USER_MAX; i++) {
      await checkAnliegenRateLimit(db, { tenantId, userId, ipAddress: null });
    }
    await checkAnliegenRateLimit(db, { tenantId, userId, ipAddress: null });

    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "anliegen.rate_limited"),
          eq(auditEvents.actorRef, userId)
        )
      );

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(meta.dimension).toBe("user");
    // PII-frei: kein E-Mail-artiger Inhalt in den Metadaten
    expect(JSON.stringify(meta)).not.toContain("@");
  });

  it.skipIf(SKIP)("ohne IP wird nur das User-Limit geprüft (kein IP-Block)", async () => {
    // Frischer User, viele Aufrufe ohne IP — sobald User-Limit greift, ist es 'user'.
    const userId = `user-${Date.now()}-noip`;
    let lastReason: string | undefined;
    for (let i = 0; i < ANLIEGEN_RATE_LIMITS.USER_MAX + 2; i++) {
      const r = await checkAnliegenRateLimit(db, { tenantId, userId, ipAddress: null });
      if (!r.allowed) lastReason = r.reason;
    }
    expect(lastReason).toBe("user");
  });
});
