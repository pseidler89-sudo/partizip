/**
 * notify-actions.test.ts — DB-Integrationstest für die ECHTE Opt-out-Action
 * setNeuePollBenachrichtigung (Benachrichtigungs-Motor). Muster: lifecycle.test.ts.
 *
 * Die Action liest Tenant/Session aus dem Request-Kontext. Damit wir die ECHTE
 * Funktion ausführen, mocken wir:
 *   - next/headers  → Host + Session-Cookie,
 *   - @/lib/tenant  → getTenantFromHost liefert den Test-Tenant,
 *   - @/db/client   → createDb liefert die Test-DB.
 * Session wird real in die Test-DB geschrieben, sodass der DB-Lookup durchläuft.
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt / DSGVO):
 *   - setzt das Flag auf false bzw. true (self + tenant-scoped UPDATE),
 *   - schreibt ein PII-freies Audit (keine E-Mail in metadata),
 *   - berührt NUR den eigenen User des eigenen Tenants (Fremd-User unverändert).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";

const { tenants, users, sessions, auditEvents } = schema;

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

type DbType = ReturnType<typeof drizzle>;

const mockHost = "test.localhost";
let mockSessionToken: string | null = null;
let mockTenantRow: { id: string; slug: string; name: string } | null = null;
let mockDbForActions: DbType | null = null;

vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => (k === "host" ? mockHost : null) }),
  cookies: () => ({
    get: (name: string) =>
      name === "partizip_session" && mockSessionToken
        ? { value: mockSessionToken }
        : undefined,
    set: () => {},
  }),
}));

vi.mock("@/lib/tenant", () => ({
  getTenantFromHost: async () => mockTenantRow,
}));

vi.mock("@/db/client", () => ({
  createDb: () => mockDbForActions,
}));

describe("konto/notify-actions (Integration, echte Action)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let otherTenantId: string;
  let userId: string;
  let otherUserId: string;

  let setNeuePollBenachrichtigung: typeof import("@/lib/konto/notify-actions").setNeuePollBenachrichtigung;

  let counter = 0;
  const nextSlug = (p: string) => `${p}-${Date.now()}-${++counter}`;

  async function loginAls(uid: string) {
    const rawToken = `tok-${Date.now()}-${++counter}`;
    await db.insert(sessions).values({
      tenantId,
      userId: uid,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    mockSessionToken = rawToken;
  }

  beforeAll(async () => {
    if (SKIP) return;

    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_, { schema });
    await migrate(db, { migrationsFolder });
    mockDbForActions = db;

    const [t] = await db.insert(tenants).values({ slug: nextSlug("na"), name: "Notify-Action" }).returning();
    tenantId = t.id;
    mockTenantRow = { id: t.id, slug: t.slug, name: t.name };

    const [t2] = await db.insert(tenants).values({ slug: nextSlug("na-other"), name: "NA-Other" }).returning();
    otherTenantId = t2.id;

    const [u] = await db
      .insert(users)
      .values({ tenantId, email: `me-${Date.now()}@na.de`, minAgeConfirmedAt: new Date(), notifyNewPolls: true })
      .returning();
    userId = u.id;

    // Fremd-User (anderer Tenant) als Isolations-Kontrolle.
    const [ou] = await db
      .insert(users)
      .values({ tenantId: otherTenantId, email: `other-${Date.now()}@na.de`, notifyNewPolls: true })
      .returning();
    otherUserId = ou.id;

    const mod = await import("@/lib/konto/notify-actions");
    setNeuePollBenachrichtigung = mod.setNeuePollBenachrichtigung;

    await loginAls(userId);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("setzt das Flag auf false (abbestellen) — self + tenant-scoped", async () => {
    const res = await setNeuePollBenachrichtigung(false);
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.notifyNewPolls).toBe(false);

    // Fremd-User unverändert (Isolation).
    const [other] = await db.select().from(users).where(eq(users.id, otherUserId));
    expect(other.notifyNewPolls).toBe(true);
  });

  it.skipIf(SKIP)("setzt das Flag wieder auf true und schreibt PII-freies Audit", async () => {
    const res = await setNeuePollBenachrichtigung(true);
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.notifyNewPolls).toBe(true);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "konto.notify_new_polls"), eq(auditEvents.targetId, userId)));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    // PII-frei: keine E-Mail-Adresse im Audit.
    for (const a of audit) {
      expect(JSON.stringify(a.metadata)).not.toContain("@");
    }
  });

  it.skipIf(SKIP)("ohne Session → nicht authentifiziert (kein UPDATE)", async () => {
    mockSessionToken = null;
    const res = await setNeuePollBenachrichtigung(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/authentifiziert/i);

    // Flag unverändert (steht aus dem vorigen Test auf true).
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.notifyNewPolls).toBe(true);

    await loginAls(userId); // für etwaige Folge-Tests
  });
});
