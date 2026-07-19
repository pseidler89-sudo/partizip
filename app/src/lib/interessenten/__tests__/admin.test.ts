/**
 * admin.test.ts — DB-Integrationstests für die Betreiber-Aktionen (N3).
 *
 * Das super_admin-Gate (requireSuperAdminCtx) wird gemockt, um die echte
 * DB-Logik der Actions zu prüfen: atomarer Status-Wechsel, Hard-Delete,
 * PII-freies Audit — sowie die Ablehnung, wenn das Gate nicht ok ist.
 * Läuft NUR mit DATABASE_URL_TEST.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import type { Db } from "@/db/client";

const gate = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("@/lib/auth/action-context", () => ({
  requireSuperAdminCtx: async () => gate.current,
}));

import {
  interessentStatusSetzen,
  interessentLoeschen,
} from "@/lib/interessenten/admin-actions";

const { tenants, interessenten, auditEvents } = schema;

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

describe.skipIf(SKIP)("Interessenten-Admin-Aktionen (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;
  let tenantId: string;
  const userId = "00000000-0000-0000-0000-0000000000aa";

  async function neuerLead(email: string): Promise<string> {
    const [row] = await db
      .insert(interessenten)
      .values({ ansprechpartner: "Test Person", email, quelle: "formular" })
      .returning({ id: interessenten.id });
    return row.id;
  }

  beforeAll(async () => {
    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_) as unknown as Db;
    await migrate(db as never, { migrationsFolder });

    const [t] = await db
      .insert(tenants)
      .values({ slug: `n-admin-${Date.now()}`, name: "N-Admin-Tenant" })
      .returning();
    tenantId = t.id;

    // Standardmäßig autorisiert (super_admin).
    gate.current = { ok: true, ctx: { db, tenant: { id: tenantId, slug: t.slug }, userId } };
  });

  afterAll(async () => {
    if (sql_) await sql_.end();
  });

  it("Status-Update ist atomar und wird PII-frei auditiert", async () => {
    const id = await neuerLead("status@beispiel.de");
    const res = await interessentStatusSetzen(id, "kontaktiert");
    expect(res.ok).toBe(true);

    const rows = await db.select().from(interessenten).where(eq(interessenten.id, id));
    expect(rows[0].status).toBe("kontaktiert");

    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "interessent.status_changed"));
    const meta = JSON.stringify(audits.map((a: { metadata: unknown }) => a.metadata));
    expect(meta).toContain("kontaktiert");
    expect(meta).not.toContain("status@beispiel.de");
  });

  it("lehnt einen ungültigen Status ab", async () => {
    const id = await neuerLead("badstatus@beispiel.de");
    const res = await interessentStatusSetzen(id, "voll_daneben");
    expect(res.ok).toBe(false);
  });

  it("Hard-Delete entfernt die Zeile + PII-freies Audit", async () => {
    const id = await neuerLead("delete@beispiel.de");
    const res = await interessentLoeschen(id);
    expect(res.ok).toBe(true);

    const rows = await db.select().from(interessenten).where(eq(interessenten.id, id));
    expect(rows).toHaveLength(0);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "interessent.deleted"));
    const meta = JSON.stringify(audits.map((a: { metadata: unknown }) => a.metadata));
    expect(meta).not.toContain("delete@beispiel.de");
  });

  it("ohne Berechtigung (Gate nicht ok) → kein Zugriff, keine Änderung", async () => {
    const id = await neuerLead("gesperrt@beispiel.de");
    gate.current = { ok: false, error: "Keine Berechtigung (super_admin erforderlich)." };

    const statusRes = await interessentStatusSetzen(id, "pilot");
    expect(statusRes.ok).toBe(false);
    const delRes = await interessentLoeschen(id);
    expect(delRes.ok).toBe(false);

    // Lead unverändert vorhanden.
    const rows = await db.select().from(interessenten).where(eq(interessenten.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("neu");

    // Gate zurücksetzen für etwaige Folge-Tests.
    gate.current = { ok: true, ctx: { db, tenant: { id: tenantId, slug: "x" }, userId } };
  });
});
