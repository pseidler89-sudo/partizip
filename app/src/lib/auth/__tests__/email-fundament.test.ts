/**
 * email-fundament.test.ts — DB-Integrationstest Block J2a (Audit-Fund F-A).
 *
 * Prüft die kanonische E-Mail-Invariante gegen ein ephemeres PG16 mit den
 * ECHTEN Funktionen (keine Logik-Spiegelung):
 *   - Registrierungs-Dedup: gemischte Groß-/Kleinschreibung wird kanonisch
 *     gespeichert; ein Lookup mit anderer Schreibweise findet DASSELBE Konto.
 *   - Funktionaler Unique-Index users_tenant_email_lower_unique: ein direkter
 *     DB-Insert eines Case-Zwillings scheitert mit 23505 (via istPgFehler).
 *   - Rate-Limit-Budget: a@x.de und A@x.de teilen EIN HMAC-Budget (kein Bypass).
 *   - Verify-Pfad: der beim Request kanonisch gespeicherte Token-E-Mail-Wert
 *     findet den User über scopedDb.users.findByEmail wieder.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst skip).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { scopedDb } from "@/lib/db/tenant-scope";
import { normalizeEmail } from "@/lib/auth/email";
import { writeRateLimitEvents, checkRateLimit } from "@/lib/auth/rate-limit";
import { istPgFehler, PG_UNIQUE_VIOLATION } from "@/lib/db/pg-errors";
import type { Db } from "@/db/client";

const { tenants, users } = schema;

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

describe("J2a E-Mail-Fundament (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;
  let tenantId: string;

  let counter = 0;
  function nextLocal(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}`;
  }

  beforeAll(async () => {
    if (SKIP) return;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_, { schema }) as unknown as Db;
    await migrate(db, { migrationsFolder });

    const [t1] = await db
      .insert(tenants)
      .values({ slug: `j2a-${Date.now()}`, name: "J2a-Test-Tenant" })
      .returning();
    tenantId = t1.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  it.skipIf(SKIP)(
    "Registrierungs-Dedup: MixedCase wird kanonisch gespeichert, Lookup case-insensitiv",
    async () => {
      const scoped = scopedDb(db, tenantId);
      const local = nextLocal("max");
      const created = await scoped.users.create(`  ${local}@Example.COM `, new Date());

      // Gespeichert = kanonisch (trim + lowercase).
      expect(created.email).toBe(`${local}@example.com`);

      // Zweiter „Request" mit anderer Schreibweise findet DASSELBE Konto.
      const found = await scoped.users.findByEmail(`${local.toUpperCase()}@EXAMPLE.com`);
      expect(found?.id).toBe(created.id);
    },
  );

  // -------------------------------------------------------------------------
  it.skipIf(SKIP)(
    "Case-Zwilling per direktem Insert → Unique-Verletzung (funktionaler Index greift)",
    async () => {
      const local = nextLocal("zwilling");
      await db.insert(users).values({ tenantId, email: `${local}@example.com` });

      let err: unknown = null;
      try {
        // Andere Schreibweise, gleicher lower(email) → 23505.
        await db.insert(users).values({ tenantId, email: `${local.toUpperCase()}@Example.com` });
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(istPgFehler(err, PG_UNIQUE_VIOLATION)).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  it.skipIf(SKIP)(
    "Rate-Limit: a@x.de und A@x.de teilen EIN Budget (kein Case-Bypass)",
    async () => {
      const local = nextLocal("rl");
      const lower = `${local}@x.de`;
      const upper = `${local.toUpperCase()}@X.DE`;

      // 4 Requests, Schreibweise abwechselnd → alle in denselben email-Scope.
      await writeRateLimitEvents(db, { tenantId, email: lower, ipAddress: null });
      await writeRateLimitEvents(db, { tenantId, email: upper, ipAddress: null });
      await writeRateLimitEvents(db, { tenantId, email: lower, ipAddress: null });
      await writeRateLimitEvents(db, { tenantId, email: upper, ipAddress: null });

      // Prüfung mit der kleingeschriebenen Variante → über EMAIL_MAX_REQUESTS (3).
      const res = await checkRateLimit(db, {
        tenantId,
        email: lower,
        ipAddress: null,
        actorRef: null,
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.reason).toBe("email");

      // Eine unabhängige Adresse ist NICHT betroffen.
      const other = await checkRateLimit(db, {
        tenantId,
        email: `${nextLocal("other")}@x.de`,
        ipAddress: null,
        actorRef: null,
      });
      expect(other.allowed).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  it.skipIf(SKIP)(
    "Verify-Pfad: kanonisch gespeicherte Token-E-Mail findet den User",
    async () => {
      const scoped = scopedDb(db, tenantId);
      const local = nextLocal("verify");
      const user = await scoped.users.create(`${local}@Example.com`, new Date());

      // Token wird über scopedDb angelegt (E-Mail defensiv kanonisiert).
      await scoped.authTokens.create({
        email: `${local}@EXAMPLE.COM`,
        tokenHash: `hash-${local}`,
        expiresAt: new Date(Date.now() + 60_000),
      });

      // Der Verify-Pfad liest consumed.email (kanonisch) und findet den User.
      const tokenRow = await scoped.authTokens.findByHash(`hash-${local}`);
      expect(tokenRow?.email).toBe(normalizeEmail(`${local}@example.com`));
      const found = await scoped.users.findByEmail(tokenRow!.email);
      expect(found?.id).toBe(user.id);
    },
  );
});
