/**
 * profil-actions.test.ts — DB-Integrationstest für die ECHTE Action
 * profilSpeichern (Rollenträger-Identität, Block J1). Muster: notify-actions.test.ts.
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt / DSGVO / Pseudonymität):
 *   - Rollenträger kann Klarname + Funktion setzen, ändern und leeren (self +
 *     tenant-scoped UPDATE),
 *   - zod-Grenzen (Name 2..80, Funktion ≤ 80) werden serverseitig erzwungen,
 *   - PII-freies Audit `profile.updated` (Feldnamen, NIE die Werte),
 *   - Bürger-Riegel: ein reines Bürgerkonto kann KEINEN Klarnamen setzen,
 *   - Tenant-/Self-Isolation: nur das eigene Konto wird verändert.
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
import { resolveRegionIdForScope } from "@/lib/region/scope";

const { tenants, users, roles, sessions, auditEvents } = schema;

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

describe("konto/profil-actions (Integration, echte Action)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let rollentraegerId: string;
  let buergerId: string;
  let fremdRollentraegerId: string;

  let profilSpeichern: typeof import("@/lib/konto/profil-actions").profilSpeichern;

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

    const [t] = await db.insert(tenants).values({ slug: nextSlug("pa"), name: "Profil-Action" }).returning();
    tenantId = t.id;
    mockTenantRow = { id: t.id, slug: t.slug, name: t.name };

    const regionId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);

    // Rollenträger (verifier) — darf einen öffentlichen Namen setzen.
    const [rt] = await db
      .insert(users)
      .values({ tenantId, email: `rt-${Date.now()}@pa.de`, minAgeConfirmedAt: new Date() })
      .returning();
    rollentraegerId = rt.id;
    await db.insert(roles).values({ tenantId, userId: rt.id, roleType: "verifier", regionId });

    // Reines Bürgerkonto (keine Rolle) — bleibt pseudonym.
    const [bg] = await db
      .insert(users)
      .values({ tenantId, email: `bg-${Date.now()}@pa.de`, minAgeConfirmedAt: new Date() })
      .returning();
    buergerId = bg.id;

    // Zweiter Rollenträger als Self-Isolations-Kontrolle.
    const [frt] = await db
      .insert(users)
      .values({ tenantId, email: `frt-${Date.now()}@pa.de`, displayName: "Fremd Name", funktion: "Fremd" })
      .returning();
    fremdRollentraegerId = frt.id;
    await db.insert(roles).values({ tenantId, userId: frt.id, roleType: "verifier", regionId });

    const mod = await import("@/lib/konto/profil-actions");
    profilSpeichern = mod.profilSpeichern;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("Rollenträger kann Klarname + Funktion setzen (self + tenant-scoped)", async () => {
    await loginAls(rollentraegerId);
    const res = await profilSpeichern({ displayName: "  Maria Musterfrau  ", funktion: "  Bürgermeisterin  " });
    expect(res.ok).toBe(true);
    // Serverseitig getrimmt.
    expect(res.displayName).toBe("Maria Musterfrau");
    expect(res.funktion).toBe("Bürgermeisterin");

    const [row] = await db.select().from(users).where(eq(users.id, rollentraegerId));
    expect(row.displayName).toBe("Maria Musterfrau");
    expect(row.funktion).toBe("Bürgermeisterin");

    // Fremder Rollenträger unverändert (Self-Isolation).
    const [fremd] = await db.select().from(users).where(eq(users.id, fremdRollentraegerId));
    expect(fremd.displayName).toBe("Fremd Name");
  });

  it.skipIf(SKIP)("schreibt PII-freies Audit profile.updated (nur Feldnamen, nie die Werte)", async () => {
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "profile.updated"), eq(auditEvents.targetId, rollentraegerId)));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    for (const a of audit) {
      const meta = JSON.stringify(a.metadata);
      expect(meta).toContain("display_name");
      // Der KLARNAME selbst darf NIE im Audit stehen.
      expect(meta).not.toContain("Maria");
      expect(meta).not.toContain("Musterfrau");
      expect(meta).not.toContain("Bürgermeisterin");
    }
  });

  it.skipIf(SKIP)("kann den Klarnamen wieder leeren (Leerstring → NULL)", async () => {
    await loginAls(rollentraegerId);
    const res = await profilSpeichern({ displayName: "", funktion: "" });
    expect(res.ok).toBe(true);
    expect(res.displayName).toBeNull();
    expect(res.funktion).toBeNull();

    const [row] = await db.select().from(users).where(eq(users.id, rollentraegerId));
    expect(row.displayName).toBeNull();
    expect(row.funktion).toBeNull();
  });

  it.skipIf(SKIP)("erzwingt die Namens-Mindestlänge (2 Zeichen)", async () => {
    await loginAls(rollentraegerId);
    const res = await profilSpeichern({ displayName: "A", funktion: "" });
    expect(res.ok).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, rollentraegerId));
    expect(row.displayName).toBeNull(); // unverändert
  });

  it.skipIf(SKIP)("erzwingt die Namens-Maximallänge (80 Zeichen)", async () => {
    await loginAls(rollentraegerId);
    const res = await profilSpeichern({ displayName: "x".repeat(81), funktion: "" });
    expect(res.ok).toBe(false);
  });

  it.skipIf(SKIP)("erzwingt die Funktions-Maximallänge (80 Zeichen)", async () => {
    await loginAls(rollentraegerId);
    const res = await profilSpeichern({ displayName: "Maria M", funktion: "y".repeat(81) });
    expect(res.ok).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, rollentraegerId));
    // Nichts wurde geschrieben (Validierung vor dem UPDATE).
    expect(row.displayName).toBeNull();
  });

  it.skipIf(SKIP)("Bürger-Riegel: reines Bürgerkonto kann KEINEN Klarnamen setzen", async () => {
    await loginAls(buergerId);
    const res = await profilSpeichern({ displayName: "Heimlich Bürger", funktion: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Rollenträger|pseudonym/i);

    const [row] = await db.select().from(users).where(eq(users.id, buergerId));
    expect(row.displayName).toBeNull();
  });

  it.skipIf(SKIP)("ohne Session → nicht authentifiziert (kein UPDATE)", async () => {
    mockSessionToken = null;
    const res = await profilSpeichern({ displayName: "Wer Auch Immer", funktion: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/authentifiziert/i);
  });
});
