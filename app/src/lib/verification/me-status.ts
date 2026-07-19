/**
 * me-status.ts — reine Auswertung der GET /api/me-Antwort für das Live-Polling
 * der Vor-Ort-Verifizierung (Vor-Ort-Befund C).
 *
 * Der Bürger zeigt seinen Konto-QR; sobald der Verifizierer bestätigt, springt
 * seine Stufe auf 2 (bzw. verificationStatus="verified"). Der Client pollt
 * /api/me und wertet die Antwort NUR über diese reine Funktion aus — testbar
 * ohne DOM/Canvas.
 */

/** Minimaler Ausschnitt der /api/me-Antwort, den das Polling braucht. */
export interface MeStatusResponse {
  user?: {
    stufe?: number | null;
    verificationStatus?: string | null;
  } | null;
}

/**
 * true ⇔ der Wohnsitz ist bestätigt (Stufe ≥ 2 ODER verificationStatus
 * "verified"). Tolerant gegenüber fehlenden/teilweisen Feldern (Netzfehler,
 * alte Shapes) — im Zweifel false, damit das Polling weiterläuft statt
 * fälschlich den Erfolgs-Screen zu zeigen.
 */
export function istVerifiziert(res: MeStatusResponse | null | undefined): boolean {
  const user = res?.user;
  if (!user) return false;
  if (typeof user.stufe === "number" && user.stufe >= 2) return true;
  if (user.verificationStatus === "verified") return true;
  return false;
}
