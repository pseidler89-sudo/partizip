/**
 * rate-limit.ts — DB-basiertes Rate-Limiting für Stimmabgaben (M3)
 *
 * Verhindert massenhaftes Abstimmen über eine IP (Sybil-/Flooding-Schutz beim
 * anonymen Stimmungsbild). Spiegelt das Muster aus anliegen/rate-limit.ts:
 *   - Event IMMER vor der Entscheidung schreiben (write-then-count), damit
 *     Timing-Korrelationen vermieden werden (konsistent mit Magic-Link-Logik).
 *   - `count > MAX` blockiert (das gerade geschriebene Event zählt mit).
 *
 * Dimensionen:
 *   1. Pro IP:     max 30 Stimmen / 60 min   (scope vote_ip)
 *   2. Pro Device: max 10 Stimmen / 60 min   (scope vote_device, nur wenn Token bekannt)
 *
 * Bei Block: Audit-Event poll.rate_limited (PII-frei, nur {dimension}). Die IP
 * wird über hmacRateLimit gehasht — kein Klartext in der DB.
 */

import { and, eq, gt, count } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimitEvents, auditEvents } from "@/db/schema";
import { hmacRateLimit } from "@/lib/auth/crypto";

const IP_WINDOW_MIN = 60;
const IP_MAX = 30;
const DEVICE_WINDOW_MIN = 60;
const DEVICE_MAX = 10;

const SCOPE_IP = "vote_ip";
const SCOPE_DEVICE = "vote_device";

export type VoteRateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "ip" | "device" };

function ipKeyHash(ipAddress: string): string {
  return hmacRateLimit(`vote:ip:${ipAddress}`);
}

function deviceKeyHash(deviceToken: string): string {
  return hmacRateLimit(`vote:device:${deviceToken}`);
}

async function writeVoteRateLimitEvents(
  db: Db,
  opts: { ipAddress: string | null; deviceToken: string | null }
): Promise<void> {
  const toInsert: Array<{ scope: string; keyHash: string }> = [];
  if (opts.ipAddress) {
    toInsert.push({ scope: SCOPE_IP, keyHash: ipKeyHash(opts.ipAddress) });
  }
  if (opts.deviceToken) {
    toInsert.push({ scope: SCOPE_DEVICE, keyHash: deviceKeyHash(opts.deviceToken) });
  }
  if (toInsert.length > 0) {
    await db.insert(rateLimitEvents).values(toInsert);
  }
}

async function writeRateLimitAudit(
  db: Db,
  tenantId: string,
  actorRef: string | null,
  dimension: "ip" | "device"
): Promise<void> {
  await db.insert(auditEvents).values({
    tenantId,
    actorType: "user",
    actorRef,
    action: "poll.rate_limited",
    metadata: { dimension },
  });
}

/**
 * Prüft die Rate-Limits für eine Stimmabgabe. Schreibt erst die Events,
 * dann wird gezählt (`count > MAX` blockiert). actorRef = voter_ref (pseudonym).
 */
export async function checkVoteRateLimit(
  db: Db,
  opts: {
    tenantId: string;
    actorRef: string | null;
    ipAddress: string | null;
    deviceToken: string | null;
  }
): Promise<VoteRateLimitResult> {
  await writeVoteRateLimitEvents(db, opts);

  // IP-Limit
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
      await writeRateLimitAudit(db, opts.tenantId, opts.actorRef, "ip");
      return { allowed: false, reason: "ip" };
    }
  }

  // Device-Limit
  if (opts.deviceToken) {
    const devSince = new Date(Date.now() - DEVICE_WINDOW_MIN * 60 * 1000);
    const devRows = await db
      .select({ n: count() })
      .from(rateLimitEvents)
      .where(
        and(
          eq(rateLimitEvents.scope, SCOPE_DEVICE),
          eq(rateLimitEvents.keyHash, deviceKeyHash(opts.deviceToken)),
          gt(rateLimitEvents.createdAt, devSince)
        )
      );
    const devCount = devRows[0]?.n ?? 0;
    if (devCount > DEVICE_MAX) {
      await writeRateLimitAudit(db, opts.tenantId, opts.actorRef, "device");
      return { allowed: false, reason: "device" };
    }
  }

  return { allowed: true };
}

/** Test-Hilfe: Konstanten exportiert für deterministische Unit-Tests. */
export const VOTE_RATE_LIMITS = {
  IP_WINDOW_MIN,
  IP_MAX,
  DEVICE_WINDOW_MIN,
  DEVICE_MAX,
  SCOPE_IP,
  SCOPE_DEVICE,
} as const;
