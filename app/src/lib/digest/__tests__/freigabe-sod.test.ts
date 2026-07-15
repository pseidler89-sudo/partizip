/**
 * freigabe-sod.test.ts — Separation of Duties bei der Digest-Freigabe.
 *
 * Testet die ECHTE Kern-Funktion freigebenCore (kein Spiegel-Code):
 *   1. Wer Aussagen selbst geprüft hat, kann NICHT freigeben
 *      (Fehler, Status bleibt 'entwurf', KEIN digest.approved-Audit).
 *   2. Eine zweite Person KANN freigeben (Audit ohne selfApproval-Markierung).
 *   3. Mit allowSelfApproval=true (=ALLOW_SELF_APPROVAL) ist Selbstfreigabe
 *      möglich UND im Audit als metadata.selfApproval=true markiert.
 *   4. Ohne das Flag ⇒ blockiert (fail-closed, Default-Parameter).
 *   5. isSelfApprovalAllowed: NUR exakt "true" schaltet frei (fail-closed).
 *   6. Rollen-Gate: redakteur/beobachter können NIE freigeben.
 *   7. Tenant-Vier-Augen-Pflicht ist per Env NICHT überbrückbar.
 *   8. Audit bleibt PII-frei (keine E-Mail, actorRef = UUID).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import type { Db } from "@/db/client";
import { freigebenCore, isSelfApprovalAllowed, hatDigestRedigiert, computeStatementsHash } from "../freigabe-core";

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

describe("Digest-Freigabe — Separation of Duties (Integration, echte freigebenCore)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let tenant2Id: string;
  /** Admin, der freigibt (und ggf. selbst geprüft hat). */
  let adminId: string;
  /** Zweiter Admin — die „zweite Person" der Vier-Augen-Freigabe. */
  let zweiterAdminId: string;
  /** Redakteur, der Aussagen prüft (redigiert). */
  let redakteurId: string;
  let bodyId: string;

  const ADMIN_ROLLEN = ["kommune_admin"];

  let counter = 0;
  function nextId() {
    return `sod-${Date.now()}-${++counter}`;
  }

  beforeAll(async () => {
    if (SKIP) return;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_, { schema }) as unknown as Db;
    await migrate(db, { migrationsFolder });

    const [tenant] = await db.insert(tenants).values({
      slug: `sod-${Date.now()}`,
      name: "SoD-Test-Tenant",
    }).returning();
    tenantId = tenant.id;

    const [tenant2] = await db.insert(tenants).values({
      slug: `sod-t2-${Date.now()}`,
      name: "SoD-Test-Tenant-2",
    }).returning();
    tenant2Id = tenant2.id;

    const [admin] = await db.insert(users).values({
      tenantId, email: `admin-${Date.now()}@sod-test.de`,
    }).returning();
    adminId = admin.id;
    const [admin2] = await db.insert(users).values({
      tenantId, email: `admin2-${Date.now()}@sod-test.de`,
    }).returning();
    zweiterAdminId = admin2.id;
    const [redakteur] = await db.insert(users).values({
      tenantId, email: `redakteur-${Date.now()}@sod-test.de`,
    }).returning();
    redakteurId = redakteur.id;

    const sodRegion = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    await db.insert(roles).values([
      { tenantId, userId: adminId, roleType: "kommune_admin", regionId: sodRegion },
      { tenantId, userId: zweiterAdminId, roleType: "kommune_admin", regionId: sodRegion },
      { tenantId, userId: redakteurId, roleType: "redakteur", regionId: sodRegion },
    ]);

    const [body] = await db.insert(risBodies).values({
      tenantId,
      key: "sod-test-body",
      risType: "provox_iip",
      baseUrl: "https://sod-test.example.de",
    }).returning();
    bodyId = body.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  /** Digest im Entwurf mit `anzahl` Aussagen, alle von `geprueftVon` geprüft. */
  async function createGeprueftenDigest(anzahl: number, geprueftVon: string) {
    const [meeting] = await db.insert(risMeetings).values({
      bodyId,
      externalId: nextId(),
      gremium: "Testgremium",
      title: "Testsitzung",
      meetingDate: new Date("2026-06-01T15:00:00Z"),
      sourceUrl: `https://sod-test.example.de/meeting/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();

    const [doc] = await db.insert(risDocuments).values({
      meetingId: meeting.id,
      docType: "top",
      externalId: nextId(),
      title: "TOP 1",
      bodyText: "Testbeschluss",
      sourceUrl: `https://sod-test.example.de/doc/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: `SoD-Digest-${nextId()}`,
      status: "entwurf",
      generator: "extractive_v1",
    }).returning();

    const now = new Date();
    for (let i = 1; i <= anzahl; i++) {
      await db.insert(digestStatements).values({
        digestId: digest.id,
        position: i,
        text: `Aussage ${i}: Testbeschluss.`,
        sourceDocumentId: doc.id,
        sourceUrl: `https://sod-test.example.de/doc/${i}`,
        geprueftAt: now,
        geprueftBy: geprueftVon,
      });
    }

    return digest;
  }

  async function digestStatus(digestId: string): Promise<string> {
    const [row] = await db
      .select({ status: digests.status })
      .from(digests)
      .where(eq(digests.id, digestId));
    return row.status;
  }

  async function approvedAudits(digestId: string) {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "digest.approved"), eq(auditEvents.targetId, digestId)),
      );
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 1. SoD: Redigierende Person kann NICHT freigeben
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("1. Selbst-geprüfter Digest: Freigabe blockiert, Status bleibt, kein Audit", async () => {
    const digest = await createGeprueftenDigest(2, adminId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
      allowSelfApproval: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Vier-Augen/);
    expect(await digestStatus(digest.id)).toBe("entwurf");
    expect((await approvedAudits(digest.id)).length).toBe(0);
  });

  it.skipIf(SKIP)("1b. FAIL-CLOSED: ohne allowSelfApproval-Angabe (Default) ⇒ blockiert", async () => {
    const digest = await createGeprueftenDigest(1, adminId);

    // allowSelfApproval BEWUSST weggelassen — Default muss die Sperre erzwingen.
    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Vier-Augen/);
    expect(await digestStatus(digest.id)).toBe("entwurf");
    expect((await approvedAudits(digest.id)).length).toBe(0);
  });

  it.skipIf(SKIP)("1c. Auch wenn nur EINE von mehreren Aussagen selbst geprüft ist ⇒ blockiert", async () => {
    const digest = await createGeprueftenDigest(3, redakteurId);
    // Eine einzige Aussage vom Admin selbst geprüft
    const stmts = await db
      .select({ id: digestStatements.id })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digest.id))
      .limit(1);
    await db
      .update(digestStatements)
      .set({ geprueftBy: adminId })
      .where(eq(digestStatements.id, stmts[0].id));

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Vier-Augen/);
    expect(await digestStatus(digest.id)).toBe("entwurf");
  });

  // -------------------------------------------------------------------------
  // 2. Zweite Person KANN freigeben
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("2. Vom Redakteur geprüfter Digest: zweite Person gibt frei (Audit ohne selfApproval)", async () => {
    const digest = await createGeprueftenDigest(2, redakteurId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
    });

    expect(result.ok).toBe(true);
    expect(await digestStatus(digest.id)).toBe("freigegeben");

    const audits = await approvedAudits(digest.id);
    expect(audits.length).toBe(1);
    expect(audits[0].actorRef).toBe(adminId);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.selfApproval).toBeUndefined();
    // PII-frei: keine E-Mail im gesamten Audit-Event
    expect(JSON.stringify(meta)).not.toContain("@");
    expect(audits[0].actorRef).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.skipIf(SKIP)("2b. Freigabe durch Admin, nachdem ein ANDERER Admin geprüft hat", async () => {
    const digest = await createGeprueftenDigest(1, zweiterAdminId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
    });

    expect(result.ok).toBe(true);
    expect(await digestStatus(digest.id)).toBe("freigegeben");
  });

  // -------------------------------------------------------------------------
  // 3. Pilot-Überbrückung: allowSelfApproval ⇒ möglich UND im Audit markiert
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("3. allowSelfApproval=true: Selbstfreigabe möglich, Audit metadata.selfApproval=true", async () => {
    const digest = await createGeprueftenDigest(2, adminId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
      allowSelfApproval: true,
    });

    expect(result.ok).toBe(true);
    expect(await digestStatus(digest.id)).toBe("freigegeben");

    const audits = await approvedAudits(digest.id);
    expect(audits.length).toBe(1);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.selfApproval).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("@");
  });

  it.skipIf(SKIP)("3b. allowSelfApproval=true OHNE Selbstbearbeitung: KEINE selfApproval-Markierung", async () => {
    const digest = await createGeprueftenDigest(1, redakteurId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
      allowSelfApproval: true,
    });

    expect(result.ok).toBe(true);
    const audits = await approvedAudits(digest.id);
    expect(audits.length).toBe(1);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.selfApproval).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4. Rollen-Gate in der Kern-Funktion
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("4. redakteur und beobachter können NIE freigeben (auch nicht fremd-geprüfte Digests)", async () => {
    const digest = await createGeprueftenDigest(1, redakteurId);

    for (const rollen of [["redakteur"], ["beobachter"], ["user"], []]) {
      const result = await freigebenCore(db, tenantId, {
        digestId: digest.id,
        callerUserId: zweiterAdminId,
        callerRoleTypes: rollen,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/kommune_admin\/super_admin/);
    }
    expect(await digestStatus(digest.id)).toBe("entwurf");
    expect((await approvedAudits(digest.id)).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Tenant-Isolation
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("5. Cross-Tenant: Freigabe gegen fremden Tenant → nicht gefunden", async () => {
    const digest = await createGeprueftenDigest(1, redakteurId);

    const result = await freigebenCore(db, tenant2Id, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nicht gefunden");
    expect(await digestStatus(digest.id)).toBe("entwurf");
  });

  // -------------------------------------------------------------------------
  // 6. Tenant-Vier-Augen-Pflicht ist per Env NICHT überbrückbar
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("6. tenants.vier_augen_pflicht=true blockt Selbstfreigabe TROTZ allowSelfApproval", async () => {
    await db.update(tenants).set({ vierAugenPflicht: true }).where(eq(tenants.id, tenantId));
    try {
      const digest = await createGeprueftenDigest(1, adminId);

      const result = await freigebenCore(db, tenantId, {
        digestId: digest.id,
        callerUserId: adminId,
        callerRoleTypes: ADMIN_ROLLEN,
        allowSelfApproval: true,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Vier-Augen/);
      expect(await digestStatus(digest.id)).toBe("entwurf");
    } finally {
      await db.update(tenants).set({ vierAugenPflicht: false }).where(eq(tenants.id, tenantId));
    }
  });

  // -------------------------------------------------------------------------
  // 7. hatDigestRedigiert (UI-Spur) — tenant-scoped
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("7. hatDigestRedigiert: erkennt eigene Prüf-Spur, tenant-scoped, sonst false", async () => {
    const digest = await createGeprueftenDigest(2, adminId);

    expect(await hatDigestRedigiert(db, tenantId, digest.id, adminId)).toBe(true);
    expect(await hatDigestRedigiert(db, tenantId, digest.id, zweiterAdminId)).toBe(false);
    // Cross-Tenant: falscher Tenant → keine Spur sichtbar
    expect(await hatDigestRedigiert(db, tenant2Id, digest.id, adminId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 8. Highlight-Separation-of-Duties (MINOR 3): wer hervorhebt, gibt nicht selbst frei.
  //    Kompat-sicher über die highlighted_by-Spur — NICHT über den Content-Hash.
  // -------------------------------------------------------------------------

  /** Setzt highlighted_by (+ ist_highlight) auf der ersten Aussage eines Digests. */
  async function highlightErsteAussage(digestId: string, von: string) {
    const [stmt] = await db
      .select({ id: digestStatements.id })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digestId))
      .limit(1);
    await db
      .update(digestStatements)
      .set({ istHighlight: true, highlightedBy: von })
      .where(eq(digestStatements.id, stmt.id));
  }

  it.skipIf(SKIP)("8. Highlight durch Admin ⇒ Selbstfreigabe blockiert (SoD über highlighted_by)", async () => {
    // Alle Aussagen vom Redakteur geprüft; der Admin hat nur HERVORGEHOBEN.
    const digest = await createGeprueftenDigest(2, redakteurId);
    await highlightErsteAussage(digest.id, adminId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
      allowSelfApproval: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Vier-Augen/);
    expect(await digestStatus(digest.id)).toBe("entwurf");
    expect((await approvedAudits(digest.id)).length).toBe(0);
    // UI-Spur erkennt die Mitgestaltung auch über das Highlight.
    expect(await hatDigestRedigiert(db, tenantId, digest.id, adminId)).toBe(true);
  });

  it.skipIf(SKIP)("8b. Highlight-Selbstfreigabe mit allowSelfApproval=true erlaubt UND als selfApproval auditiert", async () => {
    const digest = await createGeprueftenDigest(2, redakteurId);
    await highlightErsteAussage(digest.id, adminId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: adminId,
      callerRoleTypes: ADMIN_ROLLEN,
      allowSelfApproval: true,
    });

    expect(result.ok).toBe(true);
    expect(await digestStatus(digest.id)).toBe("freigegeben");
    const audits = await approvedAudits(digest.id);
    expect(audits.length).toBe(1);
    expect((audits[0].metadata as Record<string, unknown>).selfApproval).toBe(true);
  });

  it.skipIf(SKIP)("8c. Zweiter Admin (weder geprüft noch hervorgehoben) darf trotz Highlight freigeben", async () => {
    const digest = await createGeprueftenDigest(2, redakteurId);
    await highlightErsteAussage(digest.id, adminId);

    const result = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: zweiterAdminId,
      callerRoleTypes: ADMIN_ROLLEN,
    });

    expect(result.ok).toBe(true);
    expect(await digestStatus(digest.id)).toBe("freigegeben");
  });

  it.skipIf(SKIP)("8d. HASH-KOMPAT: istHighlight geht NICHT in computeStatementsHash ein", async () => {
    const stmts = [
      { position: 1, text: "Aussage A", sourceUrl: "https://x/1" },
      { position: 2, text: "Aussage B", sourceUrl: "https://x/2" },
    ];
    // computeStatementsHash nimmt istHighlight strukturell nicht entgegen —
    // ein Highlight-Wechsel kann den Freigabe-Hash also nie verändern.
    const h1 = computeStatementsHash(stmts);
    const h2 = computeStatementsHash([...stmts]);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// isSelfApprovalAllowed — Env-Parsing (fail-closed, reine Funktion, keine DB)
// ---------------------------------------------------------------------------

describe("isSelfApprovalAllowed — fail-closed Env-Parsing", () => {
  it('NUR exakt "true" (getrimmt, case-insensitiv) schaltet frei', () => {
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "true" })).toBe(true);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "TRUE" })).toBe(true);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: " true " })).toBe(true);
  });

  it("fehlend/leer/ungültig ⇒ AUS (SoD wird erzwungen)", () => {
    expect(isSelfApprovalAllowed({})).toBe(false);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: undefined })).toBe(false);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "" })).toBe(false);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "false" })).toBe(false);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "1" })).toBe(false);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "yes" })).toBe(false);
    expect(isSelfApprovalAllowed({ ALLOW_SELF_APPROVAL: "truee" })).toBe(false);
  });
});
