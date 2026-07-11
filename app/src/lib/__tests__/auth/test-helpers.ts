/**
 * test-helpers.ts — Shared Helpers für Auth-Integrationstests
 *
 * Setzt voraus: DATABASE_URL_TEST gesetzt, Datenbank endet auf _test.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");

export const TEST_DB_URL = process.env.DATABASE_URL_TEST;

// Schutzgitter
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `SICHERHEITS-ABBRUCH: DATABASE_URL_TEST zeigt auf "${dbName}" — endet nicht auf _test!`
    );
  }
}

export async function createTestDb() {
  if (!TEST_DB_URL) throw new Error("DATABASE_URL_TEST nicht gesetzt");

  const resetSql = postgres(TEST_DB_URL, { max: 1 });
  await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
  await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await resetSql`CREATE SCHEMA public`;
  await resetSql.end();

  const sql = postgres(TEST_DB_URL, { max: 10 });
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder });

  return { sql, db };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
