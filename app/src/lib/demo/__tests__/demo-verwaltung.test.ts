/**
 * demo-verwaltung.test.ts — DB-Integrationstests für demoVerwaltungStarten()
 * (Block I, ephemere Verwaltungs-Perspektive der Demo-Spielwiese).
 *
 * Muster demo-fence.test.ts/lifecycle.test.ts: echte Action, gemockt sind nur
 * next/headers (Host, x-forwarded-for, Cookie-Store mit set-Capture),
 * @/lib/tenant und @/db/client.
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt):
 *   - legt auf dem Demo-Mandanten ein @demo.invalid-Konto (Präfix
 *     demo-verwaltung-) MIT kommune_admin-Rolle an; isAdmin(...) wird true;
 *     NIE super_admin; Session-Cookie gesetzt; Audit PII-frei.
 *   - auf Nicht-Demo-Mandanten: Fehler OHNE User-Anlage.
 *   - Rate-Limit läuft im EIGENEN Scope demo_admin_session (3/15 min je IP),
 *     getrennt von demo_session.
 *   - Idempotenz: bestehende Admin-Session → ok ohne Neuanlage; bestehende
 *     BÜRGER-Session → neue Verwaltungs-Session ersetzt das Cookie.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, like } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { getUserRoleTypes, isAdmin } from "@/lib/auth/roles";

const { tenants, users, sessions, auditEvents, rateLimitEvents } = schema;

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

// --- Mocks für den Request-Kontext ------------------------------------------
const mockHost = "test.localhost";
let mockIp: string | null = "203.0.113.1";
let mockSessionToken: string | null = null;
let mockTenantRow: { id: string; slug: string; name: string } | null = null;
let mockDbForActions: DbType | null = null;
/** Vom Cookie-Store-Mock eingefangene set()-Aufrufe (Name + Roh-Token). */
let gesetzteCookies: Array<{ name: string; value: string }> = [];

vi.mock("next/headers", () => ({
  headers: () => ({
    get: (k: string) =>
      k === "host" ? mockHost : k === "x-forwarded-for" ? mockIp : null,
  }),
  cookies: () => ({
    get: (name: string) =>
      name === "partizip_session" && mockSessionToken
        ? { value: mockSessionToken }
        : undefined,
    set: (name: string, value: string) => {
      gesetzteCookies.push({ name, value });
    },
  }),
}));

vi.mock("@/lib/tenant", () => ({
  getTenantFromHost: async () => mockTenantRow,
}));

vi.mock("@/db/client", () => ({
  createDb: () => mockDbForActions,
}));

describe("demo/demoVerwaltungStarten (Integration, echte Action)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let demoTenant: { id: string; slug: string; name: string };
  let normalTenant: { id: string; slug: string; name: string };

  let demoVerwaltungStarten: typeof import("@/lib/demo/actions").demoVerwaltungStarten;
  let demoSessionStarten: typeof import("@/lib/demo/actions").demoSessionStarten;

  let counter = 0;
  const next = (p: string) => `${p}-${Date.now()}-${++counter}`;

  /** Anzahl Verwaltungs-Konten (demo-verwaltung-…@demo.invalid) im Tenant. */
  async function verwaltungsKonten(tenantId: string) {
    return db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), like(users.email, "demo-verwaltung-%@demo.invalid")));
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

    const [t1] = await db
      .insert(tenants)
      .values({ slug: next("dv-demo"), name: "DV-Demo" })
      .returning();
    demoTenant = { id: t1.id, slug: t1.slug, name: t1.name };
    const [t2] = await db
      .insert(tenants)
      .values({ slug: next("dv-normal"), name: "DV-Normal" })
      .returning();
    normalTenant = { id: t2.id, slug: t2.slug, name: t2.name };

    process.env.DEMO_TENANT_SLUG = demoTenant.slug;

    const actions = await import("@/lib/demo/actions");
    demoVerwaltungStarten = actions.demoVerwaltungStarten;
    demoSessionStarten = actions.demoSessionStarten;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    delete process.env.DEMO_TENANT_SLUG;
    await sql_.end();
  });

  it.skipIf(SKIP)("legt Verwaltungs-Konto + kommune_admin-Rolle an; Cookie + PII-freies Audit", async () => {
    mockTenantRow = demoTenant;
    mockSessionToken = null;
    mockIp = "203.0.113.10";
    gesetzteCookies = [];

    const res = await demoVerwaltungStarten();
    expect(res.ok).toBe(true);

    const konten = await verwaltungsKonten(demoTenant.id);
    expect(konten.length).toBe(1);
    // Token ist base64url (a–z, 0–9, '-', '_') — lowercased.
    expect(konten[0].email).toMatch(/^demo-verwaltung-[0-9a-z_-]+@demo\.invalid$/);

    // Rolle: kommune_admin — und NIEMALS super_admin.
    const roleTypes = await getUserRoleTypes(db as never, demoTenant.id, konten[0].id);
    expect(isAdmin(roleTypes)).toBe(true);
    expect(roleTypes).toContain("kommune_admin");
    expect(roleTypes).not.toContain("super_admin");

    // Session-Cookie wurde gesetzt und gehört zu einer echten Session-Zeile.
    expect(gesetzteCookies.length).toBe(1);
    expect(gesetzteCookies[0].name).toBe("partizip_session");
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, demoTenant.id), eq(sessions.userId, konten[0].id)));
    expect(sessionRows.length).toBe(1);

    // Audit PII-frei (actorRef = UUID, keine E-Mail in den Metadaten).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "demo.admin_session_created"), eq(auditEvents.tenantId, demoTenant.id)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(konten[0].id);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("Nicht-Demo-Mandant: Fehler OHNE User-Anlage (hartes Host-Gate)", async () => {
    mockTenantRow = normalTenant;
    mockSessionToken = null;
    mockIp = "203.0.113.20";

    const vorher = (
      await db.select().from(rateLimitEvents).where(eq(rateLimitEvents.scope, "demo_admin_session"))
    ).length;

    const res = await demoVerwaltungStarten();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Diese Funktion gibt es nur auf der Demo.");

    const konten = await verwaltungsKonten(normalTenant.id);
    expect(konten.length).toBe(0);
    // Auch kein Rate-Limit-Event: das Demo-Gate greift davor.
    const nachher = (
      await db.select().from(rateLimitEvents).where(eq(rateLimitEvents.scope, "demo_admin_session"))
    ).length;
    expect(nachher).toBe(vorher);
  });

  it.skipIf(SKIP)("Rate-Limit: eigener Scope demo_admin_session, 3/15 min je IP (4. Start blockiert)", async () => {
    mockTenantRow = demoTenant;
    mockIp = "203.0.113.30"; // eigene IP → unabhängig von anderen Tests

    for (let i = 0; i < 3; i++) {
      mockSessionToken = null; // jede Runde ein frischer Start (keine Idempotenz)
      const res = await demoVerwaltungStarten();
      expect(res.ok).toBe(true);
    }
    mockSessionToken = null;
    const vierter = await demoVerwaltungStarten();
    expect(vierter.ok).toBe(false);
    expect(vierter.error).toContain("Zu viele Demo-Starts");

    // Der Deckel lief im EIGENEN Scope — demo_session bleibt unberührt.
    const adminScope = await db
      .select()
      .from(rateLimitEvents)
      .where(eq(rateLimitEvents.scope, "demo_admin_session"));
    expect(adminScope.length).toBeGreaterThanOrEqual(4);
    const buergerScope = await db
      .select()
      .from(rateLimitEvents)
      .where(eq(rateLimitEvents.scope, "demo_session"));
    expect(buergerScope.length).toBe(0);
  });

  it.skipIf(SKIP)("Idempotenz: gültige Admin-Session → ok OHNE neues Konto", async () => {
    mockTenantRow = demoTenant;
    mockSessionToken = null;
    mockIp = "203.0.113.40";
    gesetzteCookies = [];

    const erster = await demoVerwaltungStarten();
    expect(erster.ok).toBe(true);
    const kontenVorher = await verwaltungsKonten(demoTenant.id);

    // Cookie der frischen Admin-Session „im Browser" → zweiter Aufruf ist No-Op.
    mockSessionToken = gesetzteCookies[gesetzteCookies.length - 1].value;
    gesetzteCookies = [];
    const zweiter = await demoVerwaltungStarten();
    expect(zweiter.ok).toBe(true);
    expect(gesetzteCookies.length).toBe(0); // kein neues Cookie

    const kontenNachher = await verwaltungsKonten(demoTenant.id);
    expect(kontenNachher.length).toBe(kontenVorher.length);
  });

  it.skipIf(SKIP)("Bürger-Demo-Session wird durch Verwaltungs-Session ERSETZT (neues Cookie)", async () => {
    mockTenantRow = demoTenant;
    mockSessionToken = null;
    mockIp = "203.0.113.50";
    gesetzteCookies = [];

    // Erst eine BÜRGER-Demo-Session (kein Admin) …
    const buerger = await demoSessionStarten();
    expect(buerger.ok).toBe(true);
    const buergerToken = gesetzteCookies[gesetzteCookies.length - 1].value;

    // … dann der Perspektiv-Wechsel: die Bürger-Session ist gültig, aber kein
    // Admin → NEUE Verwaltungs-Session, Cookie wird überschrieben.
    mockSessionToken = buergerToken;
    gesetzteCookies = [];
    const res = await demoVerwaltungStarten();
    expect(res.ok).toBe(true);
    expect(gesetzteCookies.length).toBe(1);
    expect(gesetzteCookies[0].value).not.toBe(buergerToken);

    // Das neue Cookie gehört zu einem Verwaltungs-Konto mit Admin-Rolle.
    const konten = await verwaltungsKonten(demoTenant.id);
    const neuestes = konten[konten.length - 1];
    const roleTypes = await getUserRoleTypes(db as never, demoTenant.id, neuestes.id);
    expect(isAdmin(roleTypes)).toBe(true);
  });
});
