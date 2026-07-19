/**
 * proof-scan.ts — reine Token-Extraktion aus einem gescannten String (V3).
 *
 * Der Verifizierer-Scanner (QrScanner.tsx) dekodiert einen QR ODER nimmt einen
 * manuell eingetippten Klartext-Code entgegen. Beide Wege münden hier: aus dem
 * rohen Scan wird der `proof`-RAW-Token gezogen, mit dem dann auf die bestehende
 * Bestätigungs-Seite (`…/verifizieren/bestaetigen?proof=<token>`) navigiert wird.
 *
 * Diese Funktion ist BEWUSST rein (keine DOM-/Server-Abhängigkeiten), damit sie
 * gründlich unit-getestet werden kann — Kamera/Decoder sind es nicht. Sie prüft
 * NUR das Format plausibel; die echte Gültigkeit (gültig/verbraucht/abgelaufen)
 * entscheidet der Server über proofFuerAnzeige. Nie den Token loggen.
 */

// Der RAW-Token ist base64url (siehe generateRawToken: 32 Bytes → 43 Zeichen),
// Zeichensatz A–Z a–z 0–9 - _. Untergrenze bewusst großzügig (16), damit ein
// künftiger kürzerer Token nicht fälschlich verworfen wird; Obergrenze 64 gegen
// überlange Müll-Strings. Müll mit Leer-/Sonderzeichen fällt zuverlässig heraus.
const TOKEN_MUSTER = /^[A-Za-z0-9_-]{16,64}$/;

function istPlausiblerToken(kandidat: string): boolean {
  return TOKEN_MUSTER.test(kandidat);
}

/**
 * Zieht den `proof`-RAW-Token aus einem gescannten oder eingetippten String.
 *
 * Akzeptiert:
 *   - absolute URL mit ?proof=…  (der eingebettete Deep-Link-QR)
 *   - relativer Pfad mit ?proof=… (defensiv, falls nur der Pfad kodiert wurde)
 *   - nackter Klartext-Code (der vom Bürger vorgelesene RAW-Token)
 *
 * Gibt den Token zurück oder null, wenn nichts Plausibles gefunden wurde
 * (leer, URL ohne proof, Müll mit Sonderzeichen …).
 */
export function extrahiereProofToken(scan: string): string | null {
  if (typeof scan !== "string") return null;
  const getrimmt = scan.trim();
  if (!getrimmt) return null;

  const istAbsolut = /^https?:\/\//i.test(getrimmt);
  // Fremdes Schema (javascript:, data:, mailto:, …) explizit ablehnen: nur http(s)
  // als absolute URL zulassen. Defense-in-Depth — die Navigation baut ohnehin nur
  // einen lokalen Same-Origin-Pfad, aber so bleibt der Vertrag der Funktion sauber.
  const hatFremdesSchema = /^[a-z][a-z0-9+.-]*:/i.test(getrimmt) && !istAbsolut;
  if (hatFremdesSchema) return null;
  const siehtWieUrlAus = istAbsolut || getrimmt.startsWith("/") || getrimmt.includes("?");

  if (siehtWieUrlAus) {
    let url: URL | null = null;
    try {
      // Relative Pfade brauchen eine Basis; die Herkunft ist irrelevant, uns
      // interessiert nur der proof-Query-Parameter.
      url = istAbsolut ? new URL(getrimmt) : new URL(getrimmt, "https://platzhalter.invalid");
    } catch {
      return null;
    }
    const proof = url.searchParams.get("proof")?.trim();
    return proof && istPlausiblerToken(proof) ? proof : null;
  }

  // Nackter Code: nur akzeptieren, wenn er wie ein base64url-Token aussieht.
  return istPlausiblerToken(getrimmt) ? getrimmt : null;
}
