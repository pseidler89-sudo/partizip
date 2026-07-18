/**
 * origin.ts — Same-Origin-Prüfung als Defense-in-Depth (Muster „H1" aus
 * /api/auth/request + /api/auth/verify, dort als lokales checkOrigin).
 *
 * Reines Prädikat (testbar, kein Next-Import), damit Route-Handler UND Server
 * Actions (J2b-MIN3: email-change-actions) dieselbe Logik nutzen.
 *
 * Regeln (identisch zu den Routen):
 *   - KEIN Origin-Header → erlaubt (direkte Server-zu-Server-Anfragen,
 *     same-origin GET-Navigationen älterer Browser).
 *   - Origin vorhanden, aber nicht parsebar → abgelehnt.
 *   - Origin-Host ≠ Request-Host → abgelehnt.
 */
export function istSameOrigin(
  originHeader: string | null,
  host: string | null,
): boolean {
  if (!originHeader) return true;

  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    return false;
  }

  return originHost === (host ?? "");
}
