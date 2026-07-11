/**
 * GET /[tenant]/konto/export — Daten-Export (Auskunftsrecht, Art. 15 DSGVO, H3).
 *
 * Authentifiziert über Session-Cookie (Tenant aus Host). Sammelt ausschließlich
 * die EIGENEN Daten des eingeloggten Users (Konto, Rollen, gefolgte Anliegen,
 * eigene Anliegen via Pseudonym + deren Events) — alles tenant-isoliert.
 *
 * Antwort: application/json als Download (Content-Disposition: attachment).
 * Dateiname enthält das Konto-Erstellungsdatum (kein Date.now()).
 *
 * H2: force-dynamic — Auth-Route, niemals cachen.
 */

import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { validateSession } from "@/lib/auth/session";
import { apiError } from "@/lib/api-error";
import { collectExportData } from "@/lib/konto/export";

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
    return apiError(404, "TENANT_NOT_FOUND", "Diese Kommune ist auf Partizip nicht registriert.");
  }

  const session = await validateSession(request, tenant);
  if (!session) {
    return apiError(401, "UNAUTHENTICATED", "Keine gültige Sitzung.");
  }

  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);

  let document;
  try {
    document = await collectExportData(
      db,
      { id: tenant.id, slug: tenant.slug, name: tenant.name },
      session.userId,
    );
  } catch (err) {
    console.error("[konto/export] Fehler beim Sammeln der Daten:", err);
    return apiError(500, "INTERNAL_ERROR", "Export konnte nicht erstellt werden.");
  }

  if (!document) {
    return apiError(401, "UNAUTHENTICATED", "Benutzer nicht gefunden.");
  }

  // Dateiname aus dem Konto-Erstellungsdatum (frei, kein Date.now()).
  const datum = (document.konto.createdAt ?? document.exportiertAm).slice(0, 10);
  const filename = `partizip-datenexport-${datum}.json`;

  return new NextResponse(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
