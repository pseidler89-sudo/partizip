/**
 * reverify-reminders.test.ts — Re-Verify-Erinnerung (Skalierungs-Roadmap).
 *
 * 1) buildReVerifyEmail: Inhalt/Link/Marke (ohne DB).
 * 2) getReVerifyFaellige + markReVerifyReminded: ECHTE Query gegen PG16 —
 *    Fensterlogik (im/außerhalb Fenster, abgelaufen, bereits erinnert, ohne
 *    Verifizierung, inaktiv), Tenant-Scope, Mark-verhindert-Wiederholung.
 *    Läuft NUR mit DATABASE_URL_TEST.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import {
  getReVerifyFaellige,
  markReVerifyReminded,
  buildReVerifyEmail,
} from "@/lib/verification/reverify-reminders";

const { tenants, users } = schema;

describe("buildReVerifyEmail", () => {
  it("enthält Datum, Verify-Link und Marken-Teal, ohne Drohton", () => {
    const ablaeuftAm = new Date("2026-09-01T00:00:00Z");
    const mail = buildReVerifyEmail({ verifyUrl: "https://x.de/t/verifizieren", ablaeuftAm });
    expect(mail.subject).toMatch(/läuft bald ab/i);
    expect(mail.html).toContain("https://x.de/t/verifizieren");
    expect(mail.text).toContain("https://x.de/t/verifizieren");
    expect(mail.html).toContain("#0d6a70"); // BRAND_COLOR
    expect(mail.html).toMatch(/September 2026/); // de-DE Datum
  });
});

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

const TAG = 10 * 86_400_000;

describe("getReVerifyFaellige / markReVerifyReminded (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql_ = postgres(TEST_DB_URL!, { max: 4 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("liefert nur fällige Konten (Fenster, aktiv, noch nicht erinnert), tenant-scoped", async () => {
    const [tA] = await db.insert(tenants).values({ slug: `rv-a-${Date.now()}`, name: "RV-A" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: `rv-b-${Date.now()}`, name: "RV-B" }).returning();
    const now = new Date();
    const inWindow = new Date(now.getTime() + TAG); // +10 Tage
    const outside = new Date(now.getTime() + 60 * 86_400_000); // +60 Tage
    const expired = new Date(now.getTime() - 86_400_000); // -1 Tag

    const [due] = await db
      .insert(users)
      .values({ tenantId: tA.id, email: `due-${Date.now()}@t.de`, minAgeConfirmedAt: now, residencyVerifiedUntil: inWindow })
      .returning();
    await db.insert(users).values([
      { tenantId: tA.id, email: `out-${Date.now()}@t.de`, residencyVerifiedUntil: outside }, // außerhalb Fenster
      { tenantId: tA.id, email: `exp-${Date.now()}@t.de`, residencyVerifiedUntil: expired }, // abgelaufen
      { tenantId: tA.id, email: `done-${Date.now()}@t.de`, residencyVerifiedUntil: inWindow, reverifyReminderSentAt: now }, // schon erinnert
      { tenantId: tA.id, email: `none-${Date.now()}@t.de`, residencyVerifiedUntil: null }, // nie verifiziert
      { tenantId: tA.id, email: `lock-${Date.now()}@t.de`, residencyVerifiedUntil: inWindow, accountStatus: "locked" }, // inaktiv
      { tenantId: tB.id, email: `bt-${Date.now()}@t.de`, residencyVerifiedUntil: inWindow }, // Fremd-Tenant
    ]);

    const faellig = await getReVerifyFaellige(db as never, { now, tenantId: tA.id });
    expect(faellig.map((f) => f.userId)).toEqual([due.id]);
    expect(faellig[0].tenantSlug).toBe(tA.slug);
    expect(faellig[0].email).toContain("due-");
    expect(faellig[0].ablaeuftAm.getTime()).toBe(inWindow.getTime());

    // Ohne Tenant-Filter ist der Fremd-Tenant-Fall ebenfalls fällig (2 gesamt).
    const alle = await getReVerifyFaellige(db as never, { now });
    expect(alle.length).toBe(2);

    // Nach Markierung ist das Konto nicht mehr fällig (kein Mehrfach-Versand).
    const n = await markReVerifyReminded(db as never, [due.id], now);
    expect(n).toBe(1);
    const danach = await getReVerifyFaellige(db as never, { now, tenantId: tA.id });
    expect(danach).toHaveLength(0);
  });

  it.skipIf(SKIP)("markReVerifyReminded mit leerer Liste ist ein No-op", async () => {
    expect(await markReVerifyReminded(db as never, [], new Date())).toBe(0);
  });
});
