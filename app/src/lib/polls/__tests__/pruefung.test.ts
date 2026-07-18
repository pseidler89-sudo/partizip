/**
 * pruefung.test.ts — DB-Integrationstests für den KI-Neutralitäts-Check (Block L,
 * ADR-028). Muster: lifecycle.test.ts (echte Actions, gemockter Request-Kontext).
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt):
 *   - Flag AUS (Default): pollAktivieren entwurf→aktiv DIREKT + notify (Regression).
 *   - Flag AN: pollAktivieren entwurf→in_pruefung, KEIN notify; Bürger-Feed
 *     (getAktivePolls) zeigt die Poll NICHT (fail-closed).
 *   - Prüfung neutral: durch ANDEREN Admin → aktiv + notify + ki_pruefungen-Row;
 *     durch den Ersteller ohne ALLOW_SELF_APPROVAL → SoD-Ablehnung; mit → erlaubt.
 *   - Prüfung angehalten: → entwurf, Log-Row mit verletzteRegel, KEIN notify,
 *     erneut einreichbar; Verdict-Kette (mehrere Rows je Poll).
 *   - Transparenz-Query: PII-frei (kein geprueft_von), tenant-scoped, Felder korrekt.
 *   - Gebiets-Autorität: gebietsfremder Admin kann nicht freigeben.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

process.env.ANLIEGEN_REF_SALT ??= "test-pruefung-salt-aaaaaaaaaaaaaaaaaaaa";

import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";
import { PROMPT_VERSION, PROMPT_MODELL } from "@/lib/ki/neutralitaet-prompt";

const { tenants, users, roles, sessions, polls, kiPruefungen, auditEvents } = schema;

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
let mockTenantRow: {
  id: string;
  slug: string;
  name: string;
  primaryColor: null;
  logoUrl: null;
  welcomeText: null;
  isActive: true;
  kiNeutralitaetsPflicht: boolean;
} | null = null;
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

describe("polls/pruefung (Block L, Integration echte Actions)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let adminUserId: string; // Ersteller + Standard-Admin
  let admin2UserId: string; // zweiter Admin (SoD)

  let pollAktivieren: typeof import("@/lib/polls/actions").pollAktivieren;
  let pollPruefungAbschliessen: typeof import("@/lib/polls/actions").pollPruefungAbschliessen;
  let getAktivePolls: typeof import("@/lib/polls/queries").getAktivePolls;
  let getKiPruefungenPublic: typeof import("@/lib/ki/queries").getKiPruefungenPublic;

  let counter = 0;
  const nextSlug = (p: string) => `${p}-${Date.now()}-${++counter}`;

  const spyTransport = () => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      transport: { sendMail: async (opts: Record<string, unknown>) => { calls.push(opts); return {}; } },
    };
  };

  async function loginAls(userId: string) {
    const rawToken = `tok-${Date.now()}-${++counter}`;
    await db.insert(sessions).values({
      tenantId,
      userId,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    mockSessionToken = rawToken;
  }

  async function createPoll(opts: {
    status?: "entwurf" | "aktiv" | "geschlossen" | "in_pruefung";
    erstelltVon?: string | null;
    scopeLevel?: "stadt" | "ortsteil";
    scopeCode?: string | null;
  }) {
    const regionId = await resolveRegionIdForScope(
      db as never,
      tenantId,
      opts.scopeLevel ?? "stadt",
      opts.scopeCode ?? null,
    );
    const [p] = await db
      .insert(polls)
      .values({
        tenantId,
        regionId,
        frage: `Frage ${++counter}?`,
        typ: "ja_nein_enthaltung",
        status: opts.status ?? "entwurf",
        verbindlich: false,
        erstelltVon: opts.erstelltVon === undefined ? adminUserId : opts.erstelltVon,
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

    const [t] = await db.insert(tenants).values({ slug: nextSlug("pr"), name: "Pruefung-Test" }).returning();
    tenantId = t.id;
    mockTenantRow = {
      id: t.id, slug: t.slug, name: t.name,
      primaryColor: null, logoUrl: null, welcomeText: null, isActive: true,
      kiNeutralitaetsPflicht: false,
    };

    const stadtRegion = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);

    const [admin] = await db.insert(users).values({
      tenantId, email: `admin-${Date.now()}@pr.de`, minAgeConfirmedAt: new Date(), accountStatus: "active",
    }).returning();
    adminUserId = admin.id;
    await db.insert(roles).values({ tenantId, userId: adminUserId, roleType: "kommune_admin", regionId: stadtRegion });

    const [admin2] = await db.insert(users).values({
      tenantId, email: `admin2-${Date.now()}@pr.de`, minAgeConfirmedAt: new Date(), accountStatus: "active",
    }).returning();
    admin2UserId = admin2.id;
    await db.insert(roles).values({ tenantId, userId: admin2UserId, roleType: "kommune_admin", regionId: stadtRegion });

    const actions = await import("@/lib/polls/actions");
    pollAktivieren = actions.pollAktivieren;
    pollPruefungAbschliessen = actions.pollPruefungAbschliessen;
    const queries = await import("@/lib/polls/queries");
    getAktivePolls = queries.getAktivePolls;
    const kiQueries = await import("@/lib/ki/queries");
    getKiPruefungenPublic = kiQueries.getKiPruefungenPublic;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  beforeEach(async () => {
    if (SKIP) return;
    // Standard: Flag AUS, Admin1 eingeloggt, kein Self-Approval.
    mockTenantRow!.kiNeutralitaetsPflicht = false;
    delete process.env.ALLOW_SELF_APPROVAL;
    await loginAls(adminUserId);
  });

  // --- Flag AUS (Regression) -------------------------------------------------

  it.skipIf(SKIP)("Flag AUS: pollAktivieren führt entwurf→aktiv DIREKT + notify", async () => {
    mockTenantRow!.kiNeutralitaetsPflicht = false;
    const p = await createPoll({ status: "entwurf" });
    await db.insert(users).values({
      tenantId, email: `on-${Date.now()}@pr.de`, accountStatus: "active", notifyNewPolls: true,
    });

    const { calls, transport } = spyTransport();
    const res = await pollAktivieren(p.id, transport);
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const audit = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.activated"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);

    // KEINE Prüf-Zeile bei Flag AUS.
    const logs = await db.select().from(kiPruefungen).where(eq(kiPruefungen.pollId, p.id));
    expect(logs.length).toBe(0);
  });

  // --- Flag AN ---------------------------------------------------------------

  it.skipIf(SKIP)("Flag AN: pollAktivieren führt entwurf→in_pruefung, KEIN notify, Feed unsichtbar", async () => {
    mockTenantRow!.kiNeutralitaetsPflicht = true;
    const p = await createPoll({ status: "entwurf" });
    await db.insert(users).values({
      tenantId, email: `on2-${Date.now()}@pr.de`, accountStatus: "active", notifyNewPolls: true,
    });

    const { calls, transport } = spyTransport();
    const res = await pollAktivieren(p.id, transport);
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("in_pruefung");
    expect(row.opensAt).toBeNull(); // opens_at erst bei echter Aktivierung
    expect(calls.length).toBe(0); // KEINE Benachrichtigung

    const audit = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.submitted_for_review"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");

    // Bürger-Feed zeigt die in_pruefung-Poll NICHT (fail-closed).
    const feed = await getAktivePolls(db as never, tenantId);
    expect(feed.some((f) => f.id === p.id)).toBe(false);
  });

  // --- Prüfung neutral -------------------------------------------------------

  it.skipIf(SKIP)("neutral durch ANDEREN Admin → aktiv + notify + ki_pruefungen-Row (PII-frei im Audit)", async () => {
    const p = await createPoll({ status: "in_pruefung", erstelltVon: adminUserId });
    await db.insert(users).values({
      tenantId, email: `on3-${Date.now()}@pr.de`, accountStatus: "active", notifyNewPolls: true,
    });

    await loginAls(admin2UserId); // Prüfer ≠ Ersteller
    const { calls, transport } = spyTransport();
    const res = await pollPruefungAbschliessen(
      { pollId: p.id, verdict: "neutral", begruendung: "Sachlich und ausgewogen." },
      transport,
    );
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv");
    expect(row.opensAt).not.toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(1); // notify zieht hierher um

    const logs = await db.select().from(kiPruefungen).where(eq(kiPruefungen.pollId, p.id));
    expect(logs.length).toBe(1);
    expect(logs[0].verdict).toBe("neutral");
    expect(logs[0].promptVersion).toBe(PROMPT_VERSION);
    expect(logs[0].modell).toBe(PROMPT_MODELL);
    expect(logs[0].geprueftVon).toBe(admin2UserId);

    const audit = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.review_passed"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("neutral durch DENSELBEN (Ersteller) ohne ALLOW_SELF_APPROVAL → SoD-Ablehnung", async () => {
    const p = await createPoll({ status: "in_pruefung", erstelltVon: adminUserId });
    await loginAls(adminUserId); // Prüfer == Ersteller
    const res = await pollPruefungAbschliessen({ pollId: p.id, verdict: "neutral", begruendung: "Passt." });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Vier-Augen/);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("in_pruefung"); // unverändert
    const logs = await db.select().from(kiPruefungen).where(eq(kiPruefungen.pollId, p.id));
    expect(logs.length).toBe(0); // keine Log-Zeile bei SoD-Ablehnung
  });

  it.skipIf(SKIP)("neutral durch Ersteller MIT ALLOW_SELF_APPROVAL → erlaubt (selfApproval im Audit)", async () => {
    process.env.ALLOW_SELF_APPROVAL = "true";
    const p = await createPoll({ status: "in_pruefung", erstelltVon: adminUserId });
    await loginAls(adminUserId);
    const { transport } = spyTransport();
    const res = await pollPruefungAbschliessen(
      { pollId: p.id, verdict: "neutral", begruendung: "Selbstfreigabe Pilot." },
      transport,
    );
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv");

    const audit = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.review_passed"), eq(auditEvents.targetId, p.id)));
    expect((audit[0].metadata as { selfApproval?: boolean }).selfApproval).toBe(true);
  });

  // --- Prüfung angehalten ----------------------------------------------------

  it.skipIf(SKIP)("angehalten → entwurf, Log mit verletzteRegel, KEIN notify, erneut einreichbar; Verdict-Kette", async () => {
    const p = await createPoll({ status: "in_pruefung", erstelltVon: adminUserId });
    await loginAls(admin2UserId);
    const { calls, transport } = spyTransport();
    const res = await pollPruefungAbschliessen(
      { pollId: p.id, verdict: "angehalten", begruendung: "Suggestive Formulierung.", verletzteRegel: "Regel 1 (Suggestivität)" },
      transport,
    );
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(0); // KEIN notify beim Anhalten

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("entwurf"); // zurück an Ersteller, editierbar

    const logs = await db.select().from(kiPruefungen).where(eq(kiPruefungen.pollId, p.id));
    expect(logs.length).toBe(1);
    expect(logs[0].verdict).toBe("angehalten");
    expect(logs[0].verletzteRegel).toBe("Regel 1 (Suggestivität)");

    const audit = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.review_held"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(1);

    // Erneut einreichen (Flag AN) → in_pruefung; dann freigeben → zweite Log-Zeile (Kette).
    mockTenantRow!.kiNeutralitaetsPflicht = true;
    await loginAls(adminUserId);
    const wieder = await pollAktivieren(p.id);
    expect(wieder.ok).toBe(true);
    const [row2] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row2.status).toBe("in_pruefung");

    await loginAls(admin2UserId);
    const frei = await pollPruefungAbschliessen({ pollId: p.id, verdict: "neutral", begruendung: "Jetzt neutral." });
    expect(frei.ok).toBe(true);

    const kette = await db.select().from(kiPruefungen).where(eq(kiPruefungen.pollId, p.id));
    expect(kette.length).toBe(2); // Verdict-Kette: angehalten + neutral
  });

  it.skipIf(SKIP)("angehalten OHNE verletzteRegel → Fehler (verletzte Regel Pflicht)", async () => {
    const p = await createPoll({ status: "in_pruefung", erstelltVon: adminUserId });
    await loginAls(admin2UserId);
    const res = await pollPruefungAbschliessen({ pollId: p.id, verdict: "angehalten", begruendung: "Nicht neutral." });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/verletzte Regel/i);
  });

  // --- Transparenz-Query -----------------------------------------------------

  it.skipIf(SKIP)("getKiPruefungenPublic: PII-frei (kein geprueft_von), tenant-scoped, Felder korrekt", async () => {
    const p = await createPoll({ status: "in_pruefung", erstelltVon: adminUserId });
    await loginAls(admin2UserId);
    await pollPruefungAbschliessen({ pollId: p.id, verdict: "angehalten", begruendung: "Einseitige Rahmung.", verletzteRegel: "Regel 2" });

    const [pRow] = await db.select().from(polls).where(eq(polls.id, p.id));
    const list = await getKiPruefungenPublic(db as never, tenantId, 50);
    const eintrag = list.find((k) => k.frage === pRow.frage);
    expect(eintrag).toBeDefined();
    expect(eintrag!.verdict).toBe("angehalten");
    expect(eintrag!.verletzteRegel).toBe("Regel 2");
    expect(eintrag!.promptVersion).toBe(PROMPT_VERSION);
    // Öffentliche Sicht darf keine Person offenlegen.
    expect(Object.keys(eintrag!)).not.toContain("geprueftVon");
    expect(JSON.stringify(list)).not.toContain(adminUserId);
    expect(JSON.stringify(list)).not.toContain(admin2UserId);

    // Tenant-Isolation: fremder Tenant sieht nichts.
    const [tB] = await db.insert(tenants).values({ slug: nextSlug("prb"), name: "PR-B" }).returning();
    const fremd = await getKiPruefungenPublic(db as never, tB.id, 50);
    expect(fremd.length).toBe(0);
  });

  // --- Gebiets-Autorität -----------------------------------------------------

  it.skipIf(SKIP)("gebietsfremder Admin kann eine Poll außerhalb seines Gebiets nicht freigeben", async () => {
    // Admin, dessen Rolle NUR auf einen Ortsteil zeigt (abwärts) — deckt die
    // Stadt-Ebene (Elternknoten) NICHT ab.
    const otRegion = await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "OT-FREMD");
    const [otAdmin] = await db.insert(users).values({
      tenantId, email: `ota-${Date.now()}@pr.de`, minAgeConfirmedAt: new Date(), accountStatus: "active",
    }).returning();
    await db.insert(roles).values({ tenantId, userId: otAdmin.id, roleType: "kommune_admin", regionId: otRegion });

    // Poll auf Stadt-Ebene (nicht vom Ortsteil-Anker gedeckt).
    const p = await createPoll({ status: "in_pruefung", erstelltVon: adminUserId, scopeLevel: "stadt" });

    await loginAls(otAdmin.id);
    const res = await pollPruefungAbschliessen({ pollId: p.id, verdict: "neutral", begruendung: "Von fremd." });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Gebiet/);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("in_pruefung"); // unverändert
  });
});
