/**
 * token-status.ts — nebenwirkungsfreie Statusprüfung eines Magic-Link-Tokens
 *
 * HINTERGRUND (Scanner-Härtung): E-Mail-Security-Scanner und Client-Prefetch
 * folgen Links in E-Mails automatisch per GET. Die Bestätigungsseite
 * ([tenant]/auth/verify) prüft den Token deshalb NUR — eingelöst wird er erst
 * durch eine bewusste Nutzeraktion (POST /api/auth/verify).
 *
 * GARANTIE dieser Funktion: reiner Lesezugriff. Kein UPDATE, kein INSERT,
 * kein Audit-Event — beliebig viele Aufrufe (Scanner, Prefetch, Reload)
 * verändern den Token-Zustand nicht.
 *
 * Der Lookup ist tenant-scoped (findByHash): ein Token eines anderen
 * Mandanten erscheint hier als "unknown" — die Bestätigungsseite zeigt dafür
 * einen neutralen Fehler, ohne Cross-Tenant-Existenz zu verraten.
 */

import { sha256Hex } from "./crypto";
import type { ScopedDb } from "@/lib/db/tenant-scope";

export type TokenStatus = "valid" | "used" | "expired" | "unknown";

/**
 * Prüft den Zustand eines Roh-Tokens, ohne ihn zu verbrauchen.
 * Reihenfolge wie in der Einlöse-Diagnose: erst "used", dann "expired".
 */
export async function getTokenStatus(
  scoped: ScopedDb,
  rawToken: string
): Promise<TokenStatus> {
  const row = await scoped.authTokens.findByHash(sha256Hex(rawToken));
  if (!row) return "unknown";
  if (row.consumedAt !== null) return "used";
  if (row.expiresAt <= new Date()) return "expired";
  return "valid";
}
