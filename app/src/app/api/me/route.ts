/**
 * GET /api/me
 *
 * Gibt aktuelle Session-Daten zurück.
 * 401 UNAUTHENTICATED wenn kein gültiger Session-Cookie.
 *
 * H2: force-dynamic.
 */

import { NextRequest, NextResponse } from "next/server";

// H2: Nicht cachen — Auth-Routen immer dynamisch
export const dynamic = "force-dynamic";
import { createDb } from "@/db/client";
import { scopedDb } from "@/lib/db/tenant-scope";
import { getTenantFromHost } from "@/lib/tenant";
import { validateSession } from "@/lib/auth/session";
import { apiError } from "@/lib/api-error";
import { getStufe } from "@/lib/eligibility/stufe";
import { getUserRoleTypes, isAdmin } from "@/lib/auth/roles";
import { getEinrichtungsStatus } from "@/lib/konto/einrichtung";
import { isDemoTenant } from "@/lib/demo/config";

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

  const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(DATABASE_URL);
  const scoped = scopedDb(db, tenant.id);
  const user = await scoped.users.findById(session.userId);

  if (!user) {
    return apiError(401, "UNAUTHENTICATED", "Benutzer nicht gefunden.");
  }

  // Rollen für die Admin-Sichtbarkeit (Verwaltung-Karte im Konto). Nur Anzeige —
  // die Admin-Seiten erzwingen die Berechtigung weiterhin serverseitig.
  const roleTypes = await getUserRoleTypes(db, tenant.id, user.id);

  // Einrichtungs-Checkliste (Konto-Seite): eigene Daten des eingeloggten Users —
  // datensparsam (nur Booleans, Teilnahme nur als Existenz via voter_ref).
  const einrichtung = await getEinrichtungsStatus(db, tenant, user, user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      verificationStatus: user.verificationStatus,
      // ADR-014 Block 2: Ablauf der Wohnsitz-Verifizierung (für „verifiziert bis").
      residencyVerifiedUntil: user.residencyVerifiedUntil
        ? user.residencyVerifiedUntil.toISOString()
        : null,
      // Benachrichtigungs-Motor: aktueller Opt-in-Status (für den Konto-Umschalter).
      notifyNewPolls: user.notifyNewPolls,
      stufe: getStufe(user),
      // Admin-Sichtbarkeit (kommune_admin/super_admin) für die Verwaltung-Karte.
      isAdmin: isAdmin(roleTypes),
    },
    einrichtung,
    tenant: {
      slug: tenant.slug,
      name: tenant.name,
      // Demo-Mandant (env-basiert, nur serverseitig entscheidbar): die Konto-
      // Seite blendet dort die Einrichtungs-Checkliste aus — Demo-Konten
      // erfüllen die Schritte nie (RegionEinstieg-Gate-B-Lehre).
      istDemo: isDemoTenant(tenant.slug),
    },
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
