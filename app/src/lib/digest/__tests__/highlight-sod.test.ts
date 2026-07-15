/**
 * highlight-sod.test.ts — Highlight-Spur gegen Überschreibung gehärtet (NACHARBEIT B).
 *
 * Ruft die ECHTE Server Action setStatementHighlight auf (Auth über gemockte
 * next/headers + next/cookies gegen eine reale Session/Tenant in der Test-DB) und
 * prüft die Kern-Invariante der SoD-Spur:
 *
 *   - Der ERSTE Highlighter wird in digest_statements.highlighted_by festgehalten.
 *   - Ein ZWEITER Setzer auf eine BEREITS hervorgehobene Aussage überschreibt die
 *     Spur NICHT (COALESCE: nur schreiben, wenn NULL) — sonst verlöre der erste
 *     Highlighter seine Spur und könnte doch selbst freigeben.
 *   - Entfernen (istHighlight=false) setzt highlighted_by NICHT zurück (persistent).
 *   - Folge (echte freigebenCore): der erste Highlighter bleibt von der
 *     Selbstfreigabe gesperrt; ein unbeteiligter Admin darf weiterhin freigeben.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst skip).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mutierbarer Request-Kontext für die gemockten next/headers + next/cookies
// (vi.hoisted, damit die Mock-Factory darauf zugreifen darf).
const reqCtx = vi.hoisted(() => ({
  host: null as string | null,
  cookie: undefined as string | undefined,
}));

vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => (k.toLowerCase() === "host" ? reqCtx.host : null) }),
  cookies: () => ({
    get: (k: string) =>
      k === "partizip_session" && reqCtx.cookie ? { value: reqCtx.cookie } : undefined,
  }),
}));

import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import type { Db } from "@/db/client";
import { sha256Hex } from "@/lib/auth/crypto";
import { setStatementHighlight } from "@/lib/digest/actions";
import { freigebenCore } from "@/lib/digest/freigabe-core";

const {
  tenants, users, roles, sessions, risBodies, risMeetings, risDocuments,
  digests, digestStatements,
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

const SLUG = "hlsod";
const ADMIN_ROLLEN = ["kommune_admin"];

describe("Highlight-SoD — Spur nicht überschreibbar (Integration, echte Action)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  let tenantId: string;
  let admin1Id: string;
  let admin2Id: string;
  let admin3Id: string;
  let prueferId: string;
  let bodyId: string;

  let sessionAdmin1: string;
  let sessionAdmin2: string;

  let counter = 0;
  function nextId() {
    return `hlsod-${Date.now()}-${++counter}`;
  }

  /** Setzt den Request-Kontext für die nächste Action auf ein bestimmtes Konto. */
  function actAs(rawToken: string) {
    reqCtx.host = `${SLUG}.localhost`;
    reqCtx.cookie = rawToken;
  }

  async function makeSession(userId: string): Promise<string> {
    const rawToken = `tok-${nextId()}`;
    await db.insert(sessions).values({
      userId,
      tenantId,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return rawToken;
  }

  /** Digest im Entwurf mit `anzahl` Aussagen, alle vom Prüfer geprüft (Completeness ok). */
  async function createGeprueftenDigest(anzahl: number) {
    const [meeting] = await db.insert(risMeetings).values({
      bodyId,
      externalId: nextId(),
      gremium: "Testgremium",
      title: "Testsitzung",
      meetingDate: new Date("2026-06-01T15:00:00Z"),
      sourceUrl: `https://hlsod.example.de/meeting/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();

    const [doc] = await db.insert(risDocuments).values({
      meetingId: meeting.id,
      docType: "top",
      externalId: nextId(),
      title: "TOP 1",
      bodyText: "Testbeschluss",
      sourceUrl: `https://hlsod.example.de/doc/${nextId()}`,
      fetchedAt: new Date(),
    }).returning();

    const [digest] = await db.insert(digests).values({
      tenantId,
      meetingId: meeting.id,
      title: `HLSoD-Digest-${nextId()}`,
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
        sourceUrl: `https://hlsod.example.de/doc/${i}`,
        geprueftAt: now,
        geprueftBy: prueferId,
      });
    }
    return digest;
  }

  async function ersteAussage(digestId: string) {
    const [s] = await db
      .select({ id: digestStatements.id })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digestId))
      .orderBy(digestStatements.position)
      .limit(1);
    return s.id;
  }

  async function highlightSpur(statementId: string) {
    const [row] = await db
      .select({ hl: digestStatements.highlightedBy, is: digestStatements.istHighlight })
      .from(digestStatements)
      .where(eq(digestStatements.id, statementId));
    return row;
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

    // Die echte Action liest DATABASE_URL zur Laufzeit (createDb / getTenantBySlug).
    process.env.DATABASE_URL = TEST_DB_URL;

    const [tenant] = await db.insert(tenants).values({
      slug: SLUG,
      name: "Highlight-SoD-Tenant",
    }).returning();
    tenantId = tenant.id;

    const mkUser = async (prefix: string) => {
      const [u] = await db
        .insert(users)
        .values({ tenantId, email: `${prefix}-${nextId()}@hlsod-test.de` })
        .returning();
      return u.id;
    };
    admin1Id = await mkUser("admin1");
    admin2Id = await mkUser("admin2");
    admin3Id = await mkUser("admin3");
    prueferId = await mkUser("pruefer");

    const sodRegion = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    await db.insert(roles).values([
      { tenantId, userId: admin1Id, roleType: "kommune_admin", regionId: sodRegion },
      { tenantId, userId: admin2Id, roleType: "kommune_admin", regionId: sodRegion },
      { tenantId, userId: admin3Id, roleType: "kommune_admin", regionId: sodRegion },
      { tenantId, userId: prueferId, roleType: "redakteur", regionId: sodRegion },
    ]);

    const [body] = await db.insert(risBodies).values({
      tenantId,
      key: "hlsod-body",
      risType: "provox_iip",
      baseUrl: "https://hlsod.example.de",
    }).returning();
    bodyId = body.id;

    sessionAdmin1 = await makeSession(admin1Id);
    sessionAdmin2 = await makeSession(admin2Id);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  it.skipIf(SKIP)("erster Highlighter wird festgehalten; zweiter überschreibt die Spur NICHT (COALESCE)", async () => {
    const digest = await createGeprueftenDigest(2);
    const stmtId = await ersteAussage(digest.id);

    // admin1 hebt zuerst hervor → Spur = admin1.
    actAs(sessionAdmin1);
    const r1 = await setStatementHighlight(stmtId, true);
    expect(r1.ok).toBe(true);
    let spur = await highlightSpur(stmtId);
    expect(spur.hl).toBe(admin1Id);
    expect(spur.is).toBe(true);

    // admin2 setzt Highlight erneut auf dieselbe Aussage → Spur bleibt admin1.
    actAs(sessionAdmin2);
    const r2 = await setStatementHighlight(stmtId, true);
    expect(r2.ok).toBe(true);
    spur = await highlightSpur(stmtId);
    expect(spur.hl).toBe(admin1Id); // NICHT admin2 — nicht überschrieben.
    expect(spur.is).toBe(true);

    // admin2 entfernt das Highlight (istHighlight=false) → Spur bleibt persistent.
    const r3 = await setStatementHighlight(stmtId, false);
    expect(r3.ok).toBe(true);
    spur = await highlightSpur(stmtId);
    expect(spur.hl).toBe(admin1Id);
    expect(spur.is).toBe(false);

    // admin2 setzt erneut → COALESCE(admin1, admin2) bleibt admin1.
    const r4 = await setStatementHighlight(stmtId, true);
    expect(r4.ok).toBe(true);
    spur = await highlightSpur(stmtId);
    expect(spur.hl).toBe(admin1Id);
    expect(spur.is).toBe(true);
  });

  it.skipIf(SKIP)("Folge: erster Highlighter bleibt gesperrt, unbeteiligter Admin darf freigeben", async () => {
    const digest = await createGeprueftenDigest(2);
    const stmtId = await ersteAussage(digest.id);

    actAs(sessionAdmin1);
    expect((await setStatementHighlight(stmtId, true)).ok).toBe(true);
    // admin2 re-highlightet — Spur bleibt admin1.
    actAs(sessionAdmin2);
    expect((await setStatementHighlight(stmtId, true)).ok).toBe(true);
    expect((await highlightSpur(stmtId)).hl).toBe(admin1Id);

    // admin1 (der erste Highlighter) darf NICHT selbst freigeben.
    const blocked = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: admin1Id,
      callerRoleTypes: ADMIN_ROLLEN,
      allowSelfApproval: false,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Vier-Augen/);
    const [nochEntwurf] = await db
      .select({ status: digests.status })
      .from(digests)
      .where(eq(digests.id, digest.id));
    expect(nochEntwurf.status).toBe("entwurf");

    // admin3 (weder geprüft noch hervorgehoben) darf freigeben.
    const ok = await freigebenCore(db, tenantId, {
      digestId: digest.id,
      callerUserId: admin3Id,
      callerRoleTypes: ADMIN_ROLLEN,
    });
    expect(ok.ok).toBe(true);
    const [freigegeben] = await db
      .select({ status: digests.status })
      .from(digests)
      .where(eq(digests.id, digest.id));
    expect(freigegeben.status).toBe("freigegeben");
  });
});
