/**
 * rate-limit.ts — Leichtes IP-Rate-Limit gegen Einlöse-Spam (ADR-014 Block 2).
 *
 * NICHT kritisch (der Token ist CSPRNG und nicht erratbar) — dies ist nur ein
 * Dämpfer gegen massenhafte Einlöse-Versuche über eine IP. Spiegelt das Muster
 * aus polls/rate-limit.ts: Event IMMER vor der Entscheidung schreiben
 * (write-then-count), `count > MAX` blockiert; IP wird via hmacRateLimit gehasht
 * (kein Klartext in der DB).
 */

import { and, eq, gt, count } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimitEvents, auditEvents } from "@/db/schema";
import { hmacRateLimit } from "@/lib/auth/crypto";

const IP_WINDOW_MIN = 60;
const IP_MAX = 60; // großzügig — Token unguessbar, nur Spam-Dämpfer
const SCOPE_IP = "qr_redeem_ip";

export type QrRateLimitResult = { allowed: true } | { allowed: false };

function ipKeyHash(ipAddress: string): string {
  return hmacRateLimit(`qr:ip:${ipAddress}`);
}

/**
 * Prüft das IP-Rate-Limit für eine Einlösung. Ohne IP → immer erlaubt.
 */
export async function checkQrRedeemRateLimit(
  db: Db,
  opts: { tenantId: string; ipAddress: string | null },
): Promise<QrRateLimitResult> {
  if (!opts.ipAddress) return { allowed: true };

  await db.insert(rateLimitEvents).values({
    scope: SCOPE_IP,
    keyHash: ipKeyHash(opts.ipAddress),
  });

  const since = new Date(Date.now() - IP_WINDOW_MIN * 60 * 1000);
  const rows = await db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.scope, SCOPE_IP),
        eq(rateLimitEvents.keyHash, ipKeyHash(opts.ipAddress)),
        gt(rateLimitEvents.createdAt, since),
      ),
    );

  if ((rows[0]?.n ?? 0) > IP_MAX) {
    await db.insert(auditEvents).values({
      tenantId: opts.tenantId,
      actorType: "user",
      actorRef: null,
      action: "qr.rate_limited",
      metadata: { dimension: "ip" },
    });
    return { allowed: false };
  }

  return { allowed: true };
}

export const QR_RATE_LIMITS = { IP_WINDOW_MIN, IP_MAX, SCOPE_IP } as const;

// ---------------------------------------------------------------------------
// Konto-QR (V3): eigener Rate-Limit-Scope für das Erzeugen eines Konto-Belegs.
// Verhindert, dass ein eingeloggtes Konto in kurzer Zeit sehr viele Belege
// erzeugt (Audit-/DB-Spam) — die Belege sind ohnehin einzeln kurzlebig und
// jeweils invalidieren sie den Vorgänger. Bewusst eng, aber alltagstauglich.
// ---------------------------------------------------------------------------

const PROOF_WINDOW_MIN = 60;
const PROOF_MAX = 30; // 30 Neu-Erzeugungen/Stunde/IP — genug fürs echte „neu erzeugen"
const SCOPE_PROOF_IP = "proof_create_ip";

function proofIpKeyHash(ipAddress: string): string {
  return hmacRateLimit(`proof:ip:${ipAddress}`);
}

/**
 * Prüft das IP-Rate-Limit für das Erzeugen eines Konto-QR-Belegs (V3). Ohne IP
 * → immer erlaubt (write-then-count, wie checkQrRedeemRateLimit).
 */
export async function checkProofCreateRateLimit(
  db: Db,
  opts: { tenantId: string; ipAddress: string | null },
): Promise<QrRateLimitResult> {
  if (!opts.ipAddress) return { allowed: true };

  await db.insert(rateLimitEvents).values({
    scope: SCOPE_PROOF_IP,
    keyHash: proofIpKeyHash(opts.ipAddress),
  });

  const since = new Date(Date.now() - PROOF_WINDOW_MIN * 60 * 1000);
  const rows = await db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.scope, SCOPE_PROOF_IP),
        eq(rateLimitEvents.keyHash, proofIpKeyHash(opts.ipAddress)),
        gt(rateLimitEvents.createdAt, since),
      ),
    );

  if ((rows[0]?.n ?? 0) > PROOF_MAX) {
    await db.insert(auditEvents).values({
      tenantId: opts.tenantId,
      actorType: "user",
      actorRef: null,
      action: "proof.rate_limited",
      metadata: { dimension: "ip" },
    });
    return { allowed: false };
  }

  return { allowed: true };
}

export const PROOF_RATE_LIMITS = {
  PROOF_WINDOW_MIN,
  PROOF_MAX,
  SCOPE_PROOF_IP,
} as const;
