/**
 * Migrations-Runner: wendet alle ausstehenden Drizzle-Migrationen an.
 * Verwendung: npm run db:migrate
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../db/migrations");

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  console.log("Running migrations from:", migrationsFolder);
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  await migrate(db, { migrationsFolder });
  console.log("Migrations completed.");
  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
