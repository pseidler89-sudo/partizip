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
import {
  getUserRoleTypes,
  isAdmin,
  canVerify,
  canRedaktion,
  canBeobachten,
} from "@/lib/auth/roles";
import { istRollentraeger } from "@/lib/identity/anzeige";
import { getEinrichtungsStatus } from "@/lib/konto/einrichtung";
import { isDemoTenant } from "@/lib/demo/config";
import { regionPfad } from "@/lib/region/tree";
import { getOrtsteileForTenant } from "@/lib/region/queries";
import { resolveOrtsteilCodeForRegionId } from "@/lib/region/scope";

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
  // Demo-Mandant: gar nicht erst berechnen — die Konto-Seite zeigt die Karte
  // dort nie, die 3 Existenz-Queries wären umsonst (Gate-B MINOR).
  const istDemo = isDemoTenant(tenant.slug);
  const einrichtung = istDemo
    ? null
    : await getEinrichtungsStatus(db, tenant, user, user.id);

  // Block J2c: Wohnort-Sektion. Anzeige-Wohnort = home_region_id (weich, frei
  // setzbar); verbindlicher Wohnsitz = residency_region_id (nur per QR). Die
  // Pfade serverseitig auflösen, damit die Client-Konto-Seite fertige Strings
  // bekommt. Ortsteil-Dropdown: Optionen + aktuelle Auswahl (aus home_region_id).
  const homeRegionPfad = user.homeRegionId
    ? await regionPfad(db, user.homeRegionId)
    : null;
  const residencyRegionPfad = user.residencyRegionId
    ? await regionPfad(db, user.residencyRegionId)
    : null;
  const ortsteilOptionen = await getOrtsteileForTenant(db, tenant.id);
  const homeOrtsteilCode = user.homeRegionId
    ? await resolveOrtsteilCodeForRegionId(db, tenant.id, user.homeRegionId)
    : null;

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
      // Block J2c: granulare Opt-outs (Anliegen-Status-Mails, Reverify-Erinnerung).
      notifyAnliegenUpdates: user.notifyAnliegenUpdates,
      notifyReverify: user.notifyReverify,
      // Block J2c: Wohnort. Roh-Ids + serverseitig aufgelöste, lesbare Pfade.
      homeRegionId: user.homeRegionId ?? null,
      ortsteilId: user.ortsteilId ?? null,
      residencyRegionId: user.residencyRegionId ?? null,
      homeRegionPfad,
      residencyRegionPfad,
      // Ortsteil-Dropdown der Wohnort-Sektion (nur falls die Gemeinde welche hat).
      ortsteilOptionen,
      homeOrtsteilCode,
      stufe: getStufe(user),
      // Admin-Sichtbarkeit (kommune_admin/super_admin) für die Verwaltung-Karte.
      isAdmin: isAdmin(roleTypes),
      // Feine Fähigkeiten für die Aufgaben-Ansicht (Discoverability im Konto).
      // Nur Anzeige — die Zielseiten erzwingen die Berechtigung weiterhin
      // serverseitig. Aus den account_status-gefilterten roleTypes berechnet.
      canVerify: canVerify(roleTypes),
      canRedaktion: canRedaktion(roleTypes),
      canBeobachten: canBeobachten(roleTypes),
      // Block J1: Rollenträger-Identität. Die Klarname-/Funktion-Sektion (und der
      // Nudge) erscheinen im Konto NUR für Rollenträger — Bürger bleiben pseudonym.
      istRollentraeger: istRollentraeger(roleTypes),
      displayName: user.displayName ?? null,
      funktion: user.funktion ?? null,
    },
    einrichtung,
    tenant: {
      slug: tenant.slug,
      name: tenant.name,
      // Demo-Mandant (env-basiert, nur serverseitig entscheidbar): die Konto-
      // Seite blendet dort die Einrichtungs-Checkliste aus — Demo-Konten
      // erfüllen die Schritte nie (RegionEinstieg-Gate-B-Lehre).
      istDemo,
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
