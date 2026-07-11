/**
 * POST /api/auth/request
 *
 * Fordert einen Magic-Link an. Immer HTTP 200 nach außen (kein Enumeration-Leak).
 *
 * Body: { email: string, minAgeConfirmed?: boolean }
 *
 * Flow (B1 — einheitlicher Pfad):
 *   1. Tenant auflösen, Input validieren
 *   2. Client-IP bestimmen (letztes Element von x-forwarded-for)
 *   3. Rate-Limit-Events für BEIDE Scopes schreiben (immer, vor Entscheidung)
 *   4. Rate-Limits prüfen → bei Überschreitung: audit + neutrale 200, kein Mail
 *   5. Verzweigung:
 *      a) User existiert         → Token + Magic-Link-Mail
 *      b) kein User + minAge     → User anlegen + Token + Mail
 *      c) kein User ohne minAge  → Hinweis-Mail (jetzt rate-limitiert)
 *      In jedem Zweig: Token-Bytes generieren+hashen (im Hinweis-Zweig verwerfen)
 *      → Timing-Oracle schrumpft
 *
 * H1: Origin-Check als Defense-in-Depth.
 * H2: force-dynamic.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createDb } from "@/db/client";
import { scopedDb } from "@/lib/db/tenant-scope";
import { getTenantFromHost } from "@/lib/tenant";
import { generateRawToken, sha256Hex, hashIp } from "@/lib/auth/crypto";
import { writeRateLimitEvents, checkRateLimit } from "@/lib/auth/rate-limit";
import { sendMagicLinkEmail, sendRegistrationHintEmail } from "@/lib/auth/mail";
import { apiError } from "@/lib/api-error";
import { clientIpFromForwardedFor } from "@/lib/client-ip";
import { auditEvents } from "@/db/schema";

// H2: Nicht cachen — Auth-Routen immer dynamisch
export const dynamic = "force-dynamic";

const MAGIC_LINK_TTL_MIN = Number(process.env.MAGIC_LINK_TTL_MIN ?? "15");

const RequestSchema = z.object({
  email: z.string().email(),
  minAgeConfirmed: z.boolean().optional(),
});

function neutralResponse() {
  return NextResponse.json(
    { ok: true, message: "Falls eine Registrierung möglich ist, erhalten Sie in Kürze eine E-Mail." },
    { status: 200 }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- H1: Origin-Check (Defense-in-Depth) ---
  const originResult = checkOrigin(request);
  if (originResult) return originResult;

  // --- 1. Host-Header lesen (testbar via x-test-host in dev/test) ---
  const host = getEffectiveHost(request);

  const tenant = await getTenantFromHost(host);
  if (!tenant) {
    return apiError(404, "TENANT_NOT_FOUND", "Diese Kommune ist auf Partizip nicht registriert.");
  }

  // --- 2. Body-Validierung ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "VALIDATION_ERROR", "Ungültiger JSON-Body.");
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "VALIDATION_ERROR", "Ungültige Eingabe.");
  }

  const { email, minAgeConfirmed } = parsed.data;

  // --- Client-IP bestimmen ---
  // Annahme: genau ein vertrauenswürdiger Proxy (z. B. Traefik) hängt an.
  // Das LETZTE Element von x-forwarded-for ist vom eigenen Proxy angehängt → vertrauenswürdig.
  const ipAddress = getClientIp(request);

  const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(DATABASE_URL);
  const scoped = scopedDb(db, tenant.id);

  // --- 3. Rate-Limit-Events IMMER schreiben (vor der Entscheidung) ---
  await writeRateLimitEvents(db, { tenantId: tenant.id, email, ipAddress });

  // --- 4. Rate-Limits prüfen ---
  // User vorab laden um actorRef zu kennen (nur für Audit)
  const existingUser = await scoped.users.findByEmail(email);
  const actorRef: string | null = existingUser?.id ?? null;

  const rateLimitResult = await checkRateLimit(db, {
    tenantId: tenant.id,
    email,
    ipAddress,
    actorRef,
  });

  if (!rateLimitResult.allowed) {
    // Audit schreiben (bereits in checkRateLimit), neutrale Antwort, kein Mailversand
    return neutralResponse();
  }

  // --- 5a/5b/5c: Token generieren (in allen Zweigen für Timing-Angleichung) ---
  const rawToken = generateRawToken();
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);

  // --- 5. Verzweigung: User-Zustand ---
  if (!existingUser) {
    if (minAgeConfirmed === true) {
      // 5b: Neuen User anlegen + Token + Mail
      const user = await scoped.users.create(email, new Date());

      await scoped.authTokens.create({ email, tokenHash, expiresAt });

      const proto = isSecureRequest(request) ? "https" : "http";
      const magicLinkUrl = `${proto}://${host}/auth/verify?token=${rawToken}`;
      await sendMagicLinkEmail(email, magicLinkUrl);

      await db.insert(auditEvents).values({
        tenantId: tenant.id,
        actorType: "user",
        actorRef: user.id,
        action: "auth.magic_link_requested",
        // N3: Mindestalter-Selbsterklärung beim Anlegen festhalten (PII-frei)
        metadata: { tenant: tenant.slug, registration: true, minAgeConfirmed: true },
        ipHash: ipAddress ? hashIp(ipAddress) : null,
      });
    } else {
      // 5c: Kein User, keine minAge-Bestätigung → Hinweis-Mail (jetzt rate-limitiert)
      // Token wurde generiert (oben) aber nicht gespeichert → Timing-Angleichung
      await sendRegistrationHintEmail(email);
      // Kein Audit-Event für nicht-existierende User (kein actor_ref ohne PII)
    }
  } else {
    // 5a: User existiert → Token + Magic-Link-Mail
    await scoped.authTokens.create({ email, tokenHash, expiresAt });

    const proto = isSecureRequest(request) ? "https" : "http";
    const magicLinkUrl = `${proto}://${host}/auth/verify?token=${rawToken}`;
    await sendMagicLinkEmail(email, magicLinkUrl);

    await db.insert(auditEvents).values({
      tenantId: tenant.id,
      actorType: "user",
      actorRef: existingUser.id,
      action: "auth.magic_link_requested",
      metadata: { tenant: tenant.slug },
      ipHash: ipAddress ? hashIp(ipAddress) : null,
    });
  }

  return neutralResponse();
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * H1: Origin-Check als Defense-in-Depth.
 * Wenn Origin-Header vorhanden und dessen Host ≠ Request-Host → 403.
 */
function checkOrigin(request: NextRequest): NextResponse | null {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return null; // kein Origin → kein Check (direkte Server-zu-Server-Anfragen)

  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    // Ungültiger Origin-Header → ablehnen
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Ungültiger Origin-Header." } },
      { status: 403 }
    );
  }

  const requestHost = request.headers.get("host") ?? "";
  if (originHost !== requestHost) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Cross-Origin-Request abgelehnt." } },
      { status: 403 }
    );
  }

  return null;
}

function getEffectiveHost(request: NextRequest): string {
  const allowOverride =
    process.env.NODE_ENV === "test" ||
    process.env.ALLOW_TEST_HOST_OVERRIDE === "1";

  if (allowOverride) {
    const testHost = request.headers.get("x-test-host");
    if (testHost) return testHost;
  }

  return request.headers.get("host") ?? "localhost";
}

/**
 * Letztes Element von x-forwarded-for (vom eigenen Proxy angehängt) —
 * gemeinsame Semantik für alle IP-Konsumenten, siehe lib/client-ip.ts.
 */
function getClientIp(request: NextRequest): string | null {
  return clientIpFromForwardedFor(request.headers.get("x-forwarded-for"));
}

function isSecureRequest(request: NextRequest): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto === "https";
  return request.nextUrl.protocol === "https:";
}
