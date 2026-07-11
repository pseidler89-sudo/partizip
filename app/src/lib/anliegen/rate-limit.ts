/**
 * rate-limit.ts — DB-basiertes Rate-Limiting für createAnliegen (H2a)
 *
 * Verhindert Missbrauch der Anliegen-Erstellung (Spam/Flooding).
 *
 * Zwei Dimensionen (beide IMMER vor der Entscheidung geschrieben, damit
 * Timing-Korrelationen zwischen Schreiben und Prüfen vermieden werden — wie
 * bei der bestehenden Magic-Link-Rate-Limit-Logik in src/lib/auth/rate-limit.ts):
 *
 *   1. Pro (tenant, user): max 5 Anliegen in 60 min
 *      key_hash = HMAC(salt, 'anliegen:' + tenantId + ':' + userId)
 *   2. Pro IP: max 15 Anliegen in 60 min (nur wenn IP bekannt)
 *      key_hash = HMAC(salt, ip)
 *
 * Zähl-Semantik konsistent zur bestehenden Logik: erst Event schreiben, dann
 * zählen; `count > MAX` blockiert (das gerade geschriebene Event zählt mit).
 *
 * Bei Block: Audit-Event anliegen.rate_limited (PII-frei, nur {dimension}).
 *
 * DETERMINISTISCH TESTBAR: Zählung ausschließlich über rate_limit_events.
 */

import { and, eq, gt, count } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimitEvents, auditEvents } from "@/db/schema";
import { hmacRateLimit } from "@/lib/auth/crypto";

const USER_WINDOW_MIN = 60;
const USER_MAX = 5;
const IP_WINDOW_MIN = 60;
const IP_MAX = 15;

const SCOPE_USER = "anliegen_user";
const SCOPE_IP = "anliegen_ip";

export type AnliegenRateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "user" | "ip" };

function userKeyHash(tenantId: string, userId: string): string {
  return hmacRateLimit(`anliegen:${tenantId}:${userId}`);
}

function ipKeyHash(ipAddress: string): string {
  return hmacRateLimit(ipAddress);
}

/**
 * Schreibt Rate-Limit-Events für die Anliegen-Erstellung (user-Scope immer,
 * ip-Scope nur wenn IP bekannt). Wird VOR der Limit-Prüfung aufgerufen.
 */
async function writeAnliegenRateLimitEvents(
  db: Db,
  opts: { tenantId: string; userId: string; ipAddress: string | null }
): Promise<void> {
  const toInsert: Array<{ scope: string; keyHash: string }> = [
    { scope: SCOPE_USER, keyHash: userKeyHash(opts.tenantId, opts.userId) },
  ];
  if (opts.ipAddress) {
    toInsert.push({ scope: SCOPE_IP, keyHash: ipKeyHash(opts.ipAddress) });
  }
  await db.insert(rateLimitEvents).values(toInsert);
}

async function writeRateLimitAudit(
  db: Db,
  tenantId: string,
  actorRef: string | null,
  dimension: "user" | "ip"
): Promise<void> {
  await db.insert(auditEvents).values({
    tenantId,
    actorType: "user",
    actorRef,
    action: "anliegen.rate_limited",
    metadata: { dimension },
  });
}

/**
 * Prüft die Rate-Limits für eine Anliegen-Erstellung.
 *
 * Schreibt erst beide Events, dann wird gezählt (`count > MAX` blockiert,
 * konsistent zur bestehenden Magic-Link-Logik). Bei Block: Audit-Event.
 */
export async function checkAnliegenRateLimit(
  db: Db,
  opts: { tenantId: string; userId: string; ipAddress: string | null }
): Promise<AnliegenRateLimitResult> {
  // 1. Events schreiben (vor der Entscheidung)
  await writeAnliegenRateLimitEvents(db, opts);

  // 2. User-Limit
  const userSince = new Date(Date.now() - USER_WINDOW_MIN * 60 * 1000);
  const userRows = await db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.scope, SCOPE_USER),
        eq(rateLimitEvents.keyHash, userKeyHash(opts.tenantId, opts.userId)),
        gt(rateLimitEvents.createdAt, userSince)
      )
    );
  const userCount = userRows[0]?.n ?? 0;
  if (userCount > USER_MAX) {
    await writeRateLimitAudit(db, opts.tenantId, opts.userId, "user");
    return { allowed: false, reason: "user" };
  }

  // 3. IP-Limit (nur wenn IP bekannt)
  if (opts.ipAddress) {
    const ipSince = new Date(Date.now() - IP_WINDOW_MIN * 60 * 1000);
    const ipRows = await db
      .select({ n: count() })
      .from(rateLimitEvents)
      .where(
        and(
          eq(rateLimitEvents.scope, SCOPE_IP),
          eq(rateLimitEvents.keyHash, ipKeyHash(opts.ipAddress)),
          gt(rateLimitEvents.createdAt, ipSince)
        )
      );
    const ipCount = ipRows[0]?.n ?? 0;
    if (ipCount > IP_MAX) {
      await writeRateLimitAudit(db, opts.tenantId, opts.userId, "ip");
      return { allowed: false, reason: "ip" };
    }
  }

  return { allowed: true };
}

/** Test-Hilfe: Konstanten exportiert für deterministische Unit-Tests. */
export const ANLIEGEN_RATE_LIMITS = {
  USER_WINDOW_MIN,
  USER_MAX,
  IP_WINDOW_MIN,
  IP_MAX,
  SCOPE_USER,
  SCOPE_IP,
} as const;
