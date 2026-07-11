/**
 * creator-ref.ts — Pseudonymisierung für Anliegen-Ersteller (M8)
 *
 * creator_ref = HMAC-SHA256(ANLIEGEN_REF_SALT, userId)
 *
 * Zweck: Der Ersteller kann intern (für Benachrichtigung via anliegen_followers)
 * verfolgt werden, ohne dass am Anliegen selbst ein User-FK steht.
 * Damit bleibt der öffentlich sichtbare Anliegen-Datensatz pseudonym.
 *
 * Eigenschaften:
 *   - Deterministisch: gleicher userId → gleicher creator_ref
 *   - Pseudonym: creator_ref ≠ userId (kein Rückschluss ohne Salt)
 *   - PII-frei: creator_ref kann ohne Datenschutzbedenken in Audit-Logs erscheinen
 *
 * Salt: ANLIEGEN_REF_SALT aus env (zufälliger Wert, min. 32 Bytes empfohlen)
 */

import { createHmac } from "node:crypto";

/**
 * Berechnet den creator_ref für einen User.
 * Deterministisch: gleicher Salt + userId → gleicher creator_ref.
 */
export function computeCreatorRef(userId: string): string {
  const salt = process.env.ANLIEGEN_REF_SALT;
  if (!salt) {
    throw new Error("ANLIEGEN_REF_SALT ist nicht konfiguriert.");
  }
  return createHmac("sha256", salt).update(userId).digest("hex");
}

/**
 * Test-Helper: Creator-Ref mit explizitem Salt berechnen (für Unit-Tests ohne env).
 */
export function computeCreatorRefWithSalt(salt: string, userId: string): string {
  return createHmac("sha256", salt).update(userId).digest("hex");
}
