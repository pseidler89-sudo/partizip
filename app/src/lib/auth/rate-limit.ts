/**
 * rate-limit.ts — DB-basiertes Rate-Limiting für Magic-Link-Requests (B1/M1/M3)
 *
 * Zwei Dimensionen:
 *   1. Pro (tenant, email): max 3 Requests in 15 min
 *      key_hash = HMAC(salt, tenantId + ':' + email)
 *   2. Pro IP: max 10 Requests in 15 min
 *      key_hash = HMAC(salt, ip)
 *
 * Beide Scopes werden IMMER geschrieben (vor der Entscheidung), damit
 * Timing-Korrelationen zwischen Schreiben und Prüfen vermieden werden.
 *
 * SICHERHEITS-DESIGN:
 *   - Bei Überschreitung: kein Fehler nach außen (kein Oracle-Leak)
 *   - Intern: audit_event auth.rate_limited
 *   - key_hash: HMAC-SHA-256 mit IP_HASH_SALT — kein Klartext gespeichert
 *
 * DETERMINISTISCH TESTBAR: Zählung ausschließlich über rate_limit_events.
 */

import { and, eq, gt, count } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimitEvents, auditEvents } from "@/db/schema";
import { hmacRateLimit } from "./crypto";
import { normalizeEmail } from "./email";

const EMAIL_WINDOW_MIN = 15;
const EMAIL_MAX_REQUESTS = 3;
const IP_WINDOW_MIN = 15;
const IP_MAX_REQUESTS = 10;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "email" | "ip" };

/**
 * Schreibt Rate-Limit-Events für BEIDE Scopes (email und ip).
 * Wird VOR der Limit-Prüfung aufgerufen.
 */
export async function writeRateLimitEvents(
  db: Db,
  opts: {
    tenantId: string;
    email: string;
    ipAddress: string | null;
  }
): Promise<void> {
  // J2a: E-Mail kanonisch VOR dem HMAC — sonst bekämen Case-Varianten
  // (a@x.de vs. A@x.de) getrennte Budgets (Rate-Limit-Bypass).
  const emailKeyHash = hmacRateLimit(`${opts.tenantId}:${normalizeEmail(opts.email)}`);
  const toInsert: Array<{ scope: string; keyHash: string }> = [
    { scope: "email", keyHash: emailKeyHash },
  ];

  if (opts.ipAddress) {
    const ipKeyHash = hmacRateLimit(opts.ipAddress);
    toInsert.push({ scope: "ip", keyHash: ipKeyHash });
  }

  await db.insert(rateLimitEvents).values(toInsert);
}

/**
 * Prüft Rate-Limits für einen Magic-Link-Request.
 * Schreibt bei Überschreitung ein Audit-Event (PII-frei).
 *
 * Muss NACH writeRateLimitEvents aufgerufen werden.
 */
export async function checkRateLimit(
  db: Db,
  opts: {
    tenantId: string;
    email: string;
    ipAddress: string | null;
    actorRef: string | null; // user-id falls bekannt, sonst null
  }
): Promise<RateLimitResult> {
  // --- 1. Email-Rate-Limit (kanonische E-Mail, s. writeRateLimitEvents) ---
  const emailKeyHash = hmacRateLimit(`${opts.tenantId}:${normalizeEmail(opts.email)}`);
  const emailSince = new Date(Date.now() - EMAIL_WINDOW_MIN * 60 * 1000);

  const emailRows = await db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.scope, "email"),
        eq(rateLimitEvents.keyHash, emailKeyHash),
        gt(rateLimitEvents.createdAt, emailSince)
      )
    );
  const emailCount = emailRows[0]?.n ?? 0;

  if (emailCount > EMAIL_MAX_REQUESTS) {
    await writeRateLimitAudit(db, opts.tenantId, opts.actorRef, "email");
    return { allowed: false, reason: "email" };
  }

  // --- 2. IP-Rate-Limit (nur wenn IP bekannt) ---
  if (opts.ipAddress) {
    const ipKeyHash = hmacRateLimit(opts.ipAddress);
    const ipSince = new Date(Date.now() - IP_WINDOW_MIN * 60 * 1000);

    const ipRows = await db
      .select({ n: count() })
      .from(rateLimitEvents)
      .where(
        and(
          eq(rateLimitEvents.scope, "ip"),
          eq(rateLimitEvents.keyHash, ipKeyHash),
          gt(rateLimitEvents.createdAt, ipSince)
        )
      );
    const ipCount = ipRows[0]?.n ?? 0;

    if (ipCount > IP_MAX_REQUESTS) {
      await writeRateLimitAudit(db, opts.tenantId, opts.actorRef, "ip");
      return { allowed: false, reason: "ip" };
    }
  }

  return { allowed: true };
}

async function writeRateLimitAudit(
  db: Db,
  tenantId: string,
  actorRef: string | null,
  dimension: "email" | "ip"
): Promise<void> {
  await db.insert(auditEvents).values({
    tenantId,
    actorType: "user",
    actorRef,
    action: "auth.rate_limited",
    metadata: { dimension },
  });
}
