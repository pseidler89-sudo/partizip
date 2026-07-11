/**
 * client-ip.ts — EINE Quelle für die Client-IP-Ermittlung (Projekt-Review
 * 2026-07-02, P1-2).
 *
 * Semantik: LETZTES Element von x-forwarded-for. Annahme: genau ein eigener,
 * vertrauenswürdiger Proxy (Traefik) vor der App, der die echte Client-IP
 * ANHÄNGT. Das erste Element ist client-kontrollierbar (Header-Spoofing) —
 * wer es verwendet, macht IP-basierte Rate-Limits (Stimmen, QR-Einlösung,
 * Anliegen) per gefälschtem Header rotierbar und entwertet den forensischen
 * ipHash an Stimmen. Deshalb hier bewusst KEIN x-real-ip-Fallback: der Header
 * wäre bei direkter Erreichbarkeit der App ebenfalls client-kontrollierbar.
 *
 * Ohne Header (direkte Verbindung, lokale Entwicklung) → null; die Aufrufer
 * behandeln null (die IP-Rate-Limit-Dimension entfällt dann).
 */

/** Extrahiert die Client-IP aus einem x-forwarded-for-Headerwert. */
export function clientIpFromForwardedFor(
  headerValue: string | null
): string | null {
  if (!headerValue) return null;
  const parts = headerValue
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}
