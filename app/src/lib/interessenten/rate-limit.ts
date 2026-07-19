/**
 * interessenten/rate-limit.ts — DB-basiertes Rate-Limiting für den öffentlichen
 * Interessenten-Lead (Block N1). Muster: lib/anliegen/rate-limit.ts.
 *
 * Eigene Scopes (getrennt von Login/Anliegen), damit sich die Budgets nicht
 * gegenseitig verbrauchen. Konservativ, weil das Lead-Formular niederfrequent ist:
 *   - IP:    5 / 60 min  (Spam-Bremse)
 *   - E-Mail: 3 / 60 min (kanonische Adresse, gehasht — nie Klartext)
 *
 * FEHLENDE IP (Gate-B): Kommt KEINE vertrauenswürdige Client-IP an (x-forwarded-for
 * fehlt/nicht parsebar → ipAddress null), wird die IP-Dimension NICHT still
 * übersprungen (sonst bliebe nur das schwache E-Mail-Limit, per Adress-Rotation
 * umgehbar). Stattdessen teilen sich ALLE No-IP-Requests EINEN gemeinsamen
 * Sammel-Bucket (fester Schlüssel) — rotierende E-Mails laufen so gemeinsam gegen
 * das IP-Budget und werden geblockt.
 *
 * Der Rate-Limit-Kontext läuft über den host-aufgelösten (Pilot-)Tenant: die
 * /mitmachen-Seite HAT einen Tenant über den Host, auch wenn der Lead selbst
 * tenant-frei gespeichert wird. tenantId geht in den E-Mail-HMAC ein (wie beim
 * Login), die IP-Dimension bleibt tenant-übergreifend (ein Bot rotiert nicht
 * über Tenants).
 *
 * Beide Events werden IMMER VOR der Prüfung geschrieben (Timing-Korrelation
 * vermeiden). Bei Block: neutrale Erfolgsmeldung nach außen (kein Oracle,
 * kein Spam-Feedback) — das entscheidet der Aufrufer.
 *
 * DETERMINISTISCH TESTBAR: Zählung ausschließlich über rate_limit_events.
 */

import { and, eq, gt, count } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimitEvents, auditEvents } from "@/db/schema";
import { hmacRateLimit } from "@/lib/auth/crypto";
import { normalizeEmail } from "@/lib/auth/email";
import {
  INTERESSENT_SCOPE_IP,
  INTERESSENT_SCOPE_EMAIL,
  INTERESSENT_RATE_LIMITS,
} from "./core";

export type InteressentRateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "ip" | "email" };

function emailKeyHash(tenantId: string, email: string): string {
  return hmacRateLimit(`interessent:${tenantId}:${normalizeEmail(email)}`);
}

/**
 * Bucket-Schlüssel der IP-Dimension. Bei fehlender IP (null) ein FESTER
 * Sammel-Bucket ("noip:") statt Überspringen — alle No-IP-Requests teilen sich
 * so EIN gemeinsames IP-Budget. Der "noip:"-Präfix trennt den Sammel-Bucket
 * sauber von echten IP-Adressen (die diese Form nie annehmen).
 */
function ipKeyHash(ip: string | null): string {
  const bucket = ip ?? "noip:no-forwarded-for";
  return hmacRateLimit(`interessent-ip:${bucket}`);
}

/**
 * Schreibt die Rate-Limit-Events (E-Mail immer; IP-Dimension IMMER — bei
 * fehlender IP über den festen No-IP-Sammel-Bucket). VOR der Prüfung aufrufen.
 */
export async function writeInteressentRateLimitEvents(
  db: Db,
  opts: { tenantId: string; email: string; ipAddress: string | null }
): Promise<void> {
  const toInsert: Array<{ scope: string; keyHash: string }> = [
    { scope: INTERESSENT_SCOPE_EMAIL, keyHash: emailKeyHash(opts.tenantId, opts.email) },
    { scope: INTERESSENT_SCOPE_IP, keyHash: ipKeyHash(opts.ipAddress) },
  ];
  await db.insert(rateLimitEvents).values(toInsert);
}

async function writeAudit(
  db: Db,
  tenantId: string,
  dimension: "ip" | "email"
): Promise<void> {
  await db.insert(auditEvents).values({
    tenantId,
    actorType: "system",
    actorRef: null,
    action: "interessent.rate_limited",
    metadata: { dimension },
  });
}

/**
 * Prüft die Limits. Schreibt erst die Events, dann wird gezählt
 * (`count > MAX` blockiert — das gerade geschriebene Event zählt mit).
 * Bei Block: PII-freies Audit-Event.
 */
export async function checkInteressentRateLimit(
  db: Db,
  opts: { tenantId: string; email: string; ipAddress: string | null }
): Promise<InteressentRateLimitResult> {
  await writeInteressentRateLimitEvents(db, opts);

  // IP-Limit zuerst (grobes Netz gegen Bots), dann E-Mail. Die IP-Dimension
  // wird IMMER geprüft — bei fehlender IP über den festen No-IP-Sammel-Bucket
  // (kein stiller Bypass per E-Mail-Rotation).
  const ipSince = new Date(
    Date.now() - INTERESSENT_RATE_LIMITS.IP_WINDOW_MIN * 60 * 1000
  );
  const ipRows = await db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.scope, INTERESSENT_SCOPE_IP),
        eq(rateLimitEvents.keyHash, ipKeyHash(opts.ipAddress)),
        gt(rateLimitEvents.createdAt, ipSince)
      )
    );
  if ((ipRows[0]?.n ?? 0) > INTERESSENT_RATE_LIMITS.IP_MAX) {
    await writeAudit(db, opts.tenantId, "ip");
    return { allowed: false, reason: "ip" };
  }

  const emailSince = new Date(
    Date.now() - INTERESSENT_RATE_LIMITS.EMAIL_WINDOW_MIN * 60 * 1000
  );
  const emailRows = await db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.scope, INTERESSENT_SCOPE_EMAIL),
        eq(rateLimitEvents.keyHash, emailKeyHash(opts.tenantId, opts.email)),
        gt(rateLimitEvents.createdAt, emailSince)
      )
    );
  if ((emailRows[0]?.n ?? 0) > INTERESSENT_RATE_LIMITS.EMAIL_MAX) {
    await writeAudit(db, opts.tenantId, "email");
    return { allowed: false, reason: "email" };
  }

  return { allowed: true };
}
