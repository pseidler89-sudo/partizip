/**
 * demo-fence.test.ts — DB-Integrationstests der Side-Effect-Fences (Block I).
 *
 * HARTE Bedingung des Demo-Verwaltungs-Tracks: der Demo-Mandant darf NIE echte
 * Außenwirkung haben — die echten MASTODON_/BLUESKY_-Tokens und der echte
 * SMTP-Server leben im selben Prozess. Getestet werden die ECHTEN Actions
 * (Muster lifecycle.test.ts: next/headers + @/lib/tenant + @/db/client gemockt,
 * Session/Rollen real in der Test-DB), zusätzlich gemockt:
 *   - @/lib/channels/{mastodon,bluesky} → Spies (kein Netz),
 *   - @/lib/polls/notify              → Spy (kein Mail-Motor),
 *   - @/lib/auth/mail                 → Spy (keine Einladungs-Mail).
 *
 * Geprüfte Eigenschaften:
 *   - digest veroeffentlichen: auf Demo KEIN Kanal-Aufruf + Audit
 *     digest.channels_skipped; auf Nicht-Demo Kanäle wie bisher.
 *   - pollAktivieren: auf Demo KEIN notifyNewPoll; auf Nicht-Demo schon.
 *   - einladen/einladungErneutSenden: auf Demo Fehler VOR jedem Mail-/Token-
 *     Pfad; auf Nicht-Demo funktioniert einladen weiter.
 *   - Seed-Schutz: kuratierte Seed-Poll/-Digest-IDs sind unveränderbar.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

process.env.ANLIEGEN_REF_SALT ??= "test-demo-fence-salt-aaaaaaaaaaaaaaaa";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { musterstadtSeedId } from "@/lib/demo/seed-ids";

const {
  tenants, users, roles, sessions, polls, invitations,
  risBodies, risMeetings, risDocuments, digests, digestStatements, auditEvents,
} = schema;

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

// --- Mocks für den Request-Kontext + die Außenwirkungs-Senken ---------------
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

// Außenwirkungs-Senken als Spies — die Fences müssen verhindern, dass sie auf
// dem Demo-Mandanten überhaupt aufgerufen werden.
const sendMastodonMock = vi.hoisted(() =>
  vi.fn(async () => ({ channel: "mastodon", sent: true as const, url: "https://m.example/1" })),
);
const sendBlueskyMock = vi.hoisted(() =>
  vi.fn(async () => ({ channel: "bluesky", sent: true as const })),
);
const notifyNewPollMock = vi.hoisted(() => vi.fn(async () => ({ sent: 1, errors: 0 })));
const sendInvitationEmailMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/channels/mastodon", () => ({ sendDigestToMastodon: sendMastodonMock }));
vi.mock("@/lib/channels/bluesky", () => ({ sendDigestToBluesky: sendBlueskyMock }));
vi.mock("@/lib/polls/notify", () => ({ notifyNewPoll: notifyNewPollMock }));
vi.mock("@/lib/auth/mail", () => ({ sendInvitationEmail: sendInvitationEmailMock }));

describe("demo/side-effect-fence (Integration, echte Actions)", () => {
  let sql_: postgres.Sql;
  let db: DbType;

  // Demo-Mandant (DEMO_TENANT_SLUG zeigt auf ihn) + normaler Kontroll-Mandant.
  let demoTenant: { id: string; slug: string; name: string };
  let normalTenant: { id: string; slug: string; name: string };
  const adminByTenant = new Map<string, string>();

  let counter = 0;
  const next = (p: string) => `${p}-${Date.now()}-${++counter}`;

  // Dynamisch importierte echte Module (nach gesetzten Mocks).
  let pollAktivieren: typeof import("@/lib/polls/actions").pollAktivieren;
  let pollSchliessen: typeof import("@/lib/polls/actions").pollSchliessen;
  let pollEntwurfLoeschen: typeof import("@/lib/polls/actions").pollEntwurfLoeschen;
  let veroeffentlichen: typeof import("@/lib/digest/actions").veroeffentlichen;
  let freigeben: typeof import("@/lib/digest/actions").freigeben;
  let einladen: typeof import("@/lib/admin/invitation-actions").einladen;

  /** Dummy-Transport für pollAktivieren (Default-Transport braucht SMTP-env). */
  const dummyTransport = { sendMail: async () => ({}) };

  /** Setzt Tenant-Mock + gültige Admin-Session für diesen Tenant. */
  async function loginAlsAdmin(tenant: { id: string; slug: string; name: string }) {
    mockTenantRow = tenant;
    const adminId = adminByTenant.get(tenant.id)!;
    const rawToken = `tok-${Date.now()}-${++counter}`;
    await db.insert(sessions).values({
      tenantId: tenant.id,
      userId: adminId,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    mockSessionToken = rawToken;
  }

  async function createTenantMitAdmin(slugPrefix: string) {
    const [t] = await db
      .insert(tenants)
      .values({ slug: next(slugPrefix), name: `Fence-${slugPrefix}` })
      .returning();
    const [admin] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `admin-${Date.now()}-${++counter}@fence.de`, minAgeConfirmedAt: new Date() })
      .returning();
    await db.insert(roles).values({
      tenantId: t.id,
      userId: admin.id,
      roleType: "kommune_admin",
      regionId: await resolveRegionIdForScope(db as never, t.id, "stadt", null),
    });
    adminByTenant.set(t.id, admin.id);
    return { id: t.id, slug: t.slug, name: t.name };
  }

  async function createPoll(tenantId: string, status: "entwurf" | "aktiv", id?: string) {
    const regionId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    const [p] = await db
      .insert(polls)
      .values({
        ...(id ? { id } : {}),
        tenantId,
        regionId,
        frage: `Fence-Frage ${++counter}?`,
        typ: "ja_nein_enthaltung",
        status,
      })
      .returning();
    return p;
  }

  /** Freigegebener Digest mit 1 geprüfter Aussage — bereit zum Veröffentlichen. */
  async function createFreigegebenenDigest(tenant: { id: string; slug: string }) {
    const [body] = await db
      .insert(risBodies)
      .values({ tenantId: tenant.id, key: next("fence-body"), risType: "demo", baseUrl: "https://example.invalid", isActive: false })
      .returning();
    const [meeting] = await db
      .insert(risMeetings)
      .values({
        bodyId: body.id,
        externalId: next("fence-meeting"),
        gremium: "Testgremium",
        title: "Fence-Sitzung",
        meetingDate: new Date(),
        sourceUrl: "https://example.invalid/meeting",
        fetchedAt: new Date(),
      })
      .returning();
    const [doc] = await db
      .insert(risDocuments)
      .values({
        meetingId: meeting.id,
        docType: "vorlage",
        externalId: next("fence-doc"),
        title: "Fence-Dokument",
        bodyText: "Text",
        sourceUrl: "https://example.invalid/doc",
        fetchedAt: new Date(),
      })
      .returning();
    const now = new Date();
    const [digest] = await db
      .insert(digests)
      .values({
        tenantId: tenant.id,
        meetingId: meeting.id,
        title: `Fence-Digest ${++counter}`,
        status: "freigegeben",
        generator: "extractive_v1",
        approvedBy: adminByTenant.get(tenant.id)!,
        approvedAt: now,
      })
      .returning();
    await db.insert(digestStatements).values({
      digestId: digest.id,
      position: 1,
      text: "Fence-Aussage.",
      sourceDocumentId: doc.id,
      sourceUrl: "https://example.invalid/doc",
      geprueftAt: now,
    });
    return digest;
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

    demoTenant = await createTenantMitAdmin("fence-demo");
    normalTenant = await createTenantMitAdmin("fence-normal");
    // isDemoTenant liest die env bei jedem Aufruf — auf den Test-Demo-Tenant zeigen.
    process.env.DEMO_TENANT_SLUG = demoTenant.slug;

    // Echte Module erst NACH gesetzten Mocks importieren.
    const pollActions = await import("@/lib/polls/actions");
    pollAktivieren = pollActions.pollAktivieren;
    pollSchliessen = pollActions.pollSchliessen;
    pollEntwurfLoeschen = pollActions.pollEntwurfLoeschen;
    const digestActions = await import("@/lib/digest/actions");
    veroeffentlichen = digestActions.veroeffentlichen;
    freigeben = digestActions.freigeben;
    const invitationActions = await import("@/lib/admin/invitation-actions");
    einladen = invitationActions.einladen;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    delete process.env.DEMO_TENANT_SLUG;
    await sql_.end();
  });

  // --- (a) Digest-Kanäle ------------------------------------------------------

  it.skipIf(SKIP)("veroeffentlichen auf Demo: Kanäle NICHT aufgerufen, Audit digest.channels_skipped, Status trotzdem veröffentlicht", async () => {
    await loginAlsAdmin(demoTenant);
    const digest = await createFreigegebenenDigest(demoTenant);

    sendMastodonMock.mockClear();
    sendBlueskyMock.mockClear();

    const res = await veroeffentlichen(digest.id);
    expect(res.ok).toBe(true);

    // FENCE: kein einziger Kanal-Aufruf (echte Tokens im Prozess!).
    expect(sendMastodonMock).not.toHaveBeenCalled();
    expect(sendBlueskyMock).not.toHaveBeenCalled();

    // Die Veröffentlichung selbst (eigene Seite) bleibt erlaubt.
    const [row] = await db.select().from(digests).where(eq(digests.id, digest.id));
    expect(row.status).toBe("veroeffentlicht");

    // Audit macht das Überspringen nachvollziehbar.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "digest.channels_skipped"), eq(auditEvents.targetId, digest.id)));
    expect(audit.length).toBe(1);
    expect(audit[0].metadata).toMatchObject({ grund: "demo_tenant" });
  });

  it.skipIf(SKIP)("veroeffentlichen auf Nicht-Demo: Kanäle werden wie bisher aufgerufen", async () => {
    await loginAlsAdmin(normalTenant);
    const digest = await createFreigegebenenDigest(normalTenant);

    sendMastodonMock.mockClear();
    sendBlueskyMock.mockClear();

    const res = await veroeffentlichen(digest.id);
    expect(res.ok).toBe(true);
    expect(sendMastodonMock).toHaveBeenCalledTimes(1);
    expect(sendBlueskyMock).toHaveBeenCalledTimes(1);

    // Kein Demo-Skip-Audit auf dem normalen Mandanten.
    const skipped = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "digest.channels_skipped"), eq(auditEvents.targetId, digest.id)));
    expect(skipped.length).toBe(0);
  });

  // --- (b) pollAktivieren / notifyNewPoll -------------------------------------

  it.skipIf(SKIP)("pollAktivieren auf Demo: aktiviert, aber notifyNewPoll wird NICHT aufgerufen", async () => {
    await loginAlsAdmin(demoTenant);
    const p = await createPoll(demoTenant.id, "entwurf");

    notifyNewPollMock.mockClear();
    const res = await pollAktivieren(p.id, dummyTransport);
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("aktiv");
    expect(notifyNewPollMock).not.toHaveBeenCalled();

    // Auch kein Benachrichtigungs-Audit (der Motor lief nie an).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.notifications"), eq(auditEvents.targetId, p.id)));
    expect(audit.length).toBe(0);
  });

  it.skipIf(SKIP)("pollAktivieren auf Nicht-Demo: notifyNewPoll wird aufgerufen", async () => {
    await loginAlsAdmin(normalTenant);
    const p = await createPoll(normalTenant.id, "entwurf");

    notifyNewPollMock.mockClear();
    const res = await pollAktivieren(p.id, dummyTransport);
    expect(res.ok).toBe(true);
    expect(notifyNewPollMock).toHaveBeenCalledTimes(1);
  });

  // --- (c) Einladungen ----------------------------------------------------------

  it.skipIf(SKIP)("einladen auf Demo: Fehler VOR Mail/Token — keine Mail, keine invitations-Zeile", async () => {
    await loginAlsAdmin(demoTenant);
    sendInvitationEmailMock.mockClear();

    const res = await einladen({ email: "person@example.org", roleType: "redakteur" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Im Demo-Mandanten werden keine Einladungen versendet.");
    expect(sendInvitationEmailMock).not.toHaveBeenCalled();

    const rows = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(eq(invitations.tenantId, demoTenant.id));
    expect(rows.length).toBe(0);
  });

  it.skipIf(SKIP)("einladen auf Nicht-Demo: funktioniert weiter (Mail versendet)", async () => {
    await loginAlsAdmin(normalTenant);
    sendInvitationEmailMock.mockClear();

    const res = await einladen({ email: "neu@example.org", roleType: "redakteur" });
    expect(res.ok).toBe(true);
    expect(sendInvitationEmailMock).toHaveBeenCalledTimes(1);
  });

  // --- (d) Seed-Schutz ----------------------------------------------------------

  it.skipIf(SKIP)("pollSchliessen: Seed-Poll auf Demo → freundlicher Fehler, bleibt aktiv", async () => {
    await loginAlsAdmin(demoTenant);
    // Kuratierte Seed-Frage (deterministische ID wie seed-musterstadt.ts) real anlegen.
    const seedId = musterstadtSeedId(demoTenant.slug, "poll:offen");
    await createPoll(demoTenant.id, "aktiv", seedId);

    const res = await pollSchliessen(seedId);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Diese Beispiel-Frage gehört zum Demo-Rundgang und bleibt unverändert.");

    const [row] = await db.select().from(polls).where(eq(polls.id, seedId));
    expect(row.status).toBe("aktiv"); // Bürgersicht des Rundgangs intakt
  });

  it.skipIf(SKIP)("pollSchliessen: Nicht-Seed-Poll auf Demo → funktioniert (Hands-on-Track)", async () => {
    await loginAlsAdmin(demoTenant);
    const p = await createPoll(demoTenant.id, "aktiv");

    const res = await pollSchliessen(p.id);
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(polls).where(eq(polls.id, p.id));
    expect(row.status).toBe("geschlossen");
  });

  it.skipIf(SKIP)("pollAktivieren/pollEntwurfLoeschen: Seed-Poll-IDs auf Demo abgelehnt", async () => {
    await loginAlsAdmin(demoTenant);
    const verbindlichSeedId = musterstadtSeedId(demoTenant.slug, "poll:verbindlich");
    // Guard greift VOR jedem DB-Zugriff — die Zeile muss nicht existieren.
    const aktivRes = await pollAktivieren(verbindlichSeedId, dummyTransport);
    expect(aktivRes.ok).toBe(false);
    expect(aktivRes.error).toContain("Demo-Rundgang");

    const loeschRes = await pollEntwurfLoeschen(musterstadtSeedId(demoTenant.slug, "poll:geschlossen"));
    expect(loeschRes.ok).toBe(false);
    expect(loeschRes.error).toContain("Demo-Rundgang");
  });

  it.skipIf(SKIP)("Seed-Schutz ist demo-gebunden: dieselbe ID auf Nicht-Demo bleibt normal nutzbar", async () => {
    await loginAlsAdmin(normalTenant);
    // Gleicher Key, aber Slug des NORMALEN Tenants ⇒ keine Seed-ID des Demo-Mandanten.
    const p = await createPoll(normalTenant.id, "aktiv", musterstadtSeedId(normalTenant.slug, "poll:offen"));
    const res = await pollSchliessen(p.id);
    expect(res.ok).toBe(true);
  });

  it.skipIf(SKIP)("freigeben/veroeffentlichen: Seed-Digest-ID auf Demo abgelehnt (defensiv)", async () => {
    await loginAlsAdmin(demoTenant);
    const seedDigestId = musterstadtSeedId(demoTenant.slug, "digest");

    const f = await freigeben(seedDigestId);
    expect(f.ok).toBe(false);
    expect(f.error).toContain("Demo-Rundgang");

    const v = await veroeffentlichen(seedDigestId);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("Demo-Rundgang");
  });
});
