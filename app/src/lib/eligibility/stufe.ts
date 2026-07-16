/**
 * stufe.ts — Stufenmodell (ADR-003, Konzept Kap. 5)
 *
 * Stufen:
 *   0 — nicht eingeloggt ODER Mindestalter nicht bestätigt (nur Lesen)
 *   1 — eingeloggt (Magic-Link bestätigt) UND Mindestalter (≥16) bestätigt
 *   2 — Wohnsitz verifiziert (residency_verified_at gesetzt ODER verification_status=verified)
 *   3 — reserviert für zukünftige Erweiterungen (z. B. eID)
 *
 * N3 (Mindestalter durchsetzen, ADR-007): Die Selbsterklärung „≥16" wird bei der
 * Registrierung erzwungen — UND zusätzlich hier in der Eligibility-Schicht: ohne
 * gesetztes min_age_confirmed_at bleibt ein Konto auf Stufe 0 (Defense-in-Depth
 * gegen Konten, die über andere Pfade ohne Bestätigung entstehen könnten).
 *
 * Poll-spezifische Checks kommen in M3. Die 8-Schritte-Pipeline (AUTH_ELIGIBILITY_MIDDLEWARE.md)
 * dockt hier an — Skelett als Kommentar unten.
 */

export type Stufe = 0 | 1 | 2 | 3;

/**
 * Berechnet die Eligibility-Stufe eines Users.
 * user = null → Stufe 0 (nicht eingeloggt).
 */
export function getStufe(
  user: {
    verificationStatus: "pending" | "verified" | "rejected";
    residencyVerifiedAt: Date | null;
    // ADR-014 Block 2: Ablauf der Wohnsitz-Verifizierung. NULL = kein Ablauf
    // (Bestand vor Einführung — grandfathered). Optional, damit Aufrufer mit
    // älterem user-Shape (Tests/Anonymize) nicht brechen.
    residencyVerifiedUntil?: Date | null;
    accountStatus: "active" | "locked" | "deleted";
    minAgeConfirmedAt: Date | null;
  } | null
): Stufe {
  if (!user) return 0;
  if (user.accountStatus !== "active") return 0;

  // N3: Ohne bestätigtes Mindestalter (≥16) keine Teilnahme — bleibt Stufe 0.
  if (user.minAgeConfirmedAt == null) return 0;

  // Audit m1: expliziter Entzug (verificationStatus='rejected') muss wirken.
  // Vorher hob die ODER-Verknüpfung unten (… || residencyVerifiedAt !== null) den
  // Entzug auf, solange ein alter Verifizierungs-Stempel stand → Person blieb bis
  // zu 24 Monate auf Stufe 2. 'rejected' kappt jetzt hart auf Stufe 1.
  if (user.verificationStatus === "rejected") {
    return 1;
  }

  // ADR-014 Block 2: Abgelaufene Wohnsitz-Verifizierung → zurück auf Stufe 1.
  // Greift NUR, wenn residencyVerifiedUntil gesetzt ist UND in der Vergangenheit
  // liegt. NULL bleibt unverändert (kein Ablauf — Bestand grandfathered).
  if (user.residencyVerifiedUntil != null && user.residencyVerifiedUntil < new Date()) {
    return 1;
  }

  // Stufe 2: Wohnsitz verifiziert
  if (user.verificationStatus === "verified" || user.residencyVerifiedAt !== null) {
    return 2;
  }

  // Stufe 1: eingeloggt + Mindestalter bestätigt
  return 1;
}

// ---------------------------------------------------------------------------
// requireStufe — Guard für Route Handler
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import type { ApiErrorCode } from "@/lib/api-error";

export type RequireStufeError = {
  response: NextResponse;
};

/**
 * Prüft ob der User die geforderte Stufe hat.
 * Gibt null zurück wenn OK, sonst { response } mit passendem Fehler.
 *
 * M3-Pipeline-Skelett (8 Schritte, AUTH_ELIGIBILITY_MIDDLEWARE.md):
 *   Schritt 1: Authentication Check       → requireStufe(1) → UNAUTHENTICATED (401)
 *   Schritt 2: Tenant Context Check       → tenant_id-Bindung in Session/scopedDb
 *   Schritt 3: Account Status Check       → accountStatus = active → ACCOUNT_INACTIVE (403)
 *   Schritt 4: Verification Gate (hard)   → requireStufe(2) → NOT_VERIFIED (403)
 *   Schritt 5: Poll State Check           → Poll existiert + published + Zeitfenster
 *   Schritt 6: Eligibility Rules Check    → Wohnsitz/Ortsteil/Altersregel → NOT_ELIGIBLE (403)
 *   Schritt 7: Duplicate Vote Check       → voter_ref + poll_id → ALREADY_VOTED (409)
 *   Schritt 8: Write + Audit              → vote.cast ohne PII
 */
export function requireStufe(
  minStufe: Stufe,
  actualStufe: Stufe
): RequireStufeError | null {
  if (actualStufe >= minStufe) return null;

  let code: ApiErrorCode;
  let status: number;
  let message: string;

  if (actualStufe === 0) {
    code = "UNAUTHENTICATED";
    status = 401;
    message = "Bitte melden Sie sich an.";
  } else {
    // actualStufe >= 1 aber < minStufe → NOT_VERIFIED
    code = "NOT_VERIFIED";
    status = 403;
    message = "Für diese Funktion ist eine Verifizierung erforderlich.";
  }

  return {
    response: NextResponse.json({ error: { code, message } }, { status }),
  };
}
