/**
 * follower-recipients.test.ts — Versandfilter der Anliegen-Status-Mails (Block J2c,
 * Teil A3). ECHTE Query gegen PG16.
 *
 * Geprüft (wichtigster Test der Spec): Ein Follower mit Opt-out
 * (notify_anliegen_updates=false) erhält KEINE Status-Mail; mit Opt-in schon.
 * Zusätzlich die Hygiene-Parität: gelöschte/anonymisierte Tombstones und
 * @demo.invalid-Adressen sind ausgeschlossen (kein Bounce-Versand).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { getAnliegenFollowerEmails } from "@/lib/anliegen/follower-recipients";

const { tenants, users, anliegen, anliegenFollowers } = schema;

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

describe("getAnliegenFollowerEmails (Integration, Versandfilter)", () => {
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

  it.skipIf(SKIP)("nur Opt-in-Follower mit zustellbarer, aktiver Adresse", async () => {
    const [t] = await db.insert(tenants).values({ slug: `fr-${Date.now()}`, name: "FR" }).returning();
    const now = new Date();

    const [a] = await db
      .insert(anliegen)
      .values({ tenantId: t.id, trackingCode: `FR-${Date.now()}`, creatorRef: "ref", titel: "Testanliegen" })
      .returning();

    // Fünf Follower mit unterschiedlichen Merkmalen.
    const [optin] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `optin-${Date.now()}@t.de`, notifyAnliegenUpdates: true })
      .returning();
    const [optout] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `optout-${Date.now()}@t.de`, notifyAnliegenUpdates: false })
      .returning();
    const [deleted] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `del-${Date.now()}@t.de`, notifyAnliegenUpdates: true, deletedAt: now })
      .returning();
    const [tombstone] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `geloescht-y@deleted.invalid`, notifyAnliegenUpdates: true })
      .returning();
    const [demo] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `demo-${Date.now()}@demo.invalid`, notifyAnliegenUpdates: true })
      .returning();

    for (const u of [optin, optout, deleted, tombstone, demo]) {
      await db.insert(anliegenFollowers).values({ anliegenId: a.id, userId: u.id });
    }

    const emails = await getAnliegenFollowerEmails(db as never, a.id);
    expect(emails).toEqual([optin.email]);
  });
});
