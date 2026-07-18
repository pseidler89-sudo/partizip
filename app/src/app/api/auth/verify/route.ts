/**
 * POST /api/auth/verify
 *
 * Löst einen Magic-Link-Token ein (atomarer CAS-Update).
 *
 * Body: { token: string }
 *
 * Race-sicher: Parallele Requests mit demselben Token →
 * genau einer gewinnt (UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()).
 *
 * Fehlerfälle:
 *   - TOKEN_INVALID: Hash nicht gefunden
 *   - TOKEN_USED: consumed_at gesetzt
 *   - TOKEN_EXPIRED: expiresAt in der Vergangenheit
 *   - FORBIDDEN: Tenant des Tokens passt nicht zum Host-Tenant
 *
 * H1: Origin-Check als Defense-in-Depth.
 * H2: force-dynamic.
 * H3: Nach erfolgreichem Verify alle übrigen unverbrauchten Tokens invalidieren.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { scopedDb } from "@/lib/db/tenant-scope";
import { authTokens, auditEvents } from "@/db/schema";
import { getTenantFromHost } from "@/lib/tenant";
import { generateRawToken, sha256Hex } from "@/lib/auth/crypto";
import { buildSessionCookieHeader } from "@/lib/auth/session";
import { apiError } from "@/lib/api-error";

// H2: Nicht cachen — Auth-Routen immer dynamisch
export const dynamic = "force-dynamic";

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? "30");

const VerifySchema = z.object({
  token: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- H1: Origin-Check (Defense-in-Depth) ---
  const originResult = checkOrigin(request);
  if (originResult) return originResult;

  // --- 1. Tenant auflösen ---
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

  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "VALIDATION_ERROR", "Token fehlt.");
  }

  const { token: rawToken } = parsed.data;
  const tokenHash = sha256Hex(rawToken);

  const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(DATABASE_URL);
  const scoped = scopedDb(db, tenant.id);

  // --- 3. Token laden (ohne Einlösung) für Fehlerdiagnose ---
  // Unscoped-Lookup zuerst: um "Token nicht vorhanden" von "Token gehört anderem Tenant" zu unterscheiden.
  // MIN3: consume() und findByHash() sind tenant-scoped — die Tenant-Prüfung hier ist Defense-in-Depth.
  const existingRows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.tokenHash, tokenHash))
    .limit(1);
  const existing = existingRows[0] ?? null;

  if (!existing) {
    await writeTokenRejectedAudit(db, tenant.id, null, "invalid");
    return apiError(400, "TOKEN_INVALID", "Dieser Link ist ungültig.");
  }

  // --- 4. Tenant-Prüfung (vor dem CAS — informiert User sinnvoll über falschen Host) ---
  if (existing.tenantId !== tenant.id) {
    await writeTokenRejectedAudit(db, tenant.id, null, "tenant_mismatch");
    return apiError(403, "FORBIDDEN", "Dieser Link ist für eine andere Gemeinde ausgestellt.");
  }

  // --- 5. Atomarer CAS-Update (race-sicher, MIN3: tenantId in WHERE) ---
  // J2b-MIN1: purpose 'login' HART gefiltert — ein 'email_change'-Token kann sich
  // hier nicht einlösen (CAS liefert null → Fallback TOKEN_INVALID unten).
  const consumed = await scoped.authTokens.consume(tokenHash, "login");

  if (!consumed) {
    // CAS gescheitert: Token entweder schon verbraucht oder abgelaufen.
    // Diagnose anhand des bereits geladenen Datensatzes.
    const now = new Date();
    if (existing.consumedAt !== null) {
      await writeTokenRejectedAudit(db, tenant.id, null, "used");
      return apiError(
        400,
        "TOKEN_USED",
        "Dieser Link wurde bereits verwendet. Bitte fordern Sie einen neuen an."
      );
    }
    if (existing.expiresAt <= now) {
      await writeTokenRejectedAudit(db, tenant.id, null, "expired");
      return apiError(
        400,
        "TOKEN_EXPIRED",
        "Dieser Link ist abgelaufen. Bitte fordern Sie einen neuen an."
      );
    }
    // Fallback (Race: parallel abgelaufen zwischen Load und CAS)
    return apiError(400, "TOKEN_INVALID", "Dieser Link ist ungültig.");
  }

  // --- 6. User-ID laden ---
  const user = await scoped.users.findByEmail(consumed.email);
  if (!user) {
    // Sollte nicht vorkommen (User wurde beim Request angelegt)
    return apiError(400, "TOKEN_INVALID", "Kein Konto zu diesem Token gefunden.");
  }

  // --- 6b. KONTO-STATUS (Block K2, Gate-B MAJOR): Sperre muss am Login wirken ---
  // Ein gesperrtes/gelöschtes Konto erhält KEINE neue Session — sonst entwertete
  // ein Magic-Link-Re-Login die IR-Sperre binnen Minuten (kontoSperrenCore
  // revoziert alle Sessions, aber ohne diesen Check wäre der Gesperrte sofort
  // wieder eingeloggt). Generische Meldung im bestehenden Token-Fehler-Vokabular
  // (kein Status-Oracle nach außen); PII-freies Audit für das IR-Lagebild.
  // Muster: invitation-core lehnt Accept bei accountStatus != 'active' bereits ab.
  if (user.accountStatus !== "active") {
    await db.insert(auditEvents).values({
      tenantId: tenant.id,
      actorType: "user",
      actorRef: user.id,
      action: "auth.login_rejected",
      metadata: { reason: "account_status" },
    });
    return apiError(400, "TOKEN_INVALID", "Dieser Link ist ungültig.");
  }

  // --- H3: Übrige unverbrauchte Tokens derselben (tenant, email) invalidieren ---
  await scoped.authTokens.invalidateOtherTokens(consumed.email, tokenHash);

  // --- 7. Session erzeugen ---
  const rawSessionToken = generateRawToken();
  const sessionTokenHash = sha256Hex(rawSessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await scoped.sessions.create({
    userId: user.id,
    tokenHash: sessionTokenHash,
    expiresAt,
  });

  // --- 8. Audit-Event (PII-frei) ---
  await db.insert(auditEvents).values({
    tenantId: tenant.id,
    actorType: "user",
    actorRef: user.id,
    action: "auth.login_succeeded",
    metadata: { tenant: tenant.slug },
  });

  // --- 9. Session-Cookie setzen ---
  const isSecure = isSecureRequest(request);
  const cookieHeader = buildSessionCookieHeader(rawSessionToken, expiresAt, isSecure);

  const response = NextResponse.json({ ok: true }, { status: 200 });
  response.headers.set("Set-Cookie", cookieHeader);
  return response;
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
  if (!originHeader) return null;

  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
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

async function writeTokenRejectedAudit(
  db: ReturnType<typeof createDb>,
  tenantId: string,
  actorRef: string | null,
  reason: "invalid" | "expired" | "used" | "tenant_mismatch"
): Promise<void> {
  await db.insert(auditEvents).values({
    tenantId,
    actorType: "user",
    actorRef,
    action: "auth.token_rejected",
    metadata: { reason },
  });
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

function isSecureRequest(request: NextRequest): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto === "https";
  return request.nextUrl.protocol === "https:";
}
