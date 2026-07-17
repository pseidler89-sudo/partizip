/**
 * pg-errors.ts — robuste Erkennung von Postgres-Fehlercodes (Gate-B K1).
 *
 * drizzle wickelt den PostgresError des Treibers je nach Pfad in einen
 * DrizzleQueryError — der SQLSTATE-Code liegt dann auf `err.cause.code`,
 * nicht auf `err.code`. Wer nur `err.code` prüft, lässt z. B. einen
 * Unique-Konflikt (23505) als harten 500 durchrauschen (im Integrationstest
 * verifiziert). Dieser EINE Helfer prüft beide Ebenen und wird von
 * standort-core UND booking-core einheitlich verwendet.
 */

/** Unique-Verletzung (z. B. tenant+name, location+starts_at, One-Open-Booking). */
export const PG_UNIQUE_VIOLATION = "23505";

/** FK-Verletzung (z. B. Buchungs-Insert auf einen soeben gelöschten Slot). */
export const PG_FOREIGN_KEY_VIOLATION = "23503";

/** Trägt der Fehler (direkt oder als `cause`) den gegebenen SQLSTATE-Code? */
export function istPgFehler(err: unknown, code: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === code || e.cause?.code === code;
}
