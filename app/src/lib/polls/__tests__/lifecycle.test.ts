/**
 * lifecycle.test.ts — DB-Integrationstests für die ECHTEN Lebenszyklus-Actions
 * (pollSchliessen / pollEntwurfLoeschen) und die Admin-Lese-Query
 * (getAllPollsForAdmin). Muster: queries.test.ts.
 *
 * Die Actions lesen Tenant/Session/Rollen aus dem Request-Kontext. Damit wir die
 * ECHTEN Funktionen (nicht gespiegelte Logik) ausführen, mocken wir:
 *   - next/headers  → Host + Session-Cookie,
 *   - @/lib/tenant  → getTenantFromHost liefert den Test-Tenant,
 *   - @/db/client   → createDb liefert die Test-DB (drizzle über postgres-js).
 * Session + Admin-Rolle werden real in die Test-DB geschrieben, sodass die
 * action-internen DB-Lookups (sessions/users/roles) durchlaufen.
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt):
 *   - pollSchliessen: aktiv→geschlossen ok; aus entwurf/geschlossen → Fehler (Guard).
 *   - pollEntwurfLoeschen: entwurf ok; aktiv/geschlossen abgelehnt; mit Stimmen abgelehnt.
 *   - Audit poll.closed / poll.deleted PII-frei.
 *   - getAllPollsForAdmin: alle Status, Zähler korrekt, tenant-isoliert.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

process.env.ANLIEGEN_REF_SALT ??= "test-lifecycle-salt-aaaaaaaaaaaaaaaaaaaa";

import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";

const { tenants, users, roles, sessions, polls, votes, auditEvents } = schema;

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

// --- Mocks für den Request-Kontext der Actions -----------------------------
// Werden vor dem Import der Action-Datei (unten dynamisch) gesetzt.
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

describe("polls/lifecycle (Integration, echte Actions)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let otherTenantId: string;
  let adminUserId: string;

  // Dynamisch importierte echte Module (nach gesetzten Mocks).
  let pollSchliessen: typeof import("@/lib/polls/actions").pollSchliessen;
  let pollEntwurfLoeschen: typeof import("@/lib/polls/actions").pollEntwurfLoeschen;
  let pollAktivieren: typeof import("@/lib/polls/actions").pollAktivieren;
  let getAllPollsForAdmin: typeof import("@/lib/polls/queries").getAllPollsForAdmin;

  let counter = 0;
  const nextSlug = (p: string) => `${p}-${Date.now()}-${++counter}`;

  /** Schreibt eine gültige Session für adminUserId und setzt das Mock-Cookie. */
  async function loginAlsAdmin() {
    const rawToken = `tok-${Date.now()}-${++counter}`;
    await db.insert(sessions).values({
      tenantId,
      userId: adminUserId,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    mockSessionToken = rawToken;
  }

  async function createPoll(opts: {
    tenantId?: string;
    status?: "entwurf" | "aktiv" | "geschlossen";
    verbindlich?: boolean;
  }) {
    const tId = opts.tenantId ?? tenantId;
    const regionId = await resolveRegionIdForScope(db as never, tId, "stadt", null);
    const [p] = await db
      .insert(polls)
      .values({
        tenantId: tId,
        regionId,
        frage: `Frage ${++counter}?`,
        typ: "ja_nein_enthaltung",
        status: opts.status ?? "entwurf",
        verbindlich: opts.verbindlich ?? false,
      })
      .returning();
    return p;
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

    const [t] = await db
      .insert(tenants)
      .values({ slug: nextSlug("lc"), name: "Lifecycle-Test" })
      .returning();
    tenantId = t.id;
    mockTenantRow = { id: t.id, slug: t.slug, name: t.name };

    const [t2] = await db
      .insert(tenants)
      .values({ slug: nextSlug("lc-other"), name: "Lifecycle-Other" })
      .returning();
    otherTenantId = t2.id;

    const [admin] = await db
      .insert(users)
      .values({
        tenantId,
        email: `admin-${Date.now()}@lc.de`,
        minAgeConfirmedAt: new Date(),
      })
      .returning();
    adminUserId = admin.id;
    await db.insert(roles).values({
      tenantId,
      userId: adminUserId,
      roleType: "kommune_admin",
      regionId: await resolveRegionIdForScope(db as never, tenantId, "stadt", null),
    });

    // Echte Module erst NACH gesetzten Mocks importieren.
    const actions = await import("@/lib/polls/actions");
    pollSchliessen = actions.pollSchliessen;
    pollEntwurfLoeschen = actions.pollEntwurfLoeschen;
    pollAktivieren = actions.pollAktivieren;
    const queries = await import("@/lib/polls/queries");
    getAllPollsForAdmin = queries.getAllPollsForAdmin;

    await loginAlsAdmin();
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  // --- pollSchliessen -------------------------------------------------------

  it.skipIf(SKIP)("pollSchliessen: aktiv → geschlossen (ok), Audit poll.closed PII-frei", async () => {
    const p = await createPoll({ status: "aktiv" });
    const res = await pollSchliessen(p.id);
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("geschlossen");
    expect(row.closesAt).not.toBeNull(); // COALESCE(..., now())

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.closed"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("pollSchliessen: aus 'entwurf' → Fehler (Guard, kein Statuswechsel)", async () => {
    const p = await createPoll({ status: "entwurf" });
    const res = await pollSchliessen(p.id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nicht aktiv|nicht gefunden/);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("entwurf");
  });

  it.skipIf(SKIP)("pollSchliessen: bereits 'geschlossen' → Fehler (idempotent-sicher)", async () => {
    const p = await createPoll({ status: "geschlossen" });
    const res = await pollSchliessen(p.id);
    expect(res.ok).toBe(false);
  });

  it.skipIf(SKIP)("pollSchliessen: fremder Tenant → Fehler (tenant-isoliert)", async () => {
    const p = await createPoll({ tenantId: otherTenantId, status: "aktiv" });
    const res = await pollSchliessen(p.id);
    expect(res.ok).toBe(false);
    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv"); // unverändert
  });

  // --- pollAktivieren + Benachrichtigungs-Motor -----------------------------

  it.skipIf(SKIP)("pollAktivieren: entwurf → aktiv, benachrichtigt opted-in User, Audit poll.notifications PII-frei", async () => {
    const p = await createPoll({ status: "entwurf" });

    // Opted-in aktiver User im selben Tenant → Empfänger.
    await db.insert(users).values({
      tenantId,
      email: `notif-on-${Date.now()}@lc.de`,
      accountStatus: "active",
      notifyNewPolls: true,
    });

    const calls: Array<Record<string, unknown>> = [];
    const transport = { sendMail: async (opts: Record<string, unknown>) => { calls.push(opts); return {}; } };

    const res = await pollAktivieren(p.id, transport);
    expect(res.ok).toBe(true);

    // Status ist aktiv.
    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv");

    // Mindestens eine Mail gesendet (es können weitere opted-in User aus
    // vorherigen Tests existieren — daher >= 1, nicht == 1).
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Audit poll.notifications PII-frei (sent/errors-Zähler, keine Adresse).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.notifications"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);
    const meta = audit[0].metadata as { pollId: string; sent: number; errors: number };
    expect(meta.pollId).toBe(p.id);
    expect(typeof meta.sent).toBe("number");
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("pollAktivieren bleibt erfolgreich, wenn der Mail-Versand fehlschlägt (best-effort)", async () => {
    const p = await createPoll({ status: "entwurf" });
    await db.insert(users).values({
      tenantId,
      email: `notif-fail-${Date.now()}@lc.de`,
      accountStatus: "active",
      notifyNewPolls: true,
    });

    // Transport, der bei JEDEM Send wirft → notifyNewPoll zählt errors, kippt aber nichts.
    const transport = { sendMail: async () => { throw new Error("SMTP down"); } };

    const res = await pollAktivieren(p.id, transport);
    expect(res.ok).toBe(true); // Aktivierung NICHT gekoppelt an Mail-Erfolg.

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv");

    // Audit poll.notifications mit errors >= 1 (nicht poll.notify_error, da
    // notifyNewPoll selbst nicht wirft — es fängt je Mail ab).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.notifications"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);
    const meta = audit[0].metadata as { sent: number; errors: number };
    expect(meta.errors).toBeGreaterThanOrEqual(1);
  });

  // --- pollEntwurfLoeschen --------------------------------------------------

  it.skipIf(SKIP)("pollEntwurfLoeschen: entwurf → gelöscht (ok), Audit poll.deleted", async () => {
    const p = await createPoll({ status: "entwurf" });
    const res = await pollEntwurfLoeschen(p.id);
    expect(res.ok).toBe(true);

    const rows = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(rows.length).toBe(0);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.deleted"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("pollEntwurfLoeschen: aktive Umfrage wird NICHT gelöscht", async () => {
    const p = await createPoll({ status: "aktiv" });
    const res = await pollEntwurfLoeschen(p.id);
    expect(res.ok).toBe(false);
    const rows = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(rows.length).toBe(1); // bleibt erhalten
  });

  it.skipIf(SKIP)("pollEntwurfLoeschen: geschlossene Umfrage wird NICHT gelöscht", async () => {
    const p = await createPoll({ status: "geschlossen" });
    const res = await pollEntwurfLoeschen(p.id);
    expect(res.ok).toBe(false);
    const rows = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(rows.length).toBe(1);
  });

  it.skipIf(SKIP)("pollEntwurfLoeschen: Entwurf MIT Stimmen wird NICHT gelöscht (Sicherheitsnetz)", async () => {
    const p = await createPoll({ status: "entwurf" });
    await db.insert(votes).values({ pollId: p.id, tenantId, voterRef: "ref-x", choice: "ja", warVerifiziert: false });
    const res = await pollEntwurfLoeschen(p.id);
    expect(res.ok).toBe(false);
    const rows = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(rows.length).toBe(1);
  });

  it.skipIf(SKIP)("pollEntwurfLoeschen: fremder Tenant → kein Löschen", async () => {
    const p = await createPoll({ tenantId: otherTenantId, status: "entwurf" });
    const res = await pollEntwurfLoeschen(p.id);
    expect(res.ok).toBe(false);
    const rows = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(rows.length).toBe(1);
  });

  // --- Admin-Gate -----------------------------------------------------------

  it.skipIf(SKIP)("Actions sind admin-gated: Nicht-Admin (nur 'user') wird abgewiesen", async () => {
    const p = await createPoll({ status: "aktiv" });

    // Non-Admin-User + Session.
    const [plain] = await db
      .insert(users)
      .values({ tenantId, email: `plain-${Date.now()}@lc.de`, minAgeConfirmedAt: new Date() })
      .returning();
    await db.insert(roles).values({ tenantId, userId: plain.id, roleType: "user", regionId: await resolveRegionIdForScope(db as never, tenantId, "stadt", null) });
    const rawToken = `tok-plain-${Date.now()}`;
    await db.insert(sessions).values({
      tenantId,
      userId: plain.id,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    mockSessionToken = rawToken;

    const res = await pollSchliessen(p.id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Berechtigung/);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv"); // unverändert

    // Zurück auf Admin für Folge-Tests.
    await loginAlsAdmin();
  });

  // --- getAllPollsForAdmin --------------------------------------------------

  it.skipIf(SKIP)("getAllPollsForAdmin: liefert alle Status neu→alt, Zähler korrekt", async () => {
    // Eigener Tenant für saubere Isolation der Zähler.
    const [t] = await db.insert(tenants).values({ slug: nextSlug("ga"), name: "GA" }).returning();
    const rStadt = await resolveRegionIdForScope(db as never, t.id, "stadt", null);
    const rOt1 = await resolveRegionIdForScope(db as never, t.id, "ortsteil", "OT-1");

    const [pEntwurf] = await db
      .insert(polls)
      .values({ tenantId: t.id, regionId: rStadt, frage: "Entwurf?", typ: "ja_nein_enthaltung", status: "entwurf", createdAt: new Date(Date.now() - 30_000) })
      .returning();
    const [pAktiv] = await db
      .insert(polls)
      .values({ tenantId: t.id, regionId: rOt1, frage: "Aktiv?", typ: "ja_nein_enthaltung", status: "aktiv", verbindlich: true, createdAt: new Date(Date.now() - 20_000) })
      .returning();
    const [pZu] = await db
      .insert(polls)
      .values({ tenantId: t.id, regionId: rStadt, frage: "Zu?", typ: "ja_nein_enthaltung", status: "geschlossen", createdAt: new Date(Date.now() - 10_000) })
      .returning();

    // Stimmen: pAktiv 3 (2 verifiziert), pZu 1 (0 verifiziert), pEntwurf 0.
    await db.insert(votes).values([
      { pollId: pAktiv.id, tenantId: t.id, voterRef: "a1", choice: "ja", warVerifiziert: true },
      { pollId: pAktiv.id, tenantId: t.id, voterRef: "a2", choice: "nein", warVerifiziert: true },
      { pollId: pAktiv.id, tenantId: t.id, voterRef: "a3", choice: "ja", warVerifiziert: false },
      { pollId: pZu.id, tenantId: t.id, voterRef: "z1", choice: "ja", warVerifiziert: false },
    ]);

    const list = await getAllPollsForAdmin(db as never, t.id);
    expect(list.map((p) => p.id)).toEqual([pZu.id, pAktiv.id, pEntwurf.id]); // neu→alt

    const aktiv = list.find((p) => p.id === pAktiv.id)!;
    expect(aktiv.stimmenGesamt).toBe(3);
    expect(aktiv.stimmenVerifiziert).toBe(2);
    expect(aktiv.verbindlich).toBe(true);
    // ADR-024 contract: Ebene aus der Gebietsart; Ortsteil-Name aus dem Baum-Knoten
    // (regions_ltree_label("OT-1") → path_label "ot_1"; Name = übergebener Code).
    expect(aktiv.regionTyp).toBe("ortsteil");
    expect(aktiv.regionName).toBe("OT-1");

    const zu = list.find((p) => p.id === pZu.id)!;
    expect(zu.stimmenGesamt).toBe(1);
    expect(zu.stimmenVerifiziert).toBe(0);

    const entwurf = list.find((p) => p.id === pEntwurf.id)!;
    expect(entwurf.stimmenGesamt).toBe(0);
    expect(entwurf.stimmenVerifiziert).toBe(0);
  });

  it.skipIf(SKIP)("getAllPollsForAdmin: tenant-isoliert (fremde Polls/Stimmen unsichtbar)", async () => {
    const [tA] = await db.insert(tenants).values({ slug: nextSlug("ia"), name: "IA" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: nextSlug("ib"), name: "IB" }).returning();
    const [pB] = await db
      .insert(polls)
      .values({ tenantId: tB.id, regionId: await resolveRegionIdForScope(db as never, tB.id, "stadt", null), frage: "fremd?", typ: "ja_nein_enthaltung", status: "aktiv" })
      .returning();
    await db.insert(votes).values({ pollId: pB.id, tenantId: tB.id, voterRef: "b1", choice: "ja", warVerifiziert: true });

    const list = await getAllPollsForAdmin(db as never, tA.id);
    expect(list).toHaveLength(0);
  });
});
