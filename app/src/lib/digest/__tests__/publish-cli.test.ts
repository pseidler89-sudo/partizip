/**
 * publish-cli.test.ts — Integrationstests der Betreiber-CLI-Kernlogik
 * digestPublishCli (scripts/digest-publish.ts delegiert hierher).
 *
 * Getestet gegen ephemeres PG (Kanäle gemockt):
 *   - Voll-Flow entwurf → veroeffentlicht (Titel, Prüfstempel, Freigabe, Publish,
 *     digest.cli_publish-Audit, Schritt-Spur)
 *   - m7-Invariante: bestehende Prüf-Spuren werden NIE überschrieben
 *   - --nur-freigeben lässt die Veröffentlichung aus (Status freigegeben)
 *   - SoD: allowSelfApproval=false ⇒ Freigabe-Fehler 1:1 durchgereicht, kein
 *     cli_publish-Audit, Status bleibt entwurf
 *   - Idempotenz: bereits veröffentlicht ⇒ ok + bereitsVeroeffentlicht
 *   - Fail-fast: unbekannter Tenant/Digest/Actor, Actor nicht aktiver Admin,
 *     Titel zu lang, --titel nur im Entwurf
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
import type { Db } from "@/db/client";
import { resolveRegionIdForScope } from "@/lib/region/scope";

// Kanäle gemockt (kein Netz) — die CLI publiziert real über veroeffentlichenCore.
const sendMastodonMock = vi.hoisted(() =>
  vi.fn(async () => ({ channel: "mastodon", sent: true as const, url: "https://m.example/1" })),
);
const sendBlueskyMock = vi.hoisted(() =>
  vi.fn(async () => ({ channel: "bluesky", sent: true as const })),
);
vi.mock("@/lib/channels/mastodon", () => ({ sendDigestToMastodon: sendMastodonMock }));
vi.mock("@/lib/channels/bluesky", () => ({ sendDigestToBluesky: sendBlueskyMock }));

import { digestPublishCli } from "../publish-cli-core";
import { MAX_TITLE_CHARS } from "../validate-draft";

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

describe("digestPublishCli (Integration, echte CLI-Kernlogik)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantSlug: string;
  let tenantId: string;
  let adminEmail: string;
  let adminId: string;
  let redakteurId: string;
  let redakteurEmail: string;
  let userEmail: string; // aktives, aber NICHT-Admin-Konto
  let bodyId: string;

  let counter = 0;
  const nextId = () => `cli-${Date.now()}-${++counter}`;

  /** Entwurf-Digest mit N Aussagen; optional die erste bereits von `vorgeprueft` geprüft. */
  async function createEntwurfDigest(anzahl = 2, vorgeprueft?: string) {
    const [meeting] = await db.insert(risMeetings).values({
      bodyId,
      externalId: nextId(),
      gremium: "Testgremium",
      title: "Testsitzung",
      meetingDate: new Date("2026-06-01T15:00:00Z"),
      sourceUrl: `https://cli.example.de/meeting/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();
    const [doc] = await db.insert(risDocuments).values({
      meetingId: meeting.id,
      docType: "top",
      externalId: nextId(),
      title: "TOP 1",
      bodyText: "Testbeschluss",
      sourceUrl: `https://cli.example.de/doc/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();
    const [digest] = await db.insert(digests).values({
      tenantId, meetingId: meeting.id, title: `CLI-Digest-${nextId()}`,
      status: "entwurf", generator: "extractive_v1",
    }).returning();
    for (let i = 1; i <= anzahl; i++) {
      await db.insert(digestStatements).values({
        digestId: digest.id, position: i, text: `Aussage ${i}.`,
        sourceDocumentId: doc.id, sourceUrl: `https://cli.example.de/doc/${i}`,
        ...(i === 1 && vorgeprueft ? { geprueftAt: new Date(), geprueftBy: vorgeprueft } : {}),
      });
    }
    return digest;
  }

  const call = (over: Partial<Parameters<typeof digestPublishCli>[1]> & { digestId: string }) =>
    digestPublishCli(db, {
      tenantSlug, actorEmail: adminEmail, allowSelfApproval: true, ...over,
    });

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

    const [t] = await db.insert(tenants).values({ slug: nextId(), name: "CLI-Tenant" }).returning();
    tenantId = t.id; tenantSlug = t.slug;

    adminEmail = `admin-${nextId()}@cli.de`;
    redakteurEmail = `red-${nextId()}@cli.de`;
    userEmail = `user-${nextId()}@cli.de`;
    const [admin] = await db.insert(users).values({ tenantId, email: adminEmail }).returning();
    adminId = admin.id;
    const [red] = await db.insert(users).values({ tenantId, email: redakteurEmail }).returning();
    redakteurId = red.id;
    await db.insert(users).values({ tenantId, email: userEmail }); // keine Rolle

    const region = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    await db.insert(roles).values([
      { tenantId, userId: adminId, roleType: "kommune_admin", regionId: region },
      { tenantId, userId: redakteurId, roleType: "redakteur", regionId: region },
    ]);
    const [body] = await db.insert(risBodies).values({
      tenantId, key: nextId(), risType: "provox_iip", baseUrl: "https://cli.example.de",
    }).returning();
    bodyId = body.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("Voll-Flow entwurf → veroeffentlicht (Titel, Prüfung, Freigabe, Publish, cli_publish-Audit)", async () => {
    sendMastodonMock.mockClear(); sendBlueskyMock.mockClear();
    const digest = await createEntwurfDigest(2);

    const res = await call({ digestId: digest.id, neuerTitel: "Korrigierter Titel" });

    expect(res.ok).toBe(true);
    expect(res.schritte).toEqual(["titel_korrigiert", "statements_geprueft:2", "freigegeben", "veroeffentlicht"]);
    expect(await status(digest.id)).toBe("veroeffentlicht");

    const [row] = await db.select({ title: digests.title }).from(digests).where(eq(digests.id, digest.id));
    expect(row.title).toBe("Korrigierter Titel");

    // Alle Aussagen jetzt vom Actor geprüft.
    const stmts = await db.select({ by: digestStatements.geprueftBy }).from(digestStatements).where(eq(digestStatements.digestId, digest.id));
    expect(stmts.every((s: { by: string | null }) => s.by === adminId)).toBe(true);

    // Freigabe-Audit als Selbstfreigabe markiert (Actor prüfte selbst, allowSelfApproval=true).
    const approved = await auditsFor("digest.approved", digest.id);
    expect(approved.length).toBe(1);
    expect((approved[0].metadata as Record<string, unknown>).selfApproval).toBe(true);

    // cli_publish-Transparenz-Audit (PII-frei).
    const cli = await auditsFor("digest.cli_publish", digest.id);
    expect(cli.length).toBe(1);
    expect(cli[0].actorRef).toBe(adminId);
    expect(cli[0].metadata).toMatchObject({ schritte: res.schritte });
    expect(JSON.stringify(cli[0].metadata)).not.toContain("@");

    expect(sendMastodonMock).toHaveBeenCalledTimes(1);
    expect(sendBlueskyMock).toHaveBeenCalledTimes(1);
  });

  it.skipIf(SKIP)("m7-Invariante: bestehende Prüf-Spur (Redakteur) wird NICHT überschrieben; nur ungeprüfte gestempelt", async () => {
    const digest = await createEntwurfDigest(3, redakteurId); // Aussage 1 vom Redakteur geprüft
    const res = await call({ digestId: digest.id });
    expect(res.ok).toBe(true);
    // Genau 2 neu gestempelt (Aussagen 2+3), Aussage 1 blieb Redakteur.
    expect(res.schritte).toContain("statements_geprueft:2");

    const rows = await db
      .select({ pos: digestStatements.position, by: digestStatements.geprueftBy })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digest.id));
    const byPos = new Map((rows as Array<{ pos: number; by: string | null }>).map((r) => [r.pos, r.by]));
    expect(byPos.get(1)).toBe(redakteurId); // Spur unangetastet
    expect(byPos.get(2)).toBe(adminId);
    expect(byPos.get(3)).toBe(adminId);
  });

  it.skipIf(SKIP)("--nur-freigeben: freigegeben, NICHT veröffentlicht, keine Kanäle", async () => {
    sendMastodonMock.mockClear(); sendBlueskyMock.mockClear();
    const digest = await createEntwurfDigest(1);
    const res = await call({ digestId: digest.id, nurFreigeben: true });
    expect(res.ok).toBe(true);
    expect(res.schritte).toEqual(["statements_geprueft:1", "freigegeben", "nur_freigeben"]);
    expect(await status(digest.id)).toBe("freigegeben");
    expect(sendMastodonMock).not.toHaveBeenCalled();
    expect(sendBlueskyMock).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)("SoD fail-closed: allowSelfApproval=false ⇒ Freigabe-Fehler durchgereicht, Status bleibt entwurf, kein cli_publish", async () => {
    const digest = await createEntwurfDigest(2);
    const res = await call({ digestId: digest.id, allowSelfApproval: false });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Vier-Augen/);
    expect(await status(digest.id)).toBe("entwurf");
    expect((await auditsFor("digest.cli_publish", digest.id)).length).toBe(0);
    // Aussagen wurden gestempelt (Schritt vor der Freigabe) — das ist ok/beabsichtigt.
    expect(res.schritte).toContain("statements_geprueft:2");
  });

  it.skipIf(SKIP)("Zweite Person prüfte alles: Selbstfreigabe-frei (keine selfApproval-Markierung)", async () => {
    // Beide Aussagen bereits vom Redakteur geprüft → Admin stempelt nichts, gibt frei.
    const digest = await createEntwurfDigest(2, redakteurId);
    // zweite Aussage auch vom Redakteur prüfen
    const rows = await db.select({ id: digestStatements.id }).from(digestStatements).where(eq(digestStatements.digestId, digest.id));
    for (const r of rows as Array<{ id: string }>) {
      await db.update(digestStatements).set({ geprueftAt: new Date(), geprueftBy: redakteurId }).where(eq(digestStatements.id, r.id));
    }
    const res = await call({ digestId: digest.id, allowSelfApproval: false });
    expect(res.ok).toBe(true);
    expect(res.schritte).toContain("statements_geprueft:0");
    const approved = await auditsFor("digest.approved", digest.id);
    expect((approved[0].metadata as Record<string, unknown>).selfApproval).toBeUndefined();
  });

  it.skipIf(SKIP)("Idempotenz: bereits veröffentlicht ⇒ ok + bereitsVeroeffentlicht, keine Doppel-Audits", async () => {
    const digest = await createEntwurfDigest(1);
    const first = await call({ digestId: digest.id });
    expect(first.ok).toBe(true);
    const second = await call({ digestId: digest.id });
    expect(second.ok).toBe(true);
    expect(second.bereitsVeroeffentlicht).toBe(true);
    // kein zweites cli_publish
    expect((await auditsFor("digest.cli_publish", digest.id)).length).toBe(1);
  });

  it.skipIf(SKIP)("Fail-fast: unbekannter Tenant", async () => {
    const digest = await createEntwurfDigest(1);
    const res = await call({ digestId: digest.id, tenantSlug: "gibt-es-nicht" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Tenant "gibt-es-nicht" nicht gefunden');
  });

  it.skipIf(SKIP)("Fail-fast: unbekannter Digest", async () => {
    const res = await call({ digestId: "00000000-0000-0000-0000-000000000000" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nicht gefunden");
  });

  it.skipIf(SKIP)("Fail-fast: unbekannter Actor", async () => {
    const digest = await createEntwurfDigest(1);
    const res = await call({ digestId: digest.id, actorEmail: "niemand@cli.de" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nicht gefunden");
  });

  it.skipIf(SKIP)("Fail-fast: Actor aktiv, aber kein Admin (redakteur/kein Recht)", async () => {
    const digest = await createEntwurfDigest(1);
    const red = await call({ digestId: digest.id, actorEmail: redakteurEmail });
    expect(red.ok).toBe(false);
    expect(red.error).toMatch(/kein aktiver Admin/);
    const plain = await call({ digestId: digest.id, actorEmail: userEmail });
    expect(plain.ok).toBe(false);
    expect(plain.error).toMatch(/kein aktiver Admin/);
    expect(await status(digest.id)).toBe("entwurf");
  });

  it.skipIf(SKIP)("Fail-fast: Actor-Konto gesperrt (locked) ⇒ nicht aktiv", async () => {
    const digest = await createEntwurfDigest(1);
    const lockedEmail = `locked-${nextId()}@cli.de`;
    await db.insert(users).values({ tenantId, email: lockedEmail, accountStatus: "locked" });
    const res = await call({ digestId: digest.id, actorEmail: lockedEmail });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nicht aktiv/);
  });

  it.skipIf(SKIP)("Fail-fast: Titel zu lang", async () => {
    const digest = await createEntwurfDigest(1);
    const res = await call({ digestId: digest.id, neuerTitel: "x".repeat(MAX_TITLE_CHARS + 1) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/zu lang/);
    expect(await status(digest.id)).toBe("entwurf");
  });

  it.skipIf(SKIP)("Fail-fast: --titel nur im Status entwurf", async () => {
    const digest = await createEntwurfDigest(1);
    await call({ digestId: digest.id, nurFreigeben: true }); // → freigegeben
    const res = await call({ digestId: digest.id, neuerTitel: "zu spät" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nur im Status 'entwurf'/);
  });

  it.skipIf(SKIP)("Fortsetzung: aus freigegeben nur veröffentlichen (überspringt Prüfung/Freigabe)", async () => {
    const digest = await createEntwurfDigest(1);
    await call({ digestId: digest.id, nurFreigeben: true }); // → freigegeben
    const res = await call({ digestId: digest.id });
    expect(res.ok).toBe(true);
    expect(res.schritte).toEqual(["veroeffentlicht"]);
    expect(await status(digest.id)).toBe("veroeffentlicht");
  });
});
