/**
 * email.ts — Kanonische E-Mail-Normalisierung (Block J2a, Audit-Fund F-A).
 *
 * EINE geteilte Wahrheit für die kanonische Form einer E-Mail-Adresse:
 * `trim()` (Whitespace an den Rändern) + `toLowerCase()` (Case-Insensitivität
 * nach RFC-Praxis für die Zustellung). BEWUSST keine weitergehende Magie
 * (kein Plus-Adress-Stripping, keine Unicode-/Punycode-Normalisierung) — das
 * wäre für einen Login-Identifikator überraschend und schwer testbar.
 *
 * Diese Funktion ist die EINZIGE erlaubte Normalisierung: alle Vergleichs-,
 * Anlage- und Lookup-Pfade (Auth-Request/Verify, Rate-Limit-HMAC, Rollen-
 * Vergabe, Einladungen, K2-Sperre, DSGVO-Tombstone) benutzen sie, damit
 * `users.email`/`auth_tokens.email` ausschließlich kanonische Adressen
 * enthalten. Der funktionale Unique-Index `users_tenant_email_lower_unique`
 * (Migration 0033) ist das DB-seitige Netz darunter.
 *
 * BEWUSST OHNE "use server": reine Funktion, in Route-Handlern, Server
 * Actions, Kern-Modulen UND DB-Integrationstests gleichermaßen aufrufbar.
 */

import { z } from "zod";

/** Kanonische Form einer E-Mail: getrimmt + kleingeschrieben. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * zod-Baustein für Boundaries (Route-/Action-Eingaben): normalisiert VOR der
 * E-Mail-Validierung. `.trim()`/`.toLowerCase()` sind ab zod 3.22 Ketten-
 * Methoden; `.pipe(z.string().email())` validiert die bereits normalisierte
 * Form (so schlägt " Max@x.de " nicht am Whitespace fehl, sondern wird zu
 * "max@x.de" normalisiert und dann geprüft).
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email());
