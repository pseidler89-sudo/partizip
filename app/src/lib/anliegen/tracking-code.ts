/**
 * tracking-code.ts — CSPRNG-basierte Tracking-Code-Generierung (M8)
 *
 * Format: TS-XXXX-XXXX
 * Alphabet: ABCDEFGHJKMNPQRSTUVWXYZ23456789 (31 Zeichen, ohne verwechselbare Zeichen
 *   wie 0/O, 1/I/L)
 * Entropie: 8 Zeichen × log2(32) = 40 Bit
 *
 * Sicherheit:
 *   - Nur crypto.randomBytes — NIEMALS Math.random()
 *   - Kollisions-Retry: bis zu 5 Versuche bei UNIQUE-Verletzung
 *   - Lookup NUR über exakten Code — kein Listing, keine Teiltreffer (Anti-Enumeration)
 *
 * Seed-Codes (TS-2026-0001 etc.) sind Beispieldaten und folgen dem alten Format;
 * neue Codes folgen immer diesem CSPRNG-Format.
 */

import { randomBytes } from "node:crypto";

/** Alphabet ohne verwechselbare Zeichen (ohne 0, O, 1, I, L) = 31 Zeichen */
export const TRACKING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Länge des Code-Teils (ohne Präfix und Trennzeichen) */
const CODE_PART_LENGTH = 8;

/** Maximale Versuche bei Kollision */
const MAX_RETRIES = 5;

/**
 * Generiert einen einzelnen Tracking-Code (Format TS-XXXX-XXXX).
 * Kryptografisch zufällig via crypto.randomBytes — keine Math.random().
 *
 * Verwendet Rejection-Sampling: Bytes > (256 - 256%32) werden verworfen,
 * um gleichmäßige Verteilung zu gewährleisten (kein Modulo-Bias).
 */
export function generateTrackingCode(): string {
  const alphabet = TRACKING_CODE_ALPHABET;
  const alphabetLen = alphabet.length; // 32
  // Grenze für Rejection-Sampling: größter Wert <= 255 der gleichmäßig verteilbar ist
  const limit = 256 - (256 % alphabetLen); // 256 - 0 = 256 → alle Werte brauchbar da 256%31=8

  const chars: string[] = [];
  // Puffer mit Reserve für Rejection-Sampling
  let buf = randomBytes(CODE_PART_LENGTH * 2);
  let bufIdx = 0;

  while (chars.length < CODE_PART_LENGTH) {
    if (bufIdx >= buf.length) {
      buf = randomBytes(CODE_PART_LENGTH * 2);
      bufIdx = 0;
    }
    const byte = buf[bufIdx++];
    if (byte < limit) {
      chars.push(alphabet[byte % alphabetLen]);
    }
  }

  // Format: TS-XXXX-XXXX
  return `TS-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/**
 * Prüft ob ein String das korrekte Tracking-Code-Format hat.
 * Nützlich für Eingabe-Validierung und Tests.
 */
export function isValidTrackingCodeFormat(code: string): boolean {
  if (!code.startsWith("TS-")) return false;
  const parts = code.split("-");
  if (parts.length !== 3) return false;
  if (parts[1].length !== 4 || parts[2].length !== 4) return false;
  // Prüfe jeden Charakter gegen das exakte Alphabet
  const alphabetSet = new Set(TRACKING_CODE_ALPHABET.split(""));
  for (const segment of [parts[1], parts[2]]) {
    for (const ch of segment) {
      if (!alphabetSet.has(ch)) return false;
    }
  }
  return true;
}

/**
 * Generiert einen Tracking-Code mit Kollisions-Retry.
 *
 * @param isUnique - Async-Funktion die prüft ob der Code noch frei ist
 * @returns Eindeutiger Tracking-Code
 * @throws Error wenn nach MAX_RETRIES kein eindeutiger Code gefunden wurde
 */
export async function generateUniqueTrackingCode(
  isUnique: (code: string) => Promise<boolean>
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateTrackingCode();
    if (await isUnique(code)) {
      return code;
    }
  }
  throw new Error(`Konnte nach ${MAX_RETRIES} Versuchen keinen eindeutigen Tracking-Code generieren.`);
}
