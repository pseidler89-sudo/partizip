/**
 * voter-ref.ts — Pseudonymisierung für Stimmen (M3 Mitmach-Schleife)
 *
 * voter_ref = HMAC-SHA256(SALT, "vote:user:" + userId)
 *
 * ADR-014: Mitstimmen erfordert ein Konto (Stufe 1) — anonymes Abstimmen über
 * einen Device-Cookie entfällt. Es gibt deshalb nur noch die User-Domain.
 *
 * Zweck (Secret Ballot): An der Stimme steht KEIN User-FK, nur dieses Pseudonym.
 * Die getroffene Wahl ist damit nur über den Salt einer Person zuordenbar — und
 * der Salt verlässt nie den Server. Im Audit erscheint ausschließlich voter_ref.
 *
 * Eigenschaften:
 *   - Deterministisch: gleiche (Salt, domain) → gleicher voter_ref (Dedup via UNIQUE).
 *   - Domain-Präfix ("vote:user:") trennt den Namensraum sauber vom creator_ref
 *     (der userId ohne Präfix hasht).
 *   - PII-frei: voter_ref darf in Audit-Logs erscheinen.
 *
 * Salt (Skalierungs-Roadmap): bevorzugt ein dediziertes VOTE_REF_SALT und fällt
 * auf ANLIEGEN_REF_SALT zurück. Der Domain-Präfix trennt den Namensraum bereits
 * auf Nachrichtenebene; das dedizierte Salt trennt ihn zusätzlich auf Schlüssel-
 * ebene (Defense-in-Depth: ein kompromittiertes Anliegen-Salt erlaubt keine
 * Korrelation auf Stimmen).
 *
 * ⚠️ MIGRATION: VOTE_REF_SALT NIE nachträglich auf einem Deployment mit
 * bestehenden Stimmen setzen oder ändern — alle voter_refs würden neu abgeleitet
 * (Doppelabstimmung möglich, hatBereitsAbgestimmt bräche). Nur bei FRISCHEN
 * Deployments dediziert setzen; Bestand bleibt ohne env beim Anliegen-Salt.
 */

import { createHmac } from "node:crypto";

const USER_DOMAIN_PREFIX = "vote:user:";

function getSalt(): string {
  // Bevorzugt das dedizierte Salt; Fallback hält Bestandsdeployments stabil.
  const salt = process.env.VOTE_REF_SALT ?? process.env.ANLIEGEN_REF_SALT;
  if (!salt) {
    throw new Error("Weder VOTE_REF_SALT noch ANLIEGEN_REF_SALT ist konfiguriert.");
  }
  return salt;
}

/** Reine HMAC-Berechnung über die bereits präfixierte Domain. */
export function computeVoterRefFromDomain(salt: string, domain: string): string {
  return createHmac("sha256", salt).update(domain).digest("hex");
}

/** voter_ref für einen eingeloggten User (Domain-Präfix "vote:user:"). */
export function computeVoterRefForUser(userId: string): string {
  return computeVoterRefFromDomain(getSalt(), USER_DOMAIN_PREFIX + userId);
}

/** Test-Helper: voter_ref mit explizitem Salt (User-Domain) ohne env. */
export function computeVoterRefForUserWithSalt(salt: string, userId: string): string {
  return computeVoterRefFromDomain(salt, USER_DOMAIN_PREFIX + userId);
}

export const VOTER_REF_DOMAINS = {
  USER_DOMAIN_PREFIX,
} as const;
