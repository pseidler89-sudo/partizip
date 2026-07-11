/**
 * anonymize.ts — Anonymisierungs-Payload für die Konto-Löschung (H3 DSGVO).
 *
 * Reine Funktion ohne DB/IO, damit die Anonymisierungs-Vollständigkeit isoliert
 * unit-getestet werden kann (kein versehentliches Vergessen eines PII-Feldes).
 *
 * Designprinzip: Die users-ZEILE bleibt erhalten (referenzielle Integrität,
 * PII-freies Audit, Stufen-Logik). Aber JEDES personenbeziehbare Feld wird
 * entweder genullt oder durch einen nicht-rückführbaren Tombstone ersetzt.
 *
 * Tombstone-E-Mail: `geloescht-<userId>@deleted.invalid`
 *   - erfüllt UNIQUE(tenant_id, email): userId ist pro Tenant eindeutig
 *   - `.invalid` ist eine reservierte TLD (RFC 2606) → niemals zustellbar
 *   - userId ist KEIN PII (interne UUID, kein Personenbezug ohne DB-Zugriff,
 *     identisch zum bereits PII-frei genutzten actor_ref im Audit)
 */

/** Felder, die beim Anonymisieren auf den User-Datensatz geschrieben werden. */
export type AnonymizePayload = {
  email: string;
  birthYear: null;
  birthMonth: null;
  ortsteilId: null;
  verificationMethod: null;
  residencyVerifiedAt: null;
  // ADR-014 Block 2: Ablauf der Wohnsitz-Verifizierung mit-zurücksetzen.
  residencyVerifiedUntil: null;
  verificationStatus: "pending";
  minAgeConfirmedAt: null;
  // Benachrichtigungs-Motor: keine Mails an gelöschte Konten.
  notifyNewPolls: false;
  accountStatus: "deleted";
  deletedAt: Date;
};

/**
 * Baut die Tombstone-E-Mail für einen gelöschten User.
 * Deterministisch und eindeutig pro Tenant (userId ist global eindeutig).
 */
export function buildTombstoneEmail(userId: string): string {
  return `geloescht-${userId}@deleted.invalid`;
}

/**
 * Erzeugt das vollständige Anonymisierungs-Payload für einen User.
 * Alle PII-Felder werden geleert; account_status='deleted' + deletedAt gesetzt.
 *
 * @param userId  Die User-UUID (kein PII) — fließt nur in den Tombstone ein.
 * @param now     Lösch-Zeitstempel (für deletedAt). Default: new Date().
 */
export function buildAnonymizePayload(
  userId: string,
  now: Date = new Date(),
): AnonymizePayload {
  return {
    email: buildTombstoneEmail(userId),
    birthYear: null,
    birthMonth: null,
    ortsteilId: null,
    verificationMethod: null,
    residencyVerifiedAt: null,
    residencyVerifiedUntil: null,
    verificationStatus: "pending",
    minAgeConfirmedAt: null,
    notifyNewPolls: false,
    accountStatus: "deleted",
    deletedAt: now,
  };
}
