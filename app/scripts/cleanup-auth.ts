/**
 * cleanup-auth.ts — Auth-Retention-Cleanup (M4/MIN1, ADR-008)
 *
 * Löscht abgelaufene/verbrauchte Datensätze nach Retention-Fristen:
 *   - auth_tokens:        consumed ODER expired > 24h → löschen
 *   - sessions:           expired ODER revoked > 30 Tage → löschen
 *   - rate_limit_events:  älter als 24h → löschen
 *
 * Loggt NUR Zähler (keine E-Mails, keine Hashes, keine PII).
 *
 * Ausführung: npm run db:cleanup
 * Produktion: als Cron-Job (ADR-008).
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, lt, isNotNull, or } from "drizzle-orm";
import * as schema from "../src/db/schema.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  const sql = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(sql, { schema });

  const now = new Date();
  const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d30ago = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // --- auth_tokens: consumed oder expired > 24h ---
  const deletedTokens = await db
    .delete(schema.authTokens)
    .where(
      and(
        or(
          isNotNull(schema.authTokens.consumedAt),
          lt(schema.authTokens.expiresAt, now)
        ),
        lt(schema.authTokens.createdAt, h24ago)
      )
    )
    .returning({ id: schema.authTokens.id });

  // --- sessions: expired oder revoked > 30 Tage ---
  const deletedSessions = await db
    .delete(schema.sessions)
    .where(
      and(
        or(
          lt(schema.sessions.expiresAt, now),
          isNotNull(schema.sessions.revokedAt)
        ),
        lt(schema.sessions.createdAt, d30ago)
      )
    )
    .returning({ id: schema.sessions.id });

  // --- rate_limit_events: älter als 24h ---
  const deletedRateLimitEvents = await db
    .delete(schema.rateLimitEvents)
    .where(lt(schema.rateLimitEvents.createdAt, h24ago))
    .returning({ id: schema.rateLimitEvents.id });

  // Nur Zähler loggen — kein PII
  console.log("[cleanup-auth] Ergebnis:", {
    auth_tokens_deleted: deletedTokens.length,
    sessions_deleted: deletedSessions.length,
    rate_limit_events_deleted: deletedRateLimitEvents.length,
    ran_at: now.toISOString(),
  });

  await sql.end();
}

main().catch((err) => {
  console.error("[cleanup-auth] Fehler:", err);
  process.exit(1);
});
