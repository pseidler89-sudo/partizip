/**
 * veroeffentlichen-core.test.ts — Integrationstests der extrahierten
 * veroeffentlichenCore (freigegeben → veroeffentlicht).
 *
 * Testet die ECHTE Kern-Funktion (kein Spiegel-Code), die Action UND CLI
 * gemeinsam nutzen:
 *   - atomarer CAS-Statusübergang + digest.published-Audit (H4)
 *   - Rollen-Gate (nur kommune_admin/super_admin)
 *   - approved_at-Konsistenz + N1-Content-Hash (Inhalt nach Freigabe geändert)
 *   - Demo-Side-Effect-Fence: KEIN Kanal-Aufruf, digest.channels_skipped-Audit
 *   - Nicht-Demo: Kanäle (gemockt) werden aufgerufen
 *   - Idempotenz: Doppel-Veröffentlichung scheitert am Status-Guard
 *
 * Kanäle sind gemockt (kein Netz). Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import type { Db } from "@/db/client";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { computeStatementsHash } from "../freigabe-core";

// --- Kanal-Senken als Spies (kein Netz, echte Tokens dürfen nie feuern) ------
const sendMastodonMock = vi.hoisted(() =>
  vi.fn(async () => ({ channel: "mastodon", sent: true as const, url: "https://m.example/1" })),
);
const sendBlueskyMock = vi.hoisted(() =>
  vi.fn(async () => ({ channel: "bluesky", sent: true as const })),
);
vi.mock("@/lib/channels/mastodon", () => ({ sendDigestToMastodon: sendMastodonMock }));
vi.mock("@/lib/channels/bluesky", () => ({ sendDigestToBluesky: sendBlueskyMock }));

// Nach den Mocks importieren.
import { veroeffentlichenCore } from "../veroeffentlichen-core";

const {
  tenants, users, roles, risBodies, risMeetings, risDocuments,
  digests, digestStatements, auditEvents,
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

describe("veroeffentlichenCore (Integration, echte Kern-Funktion)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let tenantSlug: string;
  let tenant2Id: string;
  let demoTenantId: string;
  let demoTenantSlug: string;
  let adminId: string;
  let redakteurId: string;
  let demoAdminId: string;
  let bodyId: string;
  let demoBodyId: string;

  const ADMIN_ROLLEN = ["kommune_admin"];
  let counter = 0;
  const nextId = () => `veroeff-${Date.now()}-${++counter}`;

  /** Freigegebener Digest mit N geprüften Aussagen + korrektem approved_content_hash. */
  async function createFreigegebenenDigest(
    tId: string,
    bId: string,
    approver: string,
    anzahl = 2,
  ) {
    const [meeting] = await db.insert(risMeetings).values({
      bodyId: bId,
      externalId: nextId(),
      gremium: "Testgremium",
      title: "Testsitzung",
      meetingDate: new Date("2026-06-01T15:00:00Z"),
      sourceUrl: `https://veroeff.example.de/meeting/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();
    const [doc] = await db.insert(risDocuments).values({
      meetingId: meeting.id,
      docType: "top",
      externalId: nextId(),
      title: "TOP 1",
      bodyText: "Testbeschluss",
      sourceUrl: `https://veroeff.example.de/doc/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();

    const now = new Date();
    const stmtsData = Array.from({ length: anzahl }, (_, i) => ({
      position: i + 1,
      text: `Aussage ${i + 1}: Testbeschluss.`,
      sourceUrl: `https://veroeff.example.de/doc/${i + 1}`,
    }));
    const hash = computeStatementsHash(stmtsData);

    const [digest] = await db.insert(digests).values({
      tenantId: tId,
      meetingId: meeting.id,
      title: `Veroeff-Digest-${nextId()}`,
      status: "freigegeben",
      generator: "extractive_v1",
      approvedBy: approver,
      approvedAt: now,
      approvedContentHash: hash,
    }).returning();

    for (const s of stmtsData) {
      await db.insert(digestStatements).values({
        digestId: digest.id,
        position: s.position,
        text: s.text,
        sourceDocumentId: doc.id,
        sourceUrl: s.sourceUrl,
        geprueftAt: now,
        geprueftBy: approver,
      });
    }
    return digest;
  }

  async function status(id: string) {
    const [row] = await db.select({ status: digests.status }).from(digests).where(eq(digests.id, id));
    return row.status;
  }
  async function auditsFor(action: string, id: string) {
    return db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, id)));
  }

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_, { schema }) as unknown as Db;
    await migrate(db, { migrationsFolder });

    const [t] = await db.insert(tenants).values({ slug: nextId(), name: "Veroeff-Tenant" }).returning();
    tenantId = t.id; tenantSlug = t.slug;
    const [t2] = await db.insert(tenants).values({ slug: nextId(), name: "Veroeff-Tenant-2" }).returning();
    tenant2Id = t2.id;
    const [dt] = await db.insert(tenants).values({ slug: nextId(), name: "Veroeff-Demo" }).returning();
    demoTenantId = dt.id; demoTenantSlug = dt.slug;
    // isDemoTenant liest die Env je Aufruf.
    process.env.DEMO_TENANT_SLUG = demoTenantSlug;

    const [admin] = await db.insert(users).values({ tenantId, email: `admin-${nextId()}@veroeff.de` }).returning();
    adminId = admin.id;
    const [red] = await db.insert(users).values({ tenantId, email: `red-${nextId()}@veroeff.de` }).returning();
    redakteurId = red.id;
    const [dAdmin] = await db.insert(users).values({ tenantId: demoTenantId, email: `admin-${nextId()}@demo.de` }).returning();
    demoAdminId = dAdmin.id;

    const region = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    const demoRegion = await resolveRegionIdForScope(db as never, demoTenantId, "stadt", null);
    await db.insert(roles).values([
      { tenantId, userId: adminId, roleType: "kommune_admin", regionId: region },
      { tenantId, userId: redakteurId, roleType: "redakteur", regionId: region },
      { tenantId: demoTenantId, userId: demoAdminId, roleType: "kommune_admin", regionId: demoRegion },
    ]);

    const [body] = await db.insert(risBodies).values({
      tenantId, key: nextId(), risType: "provox_iip", baseUrl: "https://veroeff.example.de",
    }).returning();
    bodyId = body.id;
    const [dBody] = await db.insert(risBodies).values({
      tenantId: demoTenantId, key: nextId(), risType: "provox_iip", baseUrl: "https://demo.example.de",
    }).returning();
    demoBodyId = dBody.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    delete process.env.DEMO_TENANT_SLUG;
    await sql_.end();
  });

  it.skipIf(SKIP)("Nicht-Demo: freigegeben → veroeffentlicht, Kanäle aufgerufen, digest.published-Audit", async () => {
    sendMastodonMock.mockClear(); sendBlueskyMock.mockClear();
    const digest = await createFreigegebenenDigest(tenantId, bodyId, redakteurId);

    const res = await veroeffentlichenCore(db, tenantId, {
      digestId: digest.id, callerUserId: adminId, callerRoleTypes: ADMIN_ROLLEN, tenantSlug,
    });

    expect(res.ok).toBe(true);
    expect(await status(digest.id)).toBe("veroeffentlicht");
    expect(sendMastodonMock).toHaveBeenCalledTimes(1);
    expect(sendBlueskyMock).toHaveBeenCalledTimes(1);
    const pub = await auditsFor("digest.published", digest.id);
    expect(pub.length).toBe(1);
    expect(pub[0].actorRef).toBe(adminId);
    expect((await auditsFor("digest.channels_skipped", digest.id)).length).toBe(0);
  });

  it.skipIf(SKIP)("Demo-Fence: KEIN Kanal-Aufruf, channels_skipped-Audit, Status trotzdem veröffentlicht", async () => {
    sendMastodonMock.mockClear(); sendBlueskyMock.mockClear();
    const digest = await createFreigegebenenDigest(demoTenantId, demoBodyId, demoAdminId);

    const res = await veroeffentlichenCore(db, demoTenantId, {
      digestId: digest.id, callerUserId: demoAdminId, callerRoleTypes: ADMIN_ROLLEN, tenantSlug: demoTenantSlug,
    });

    expect(res.ok).toBe(true);
    expect(await status(digest.id)).toBe("veroeffentlicht");
    expect(sendMastodonMock).not.toHaveBeenCalled();
    expect(sendBlueskyMock).not.toHaveBeenCalled();
    const skipped = await auditsFor("digest.channels_skipped", digest.id);
    expect(skipped.length).toBe(1);
    expect(skipped[0].metadata).toMatchObject({ grund: "demo_tenant" });
  });

  it.skipIf(SKIP)("Rollen-Gate: redakteur/[] können NICHT veröffentlichen, Status bleibt", async () => {
    const digest = await createFreigegebenenDigest(tenantId, bodyId, redakteurId);
    for (const rollen of [["redakteur"], ["beobachter"], []]) {
      const res = await veroeffentlichenCore(db, tenantId, {
        digestId: digest.id, callerUserId: adminId, callerRoleTypes: rollen, tenantSlug,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/kommune_admin\/super_admin/);
    }
    expect(await status(digest.id)).toBe("freigegeben");
  });

  it.skipIf(SKIP)("Falscher Ausgangsstatus (entwurf) → Fehler, kein Übergang", async () => {
    const digest = await createFreigegebenenDigest(tenantId, bodyId, redakteurId);
    await db.update(digests).set({ status: "entwurf" }).where(eq(digests.id, digest.id));
    const res = await veroeffentlichenCore(db, tenantId, {
      digestId: digest.id, callerUserId: adminId, callerRoleTypes: ADMIN_ROLLEN, tenantSlug,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nur aus Status 'freigegeben'/);
    expect(await status(digest.id)).toBe("entwurf");
  });

  it.skipIf(SKIP)("Cross-Tenant: fremder Tenant → nicht gefunden", async () => {
    const digest = await createFreigegebenenDigest(tenantId, bodyId, redakteurId);
    const res = await veroeffentlichenCore(db, tenant2Id, {
      digestId: digest.id, callerUserId: adminId, callerRoleTypes: ADMIN_ROLLEN, tenantSlug,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nicht gefunden");
  });

  // Hinweis: Der defensive „approved_at fehlt"-Zweig in veroeffentlichenCore ist
  // über die DB nicht konstruierbar — die CHECK-Constraint
  // digests_freigegeben_requires_approved_at verhindert Status 'freigegeben' ohne
  // approved_at bereits auf DB-Ebene (zweite Verteidigungslinie, Migration 0006).

  it.skipIf(SKIP)("N1: Inhalt nach Freigabe geändert (Hash-Mismatch) → Ablehnung", async () => {
    const digest = await createFreigegebenenDigest(tenantId, bodyId, redakteurId);
    // Aussagetext nach der Freigabe ändern → Hash passt nicht mehr.
    const [stmt] = await db.select({ id: digestStatements.id }).from(digestStatements)
      .where(eq(digestStatements.digestId, digest.id)).limit(1);
    await db.update(digestStatements).set({ text: "MANIPULIERT nach Freigabe" }).where(eq(digestStatements.id, stmt.id));
    const res = await veroeffentlichenCore(db, tenantId, {
      digestId: digest.id, callerUserId: adminId, callerRoleTypes: ADMIN_ROLLEN, tenantSlug,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Inhalt nach Freigabe geändert/);
    expect(await status(digest.id)).toBe("freigegeben");
  });

  it.skipIf(SKIP)("Idempotenz: Doppel-Veröffentlichung → zweiter Aufruf scheitert am Status-Guard, genau 1 published-Audit", async () => {
    sendMastodonMock.mockClear(); sendBlueskyMock.mockClear();
    const digest = await createFreigegebenenDigest(tenantId, bodyId, redakteurId);
    const first = await veroeffentlichenCore(db, tenantId, {
      digestId: digest.id, callerUserId: adminId, callerRoleTypes: ADMIN_ROLLEN, tenantSlug,
    });
    expect(first.ok).toBe(true);
    const second = await veroeffentlichenCore(db, tenantId, {
      digestId: digest.id, callerUserId: adminId, callerRoleTypes: ADMIN_ROLLEN, tenantSlug,
    });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/Ungültiger Statusübergang/);
    expect((await auditsFor("digest.published", digest.id)).length).toBe(1);
  });
});
