/**
 * GET /api/anliegen/followed — Gefolgten Anliegen des eingeloggten Users (M8)
 *
 * Gibt Liste der gefolgten Anliegen zurück (über anliegen_followers).
 * 401 bei fehlender Session.
 * Tenant-isoliert: nur eigene Anliegen.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { validateSession } from "@/lib/auth/session";
import { anliegen, anliegenFollowers } from "@/db/schema";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const host = getEffectiveHost(request);
  const tenant = await getTenantFromHost(host);
  if (!tenant) {
    return apiError(404, "TENANT_NOT_FOUND", "Tenant nicht gefunden.");
  }

  const session = await validateSession(request, tenant);
  if (!session) {
    return apiError(401, "UNAUTHENTICATED", "Keine gültige Sitzung.");
  }

  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );

  // Gefolgten Anliegen laden (tenant-scoped via anliegen.tenantId)
  const rows = await db
    .select({
      id: anliegen.id,
      trackingCode: anliegen.trackingCode,
      titel: anliegen.titel,
      status: anliegen.status,
    })
    .from(anliegenFollowers)
    .innerJoin(anliegen, eq(anliegenFollowers.anliegenId, anliegen.id))
    .where(
      and(
        eq(anliegenFollowers.userId, session.userId),
        eq(anliegen.tenantId, tenant.id)
      )
    )
    .orderBy(anliegen.createdAt);

  return NextResponse.json({ anliegen: rows });
}
