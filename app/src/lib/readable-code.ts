/**
 * readable-code.ts — Gemeinsamer Generator für vorlesbare Codes (Beleg, Termin …).
 *
 * Mehrere Features vergeben kurze, am Telefon/vor Ort vorlesbare Codes der Form
 * `PREFIX-XXXX-XXXX` (z. B. `BELEG-7F3A-K29Q`, `TERMIN-…`). Diese Logik lag
 * dupliziert in `polls/beleg.ts` und `verification/booking-core.ts` — hier ist
 * sie EINMAL, damit Alphabet, Entropie und Format garantiert identisch bleiben.
 *
 * Sicherheits-/Datenschutz-Eigenschaften:
 *   - CSPRNG: jede Stelle wird über node:crypto randomInt gezogen (kryptografisch
 *     sicher, verzerrungsfrei dank Rejection-Sampling) — nicht erratbar/aufzählbar.
 *   - Der Code trägt KEINE Information über Person oder Inhalt (rein zufällig).
 *   - 8 Zeichen aus 32er-Alphabet = 40 Bit Entropie; die Eindeutigkeit je Kontext
 *     stellt die jeweilige UNIQUE-Bedingung + Insert-Retry der Aufrufer sicher.
 */

import { randomInt } from "node:crypto";

/** Crockford-Base32 ohne mehrdeutige Zeichen (I, L, O, U) — gut vorlesbar. */
export const READABLE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const GROUP_LEN = 4;
const GROUPS = 2;

/**
 * Erzeugt einen vorlesbaren Code `PREFIX-XXXX-XXXX` (8 Zeichen, 40 Bit CSPRNG).
 * Reine Funktion ohne DB — die Eindeutigkeit je Kontext stellt der Aufrufer über
 * die jeweilige UNIQUE-Bedingung (+ Insert-Retry) sicher.
 */
export function generateReadableCode(prefix: string): string {
  let s = "";
  for (let i = 0; i < GROUP_LEN * GROUPS; i++) {
    s += READABLE_CODE_ALPHABET[randomInt(READABLE_CODE_ALPHABET.length)];
  }
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(s.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
  }
  return `${prefix}-${groups.join("-")}`;
}

/** Liefert das Format-RegExp `^PREFIX-XXXX-XXXX$` für Tests/Validierung. */
export function readableCodePattern(prefix: string): RegExp {
  const group = `[${READABLE_CODE_ALPHABET}]{${GROUP_LEN}}`;
  return new RegExp(`^${prefix}-${Array(GROUPS).fill(group).join("-")}$`);
}
