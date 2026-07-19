/**
 * formular.test.ts — DB-Integrationstests für den Formular-Lead-Kern (N1,
 * verarbeiteFormularLead). Läuft NUR mit DATABASE_URL_TEST (echte PG16).
 *
 * Deckt: gültiger Lead → Insert + Mail (Mock) + PII-freies Audit; Rate-Limit
 * (IP-Scope) greift → kein Insert; Demo-Tenant → kein Lead/keine Mail.
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
import { verarbeiteFormularLead } from "@/lib/interessenten/formular";
import { INTERESSENT_RATE_LIMITS } from "@/lib/interessenten/core";

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

function gueltigeDaten(email = "erika@beispiel.de") {
  return {
    ansprechpartner: "Erika Muster",
    email,
    kommune: "Musterstadt",
    rolle: undefined,
    groesse: undefined,
    nachricht: "Interesse.",
  };
}

describe.skipIf(SKIP)("verarbeiteFormularLead (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;
  let tenantId: string;

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
      .values({ slug: `n-form-${Date.now()}`, name: "N-Formular-Tenant" })
      .returning();
    tenantId = t.id;
  });

  afterAll(async () => {
    if (sql_) await sql_.end();
    delete process.env.DEMO_TENANT_SLUG;
  });

  it("gültiger Lead → Insert (quelle=formular) + Mail + PII-freies Audit", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await verarbeiteFormularLead(db, {
      tenantId,
      tenantSlug: "pilot",
      data: gueltigeDaten("neu@beispiel.de"),
      ipAddress: "203.0.113.9",
      notify,
    });
    expect(res.gespeichert).toBe(true);
    expect(notify).toHaveBeenCalledOnce();

    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.email, "neu@beispiel.de"));
    expect(rows).toHaveLength(1);
    expect(rows[0].quelle).toBe("formular");
    expect(rows[0].status).toBe("neu");

    // Audit PII-frei: nur { quelle }, KEIN Name/E-Mail/Nachricht.
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "interessent.created"));
    expect(audits.length).toBeGreaterThan(0);
    const meta = JSON.stringify(audits.map((a: { metadata: unknown }) => a.metadata));
    expect(meta).toContain("formular");
    expect(meta).not.toContain("neu@beispiel.de");
    expect(meta).not.toContain("Erika");
  });

  it("Demo-Tenant → kein Lead, keine Mail (fail-closed)", async () => {
    process.env.DEMO_TENANT_SLUG = "demo";
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await verarbeiteFormularLead(db, {
      tenantId,
      tenantSlug: "demo",
      data: gueltigeDaten("demo-lead@beispiel.de"),
      ipAddress: "203.0.113.10",
      notify,
    });
    expect(res.gespeichert).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.email, "demo-lead@beispiel.de"));
    expect(rows).toHaveLength(0);
    delete process.env.DEMO_TENANT_SLUG;
  });

  it("IP-Rate-Limit greift → kein weiterer Lead", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const ip = "198.51.100.7";
    // IP_MAX Leads gehen durch (count > MAX blockiert, das Event zählt mit).
    for (let i = 0; i < INTERESSENT_RATE_LIMITS.IP_MAX; i++) {
      const r = await verarbeiteFormularLead(db, {
        tenantId,
        tenantSlug: "pilot",
        // je Iteration andere E-Mail, damit NUR das IP-Limit greift (nicht E-Mail-Limit)
        data: gueltigeDaten(`rl-${i}@beispiel.de`),
        ipAddress: ip,
        notify,
      });
      expect(r.gespeichert).toBe(true);
    }
    // Der nächste Versuch überschreitet das IP-Limit → neutral, kein Insert.
    const blocked = await verarbeiteFormularLead(db, {
      tenantId,
      tenantSlug: "pilot",
      data: gueltigeDaten("rl-final@beispiel.de"),
      ipAddress: ip,
      notify,
    });
    expect(blocked.gespeichert).toBe(false);
    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.email, "rl-final@beispiel.de"));
    expect(rows).toHaveLength(0);

    // Rate-Limit-Block wird PII-frei auditiert.
    const rlAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "interessent.rate_limited"));
    expect(rlAudits.length).toBeGreaterThan(0);
  });

  it("ohne IP (No-IP-Sammel-Bucket) greift das IP-Limit trotz rotierender E-Mails", async () => {
    // Gate-B FIX 2/5: fehlt x-forwarded-for (ipAddress null), teilen sich ALLE
    // No-IP-Requests EIN IP-Budget. Rotierende E-Mails umgehen das nicht mehr.
    const notify = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < INTERESSENT_RATE_LIMITS.IP_MAX; i++) {
      const r = await verarbeiteFormularLead(db, {
        tenantId,
        tenantSlug: "pilot",
        data: gueltigeDaten(`noip-${i}@beispiel.de`), // je Iteration andere E-Mail
        ipAddress: null,
        notify,
      });
      expect(r.gespeichert).toBe(true);
    }
    // Nächster No-IP-Request mit NEUER E-Mail → vom gemeinsamen IP-Bucket geblockt.
    const blocked = await verarbeiteFormularLead(db, {
      tenantId,
      tenantSlug: "pilot",
      data: gueltigeDaten("noip-final@beispiel.de"),
      ipAddress: null,
      notify,
    });
    expect(blocked.gespeichert).toBe(false);
    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.email, "noip-final@beispiel.de"));
    expect(rows).toHaveLength(0);
  });
});
