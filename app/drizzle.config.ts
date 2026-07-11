import { defineConfig } from "drizzle-kit";
// N7: sinnloser `import * as dotenv from "node:process"` entfernt
// DATABASE_URL kommt aus process.env — kein dotenv-Import nötig für db:generate (kein DB-Zugriff)

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "../db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://partizip:partizip@127.0.0.1:5433/partizip",
  },
  verbose: false,
  strict: false,
});
