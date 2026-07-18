/**
 * region-actions.test.ts — Wohnort-Invariante (Block J2c, Teil B, Gate-B-Lens 2).
 *
 * Prüft die ECHTE Action wohnortAnzeigeZuruecksetzen (Mock-Setup wie
 * konto/notify-actions.test.ts): sie nullt AUSSCHLIESSLICH home_region_id und
 * löscht das Region-Cookie — residency_region_id UND ortsteil_id bleiben
 * UNVERÄNDERT (der verbindliche Stimm-Anker darf nie aus dem Konto geschrieben/
 * gelöscht werden). Audit PII-frei; tenant + self-scoped.
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

const { tenants, users, sessions, auditEvents, regions, ortsteile } = schema;

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
const cookieDelete = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => (k === "host" ? mockHost : null) }),
  cookies: () => ({
    get: (name: string) =>
      name === "partizip_session" && mockSessionToken
        ? { value: mockSessionToken }
        : undefined,
    set: () => {},
    delete: (name: string) => cookieDelete(name),
  }),
}));

vi.mock("@/lib/tenant", () => ({
  getTenantFromHost: async () => mockTenantRow,
}));

vi.mock("@/db/client", () => ({
  createDb: () => mockDbForActions,
}));

describe("region/actions wohnortAnzeigeZuruecksetzen (Integration, echte Action)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let userId: string;
  let homeRegionId: string;
  let residencyRegionId: string;
  let ortsteilId: string;

  let wohnortAnzeigeZuruecksetzen: typeof import("@/lib/region/actions").wohnortAnzeigeZuruecksetzen;

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

    const [t] = await db.insert(tenants).values({ slug: nextSlug("wa"), name: "Wohnort-Action" }).returning();
    tenantId = t.id;
    mockTenantRow = { id: t.id, slug: t.slug, name: t.name };

    // Minimal-Baum: Bund → Land. path pflegt der Trigger.
    const [bund] = await db
      .insert(regions)
      .values({ parentId: null, typ: "bund", name: "Deutschland", pathLabel: "de" })
      .returning();
    const [land] = await db
      .insert(regions)
      .values({ parentId: bund.id, typ: "land", name: "Testland", pathLabel: "testland" })
      .returning();
    homeRegionId = bund.id;
    residencyRegionId = land.id;

    const [ot] = await db
      .insert(ortsteile)
      .values({ tenantId, code: "testort", name: "Testort" })
      .returning();
    ortsteilId = ot.id;

    const [u] = await db
      .insert(users)
      .values({
        tenantId,
        email: `me-${Date.now()}@wa.de`,
        minAgeConfirmedAt: new Date(),
        homeRegionId,
        residencyRegionId,
        ortsteilId,
      })
      .returning();
    userId = u.id;

    const mod = await import("@/lib/region/actions");
    wohnortAnzeigeZuruecksetzen = mod.wohnortAnzeigeZuruecksetzen;

    await loginAls(userId);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("nullt NUR home_region_id — residency_region_id + ortsteil_id UNVERÄNDERT", async () => {
    const res = await wohnortAnzeigeZuruecksetzen();
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    // home_region_id genullt.
    expect(row.homeRegionId).toBeNull();
    // BINDENDE INVARIANTE: verbindlicher Anker + Ortsteil bleiben unangetastet.
    expect(row.residencyRegionId).toBe(residencyRegionId);
    expect(row.ortsteilId).toBe(ortsteilId);

    // Cookie wurde gelöscht.
    expect(cookieDelete).toHaveBeenCalled();

    // PII-freies Audit.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "konto.wohnort_zurueckgesetzt"), eq(auditEvents.targetId, userId)));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    for (const a of audit) expect(JSON.stringify(a.metadata ?? {})).not.toContain("@");
  });

  it.skipIf(SKIP)("ohne Session → nicht authentifiziert (kein UPDATE)", async () => {
    // residency vorher merken.
    const [before] = await db.select().from(users).where(eq(users.id, userId));
    mockSessionToken = null;
    const res = await wohnortAnzeigeZuruecksetzen();
    expect(res.ok).toBe(false);
    const [after] = await db.select().from(users).where(eq(users.id, userId));
    expect(after.residencyRegionId).toBe(before.residencyRegionId);
    await loginAls(userId);
  });
});
