/**
 * POST /api/auth/logout
 *
 * Revoziert die aktuelle Session und löscht den Cookie.
 *
 * H1: Origin-Check als Defense-in-Depth.
 * H2: force-dynamic.
 */

import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/db/client";
import { scopedDb } from "@/lib/db/tenant-scope";
import { getTenantFromHost } from "@/lib/tenant";
import { sha256Hex } from "@/lib/auth/crypto";
import {
  SESSION_COOKIE_NAME,
  buildClearSessionCookieHeader,
} from "@/lib/auth/session";
import { auditEvents } from "@/db/schema";
import { apiError } from "@/lib/api-error";

// H2: Nicht cachen — Auth-Routen immer dynamisch
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- H1: Origin-Check (Defense-in-Depth) ---
  const originResult = checkOrigin(request);
  if (originResult) return originResult;

  const host = getEffectiveHost(request);
  const tenant = await getTenantFromHost(host);
  if (!tenant) {
    return apiError(404, "TENANT_NOT_FOUND", "Diese Kommune ist auf Partizip nicht registriert.");
  }

  const rawToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (rawToken) {
    const tokenHash = sha256Hex(rawToken);
    const DATABASE_URL =
      process.env.DATABASE_URL ??
      "postgres://partizip:partizip@127.0.0.1:5433/partizip";
    const db = createDb(DATABASE_URL);
    const scoped = scopedDb(db, tenant.id);

    // Session laden um actor_ref für Audit zu erhalten
    const session = await scoped.sessions.findValid(tokenHash);
    if (session) {
      await scoped.sessions.revoke(tokenHash);

      await db.insert(auditEvents).values({
        tenantId: tenant.id,
        actorType: "user",
        actorRef: session.userId,
        action: "auth.logout",
        metadata: { tenant: tenant.slug },
      });
    }
  }

  const response = NextResponse.json({ ok: true }, { status: 200 });
  response.headers.set("Set-Cookie", buildClearSessionCookieHeader());
  return response;
}

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
