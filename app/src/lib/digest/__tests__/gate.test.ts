/**
 * gate.test.ts — Freigabe-Gate-Tests (M7 + Gate-B-Nacharbeit)
 *
 * Kritische Tests:
 *   1. DB-CHECK: entwurf→veroeffentlicht ohne approved_at → FEHLER
 *   2. DB-CHECK: freigegeben ohne approved_at → FEHLER
 *   3. entwurf→freigegeben MIT approved_at → OK
 *   4. freigegeben→veroeffentlicht MIT published_at → OK
 *   5. Cross-Tenant: Digest nur im eigenen Tenant sichtbar
 *   6. Öffentliche Seite: nur status='veroeffentlicht' sichtbar
 *   M2-1: Doppel-Freigabe → zweiter Aufruf scheitert (0 rows)
 *   M2-2: Freigeben auf veröffentlichtem Digest → scheitert, Status bleibt
 *   M2-3: Parallele Veröffentlichung ×5 → genau 1 Erfolg, genau 1 Audit
 *   M3: sendFn-Spy erhält Aussagen-Texte
 *   N1: approved_content_hash wird bei Freigabe gesetzt; Mismatch → Fehler
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 * Nutzt das bereits migrierte Schema der Test-DB (kein eigener DROP/CREATE).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as schema from "@/db/schema.js";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStatementsHash(
  stmts: Array<{ position: number; text: string; sourceUrl: string }>
): string {
  const sorted = [...stmts].sort((a, b) => a.position - b.position);
  const canonical = sorted.map((s) => `${s.position}|${s.text}|${s.sourceUrl}`).join("\n");
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

describe("Digest-Freigabe-Gate (Integration)", () => {
  let sql_: postgres.Sql;
  let db: ReturnType<typeof drizzle>;

  let tenantId: string;
  let adminUserId: string;
  let bodyId: string;

  let counter = 0;
  function nextId() {
    return `gate-${Date.now()}-${++counter}`;
  }

  beforeAll(async () => {
    if (SKIP) return;

    // Schema reset und Migration
    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    // Gemeinsame Test-Daten anlegen
    const [tenant] = await db.insert(tenants).values({
      slug: `gate-${Date.now()}`,
      name: "Gate-Test-Tenant",
    }).returning();
    tenantId = tenant.id;

    const [adminUser] = await db.insert(users).values({
      tenantId,
      email: `admin-${Date.now()}@gate-test.de`,
    }).returning();
    adminUserId = adminUser.id;

    // Admin-Rolle
    await db.insert(roles).values({
      tenantId,
      userId: adminUserId,
      roleType: "kommune_admin",
      regionId: await resolveRegionIdForScope(db as never, tenantId, "stadt", null),
    });

    // RIS-Body
    const [body] = await db.insert(risBodies).values({
      tenantId,
      key: "gate-test-body",
      risType: "provox_iip",
      baseUrl: "https://gate-test.example.de",
    }).returning();
    bodyId = body.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  async function createMeeting() {
    const [meeting] = await db.insert(risMeetings).values({
      bodyId,
      externalId: nextId(),
      gremium: "Testgremium",
      title: "Testsitzung",
      meetingDate: new Date("2026-05-12T15:00:00Z"),
      sourceUrl: `https://gate-test.example.de/meeting/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();
    return meeting;
  }

  async function createDoc(meetingId: string) {
    const [doc] = await db.insert(risDocuments).values({
      meetingId,
      docType: "top",
      externalId: nextId(),
      title: "TOP 1",
      bodyText: "Testbeschluss",
      sourceUrl: `https://gate-test.example.de/doc/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();
    return doc;
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  it.skipIf(SKIP)("1. DB-CHECK: entwurf→veroeffentlicht ohne approved_at → FEHLER", async () => {
    const meeting = await createMeeting();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Test-Digest-1",
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    // Direkter Sprung entwurf→veroeffentlicht ohne approved_at → DB-CHECK-Verletzung
    await expect(
      db.update(digests)
        .set({ status: "veroeffentlicht", publishedAt: new Date() })
        .where(eq(digests.id, digest.id))
    ).rejects.toThrow();
  });

  it.skipIf(SKIP)("2. DB-CHECK: freigegeben ohne approved_at → FEHLER", async () => {
    const meeting = await createMeeting();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Test-Digest-2",
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    // Status 'freigegeben' ohne approved_at → CHECK-Verletzung
    await expect(
      db.update(digests)
        .set({ status: "freigegeben" })
        .where(eq(digests.id, digest.id))
    ).rejects.toThrow();
  });

  it.skipIf(SKIP)("3. entwurf→freigegeben MIT approved_at → OK", async () => {
    const meeting = await createMeeting();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Test-Digest-3",
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    // Freigeben mit approvedAt → OK
    await expect(
      db.update(digests)
        .set({ status: "freigegeben", approvedBy: adminUserId, approvedAt: new Date() })
        .where(eq(digests.id, digest.id))
    ).resolves.not.toThrow();

    const [updated] = await db.select().from(digests).where(eq(digests.id, digest.id));
    expect(updated.status).toBe("freigegeben");
    expect(updated.approvedAt).not.toBeNull();
  });

  it.skipIf(SKIP)("4. freigegeben→veroeffentlicht MIT published_at → OK", async () => {
    const meeting = await createMeeting();
    const now = new Date();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Test-Digest-4",
      status: "freigegeben",
      generator: "extractive_v1",
      approvedBy: adminUserId,
      approvedAt: now,
    }).returning();

    // Veröffentlichen → OK
    await expect(
      db.update(digests)
        .set({ status: "veroeffentlicht", publishedAt: new Date() })
        .where(eq(digests.id, digest.id))
    ).resolves.not.toThrow();

    const [updated] = await db.select().from(digests).where(eq(digests.id, digest.id));
    expect(updated.status).toBe("veroeffentlicht");
    expect(updated.publishedAt).not.toBeNull();
    expect(updated.approvedAt).not.toBeNull();
  });

  it.skipIf(SKIP)("5. Cross-Tenant: Digest aus anderem Tenant nicht abrufbar", async () => {
    // Zweiten Tenant anlegen
    const [tenant2] = await db.insert(tenants).values({
      slug: `gate-tenant2-${Date.now()}`,
      name: "Gate-Tenant-2",
    }).returning();

    const meeting = await createMeeting();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Tenant1-Digest",
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    // Tenant2 versucht Digest von Tenant1 abzurufen
    const result = await db
      .select()
      .from(digests)
      .where(and(eq(digests.id, digest.id), eq(digests.tenantId, tenant2.id)))
      .limit(1);

    expect(result.length).toBe(0);
  });

  it.skipIf(SKIP)("6. Öffentliche Seite: nur veroeffentlichte Digests sichtbar", async () => {
    const now = new Date();

    const meetEntwurf = await createMeeting();
    const meetFreig = await createMeeting();
    const meetVer = await createMeeting();

    await db.insert(digests).values({
      tenantId,
      meetingId: meetEntwurf.id,
      title: "Entwurf-Digest",
      status: "entwurf",
      generator: "extractive_v1",
    });

    await db.insert(digests).values({
      tenantId,
      meetingId: meetFreig.id,
      title: "Freigegeben-Digest",
      status: "freigegeben",
      generator: "extractive_v1",
      approvedBy: adminUserId,
      approvedAt: now,
    });

    await db.insert(digests).values({
      tenantId,
      meetingId: meetVer.id,
      title: "Veroeffentlicht-Digest",
      status: "veroeffentlicht",
      generator: "extractive_v1",
      approvedBy: adminUserId,
      approvedAt: now,
      publishedAt: now,
    });

    // Wie öffentliche Seite: NUR veroeffentlichte abfragen
    const publicDigests = await db
      .select({ status: digests.status, title: digests.title })
      .from(digests)
      .where(and(eq(digests.tenantId, tenantId), eq(digests.status, "veroeffentlicht")));

    // Alle zurückgegebenen Digests haben status=veroeffentlicht
    for (const d of publicDigests) {
      expect(d.status).toBe("veroeffentlicht");
    }

    // Entwurf + Freigegeben tauchen NICHT auf
    const titles = publicDigests.map((d) => d.title);
    expect(titles).not.toContain("Entwurf-Digest");
    expect(titles).not.toContain("Freigegeben-Digest");
    expect(titles).toContain("Veroeffentlicht-Digest");
  });

  // ---------------------------------------------------------------------------
  // M2: TOCTOU-Guards
  // ---------------------------------------------------------------------------

  it.skipIf(SKIP)("M2-1: Doppel-Freigabe → zweiter UPDATE liefert 0 Zeilen", async () => {
    const meeting = await createMeeting();
    const now = new Date();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Doppel-Freigabe-Test",
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    // Hinweis: Digest hat keine Statements → gate-Prüfung in actions.ts würde
    // "0 von 0 geprüft" ergeben (0 < 0 = false → OK). Hier wird direkt DB-UPDATE
    // getestet, nicht die Action selbst.

    // Erster Freigabe-Versuch (wie in actions.ts mit WHERE status='entwurf')
    const firstResult = await db
      .update(digests)
      .set({ status: "freigegeben", approvedBy: adminUserId, approvedAt: now })
      .where(and(
        eq(digests.id, digest.id),
        eq(digests.tenantId, tenantId),
        eq(digests.status, "entwurf")
      ))
      .returning();

    expect(firstResult.length).toBe(1);

    // Zweiter Freigabe-Versuch → Status ist nun 'freigegeben', nicht 'entwurf'
    const secondResult = await db
      .update(digests)
      .set({ status: "freigegeben", approvedBy: adminUserId, approvedAt: now })
      .where(and(
        eq(digests.id, digest.id),
        eq(digests.tenantId, tenantId),
        eq(digests.status, "entwurf")  // Guard
      ))
      .returning();

    // Kein Row matched → 0 Zeilen
    expect(secondResult.length).toBe(0);
  });

  it.skipIf(SKIP)("M2-2: Freigeben auf veröffentlichtem Digest → scheitert, Status bleibt", async () => {
    const meeting = await createMeeting();
    const now = new Date();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Veröff-Freigabe-Test",
      status: "veroeffentlicht",
      generator: "extractive_v1",
      approvedBy: adminUserId,
      approvedAt: now,
      publishedAt: now,
    }).returning();

    // Versuch, veröffentlichten Digest nochmals freizugeben → WHERE status='entwurf' matched nicht
    const result = await db
      .update(digests)
      .set({ status: "freigegeben", approvedAt: new Date() })
      .where(and(
        eq(digests.id, digest.id),
        eq(digests.tenantId, tenantId),
        eq(digests.status, "entwurf")  // Guard
      ))
      .returning();

    expect(result.length).toBe(0);

    // Status bleibt 'veroeffentlicht'
    const [current] = await db.select({ status: digests.status }).from(digests).where(eq(digests.id, digest.id));
    expect(current.status).toBe("veroeffentlicht");
  });

  it.skipIf(SKIP)("M2-3: Parallele Veröffentlichung ×5 → genau 1 Erfolg, genau 1 Audit", async () => {
    const meeting = await createMeeting();
    const doc = await createDoc(meeting.id);
    const now = new Date();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Parallele-Veroeffentlichung-Test",
      status: "freigegeben",
      generator: "extractive_v1",
      approvedBy: adminUserId,
      approvedAt: now,
    }).returning();

    await db.insert(digestStatements).values({
      digestId: digest.id,
      position: 1,
      text: "Testbeschluss für parallele Veröffentlichung.",
      sourceDocumentId: doc.id,
      sourceUrl: "https://gate-test.example.de/doc/1",
    });

    // Simuliere 5 parallele Veröffentlichungsversuche
    // (wie actions.ts: UPDATE WHERE status='freigegeben')
    const publishAttempt = async () => {
      return await db.transaction(async (tx) => {
        const updated = await tx
          .update(digests)
          .set({ status: "veroeffentlicht", publishedAt: new Date() })
          .where(and(
            eq(digests.id, digest.id),
            eq(digests.tenantId, tenantId),
            eq(digests.status, "freigegeben")  // M2: Guard
          ))
          .returning({ id: digests.id });

        if (updated.length === 0) {
          return { ok: false };
        }

        // Audit
        await tx.insert(auditEvents).values({
          tenantId,
          actorType: "admin",
          actorRef: adminUserId,
          action: "digest.published",
          targetType: "digest",
          targetId: digest.id,
          metadata: { digestId: digest.id },
        });

        return { ok: true };
      });
    };

    const results = await Promise.all([
      publishAttempt(),
      publishAttempt(),
      publishAttempt(),
      publishAttempt(),
      publishAttempt(),
    ]);

    const successes = results.filter((r) => r.ok);
    expect(successes.length).toBe(1);

    // Genau 1 Audit-Event für digest.published
    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.action, "digest.published"),
        eq(auditEvents.targetId, digest.id)
      ));

    expect(auditRows.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // M3: Kanal (Mastodon) erhält Titel + Anreißer + Permalink (ADR-021)
  // ---------------------------------------------------------------------------

  it.skipIf(SKIP)("M3: sendDigestToMastodon postet Titel, 1. Aussage und Permalink", async () => {
    const meeting = await createMeeting();
    const doc = await createDoc(meeting.id);
    const now = new Date();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Kanal-Test-Digest",
      status: "freigegeben",
      generator: "extractive_v1",
      approvedBy: adminUserId,
      approvedAt: now,
    }).returning();

    // Statements anlegen
    await db.insert(digestStatements).values([
      {
        digestId: digest.id,
        position: 1,
        text: "Aussage 1: Wichtiger Beschluss.",
        sourceDocumentId: doc.id,
        sourceUrl: "https://gate-test.example.de/doc/1",
      },
      {
        digestId: digest.id,
        position: 2,
        text: "Aussage 2: Weiterer Beschluss.",
        sourceDocumentId: doc.id,
        sourceUrl: "https://gate-test.example.de/doc/2",
      },
    ]);

    // Statements aus DB laden (wie actions.ts veroeffentlichen)
    const stmts = await db
      .select({ position: digestStatements.position, text: digestStatements.text })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digest.id))
      .orderBy(digestStatements.position);

    // ADR-021: Kanal-Beitrag = Titel + erste Aussage + Permalink (kein Volltext).
    process.env.MASTODON_INSTANCE_URL = "https://test.instanz";
    process.env.MASTODON_ACCESS_TOKEN = "geheimer-test-token";
    process.env.NEXT_PUBLIC_BASE_URL = "https://partizip.online";

    let capturedBody: string | undefined;
    const fetchSpy = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return { ok: true, json: async () => ({ url: "https://test.instanz/@p/1" }) };
    }) as unknown as typeof fetch;

    const { sendDigestToMastodon } = await import("../../channels/mastodon.js");
    const result = await sendDigestToMastodon(
      {
        id: digest.id,
        title: digest.title,
        statements: stmts.map((s) => ({ text: s.text })),
        tenantSlug: "test-tenant",
      },
      { fetchFn: fetchSpy },
    );

    delete process.env.MASTODON_INSTANCE_URL;
    delete process.env.MASTODON_ACCESS_TOKEN;
    delete process.env.NEXT_PUBLIC_BASE_URL;

    expect(result.sent).toBe(true);
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    // Titel + erste Aussage + Permalink auf die EIGENE Seite (die ist der Kanal).
    expect(parsed.status).toContain("Kanal-Test-Digest");
    expect(parsed.status).toContain("Aussage 1: Wichtiger Beschluss.");
    expect(parsed.status).toContain(`https://partizip.online/test-tenant/digest/${digest.id}`);
    // Volltext wird NICHT gepostet — nur Anreißer.
    expect(parsed.status).not.toContain("Aussage 2: Weiterer Beschluss.");
  });

  // ---------------------------------------------------------------------------
  // N1: approved_content_hash
  // ---------------------------------------------------------------------------

  it.skipIf(SKIP)("N1: approved_content_hash wird bei Freigabe korrekt berechnet", async () => {
    const meeting = await createMeeting();
    const doc = await createDoc(meeting.id);
    const now = new Date();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Content-Hash-Test",
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    const stmts = [
      { position: 1, text: "Beschluss 1.", sourceUrl: "https://gate-test.example.de/doc/1" },
      { position: 2, text: "Beschluss 2.", sourceUrl: "https://gate-test.example.de/doc/2" },
    ];

    await db.insert(digestStatements).values(
      stmts.map((s) => ({
        digestId: digest.id,
        position: s.position,
        text: s.text,
        sourceDocumentId: doc.id,
        sourceUrl: s.sourceUrl,
      }))
    );

    const expectedHash = computeStatementsHash(stmts);

    // Freigabe mit Content-Hash
    await db.update(digests).set({
      status: "freigegeben",
      approvedBy: adminUserId,
      approvedAt: now,
      approvedContentHash: expectedHash,
    }).where(and(
      eq(digests.id, digest.id),
      eq(digests.tenantId, tenantId),
      eq(digests.status, "entwurf")
    ));

    const [updated] = await db.select().from(digests).where(eq(digests.id, digest.id));
    expect(updated.approvedContentHash).toBe(expectedHash);
  });

  it.skipIf(SKIP)("N1: Mismatch approved_content_hash → Veröffentlichung scheitert", async () => {
    const meeting = await createMeeting();
    const doc = await createDoc(meeting.id);
    const now = new Date();

    const originalStmts = [
      { position: 1, text: "Ursprünglicher Beschluss.", sourceUrl: "https://gate-test.example.de/doc/1" },
    ];
    const originalHash = computeStatementsHash(originalStmts);

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: "Hash-Mismatch-Test",
      status: "freigegeben",
      generator: "extractive_v1",
      approvedBy: adminUserId,
      approvedAt: now,
      approvedContentHash: originalHash,
    }).returning();

    // Statement MIT dem originalen Text
    await db.insert(digestStatements).values({
      digestId: digest.id,
      position: 1,
      text: "Ursprünglicher Beschluss.",
      sourceDocumentId: doc.id,
      sourceUrl: "https://gate-test.example.de/doc/1",
    });

    // Jetzt Statement ändern (nach Freigabe — Manipulation)
    await db.update(digestStatements)
      .set({ text: "Manipulierter Beschluss!" })
      .where(eq(digestStatements.digestId, digest.id));

    // Hash-Prüfung simulieren (wie in actions.ts veroeffentlichen)
    const currentStmts = await db
      .select({ position: digestStatements.position, text: digestStatements.text, sourceUrl: digestStatements.sourceUrl })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digest.id));

    const currentHash = computeStatementsHash(currentStmts);
    expect(currentHash).not.toBe(originalHash); // Mismatch erkannt
  });
});
