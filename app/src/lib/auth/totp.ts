/**
 * totp.ts — Zeitbasierte Einmalcodes (RFC 6238) für die Admin-Zwei-Faktor-Pflicht.
 *
 * WARUM OHNE BIBLIOTHEK: TOTP ist HMAC-SHA-1 plus dynamische Trunkierung — keine
 * eigene Kryptografie, sondern eine Anwendung vorhandener Primitive aus
 * node:crypto. Der Gegenwert einer Abhängigkeit wäre gering, die Prüfbarkeit
 * dagegen hoch: Die Implementierung wird in __tests__/totp.test.ts gegen die
 * offiziellen Testvektoren aus RFC 4226 (HOTP) und RFC 6238 (TOTP) verifiziert.
 * Wer hier etwas ändert, muss diese Tests grün halten — sie sind die Spezifikation.
 *
 * SHA-1 ist hier korrekt und kein Versäumnis: Authenticator-Apps (Google
 * Authenticator, Aegis, 1Password, …) implementieren praktisch ausnahmslos den
 * SHA-1-Default aus RFC 6238. Die Sicherheit von TOTP hängt nicht an
 * Kollisionsresistenz, sondern an der Geheimhaltung des Shared Secret.
 *
 * SPEICHERUNG DES SECRETS: Anders als Session-Tokens kann das TOTP-Secret nicht
 * gehasht werden — es wird zur Prüfung im Klartext gebraucht. Es liegt deshalb
 * AES-256-GCM-verschlüsselt in der Datenbank (Schlüssel aus TOTP_ENC_KEY). Ein
 * Datenbank-Dump allein reicht damit nicht, um den zweiten Faktor zu übernehmen.
 */

import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from "node:crypto";

/** Zeitschritt in Sekunden (RFC-6238-Default, von allen gängigen Apps erwartet). */
export const TOTP_STEP_SECONDS = 30;
/** Stellenzahl des Codes (RFC-6238-Default). */
export const TOTP_DIGITS = 6;
/**
 * Toleranz in Zeitschritten nach vorn und hinten. 1 bedeutet: der vorherige,
 * der aktuelle und der nächste Code werden akzeptiert (± 30 s Uhrendrift).
 * Größere Fenster vergrößern die Ratefläche linear — 1 ist die übliche Wahl.
 */
export const TOTP_WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC-4648-Base32 ohne Padding — das Format, das Authenticator-Apps erwarten. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Umkehrung von base32Encode. Wirft bei Zeichen außerhalb des Alphabets. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Ungültiges Base32-Zeichen im TOTP-Secret.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * HOTP nach RFC 4226: HMAC-SHA-1 über den 8-Byte-Zähler, dann dynamische
 * Trunkierung auf `digits` Stellen.
 */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const counterBuf = Buffer.alloc(8);
  // Zähler als 64-Bit big-endian. Über writeBigUInt64BE, weil ein
  // 32-Bit-Schreibvorgang ab Zeitschritt 2^31 (Jahr 4020) still überliefe —
  // billiger als eine Fußnote, die irgendwann falsch wird.
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/** Zeitschritt-Zähler für einen Zeitpunkt (Default: jetzt). */
export function totpCounter(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** Erzeugt den erwarteten Code für einen Zeitpunkt — nur für Tests und Dev-Hilfen. */
export function totpCode(secretBase32: string, at: Date = new Date()): string {
  return hotp(base32Decode(secretBase32), totpCounter(at));
}

/**
 * Prüft einen eingegebenen Code gegen das Secret.
 *
 * Rückgabe enthält den akzeptierten Zeitschritt, damit der Aufrufer ihn
 * persistieren und **Wiederverwendung desselben Codes verhindern** kann: Ohne
 * diese Sperre bliebe ein abgefangener Code bis zu 90 Sekunden lang gültig.
 * Der Vergleich läuft zeitkonstant, damit die Antwortzeit keine Stelle verrät.
 */
export function verifyTotp(
  secretBase32: string,
  eingabe: string,
  opts: { at?: Date; letzterVerwendeterStep?: number | null } = {}
): { ok: true; step: number } | { ok: false; grund: "format" | "falsch" | "wiederverwendet" } {
  const code = eingabe.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false, grund: "format" };

  const secret = base32Decode(secretBase32);
  const jetzt = totpCounter(opts.at ?? new Date());
  const codeBuf = Buffer.from(code, "utf8");

  let treffer: number | null = null;
  // Bewusst ohne early return: Es werden immer alle Fenster geprüft, damit die
  // Laufzeit nicht verrät, welcher Zeitschritt gepasst hat.
  for (let d = -TOTP_WINDOW_STEPS; d <= TOTP_WINDOW_STEPS; d++) {
    const step = jetzt + d;
    const erwartet = Buffer.from(hotp(secret, step), "utf8");
    if (erwartet.length === codeBuf.length && timingSafeEqual(erwartet, codeBuf)) {
      treffer = step;
    }
  }

  if (treffer === null) return { ok: false, grund: "falsch" };
  if (opts.letzterVerwendeterStep != null && treffer <= opts.letzterVerwendeterStep) {
    return { ok: false, grund: "wiederverwendet" };
  }
  return { ok: true, step: treffer };
}

/** Neues Secret: 20 Byte Zufall (RFC-4226-Empfehlung), base32-kodiert. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * otpauth://-URI für den QR-Code der Authenticator-App.
 * `konto` erscheint in der App als Kontoname — hier bewusst die E-Mail, damit ein
 * Admin mit mehreren Mandanten die Einträge auseinanderhalten kann.
 */
export function otpauthUri(params: { secretBase32: string; konto: string; herausgeber: string }): string {
  const label = encodeURIComponent(`${params.herausgeber}:${params.konto}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.herausgeber,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Verschlüsselung des Secrets für die Ablage in der Datenbank
// ---------------------------------------------------------------------------

/**
 * Schlüssel aus TOTP_ENC_KEY. In Produktion Pflicht (fail-closed, analog
 * IP_HASH_SALT in crypto.ts); außerhalb von Produktion ein abgeleiteter
 * Entwicklungs-Schlüssel, damit lokale Setups ohne Konfiguration laufen.
 */
function encKey(): Buffer {
  const roh = process.env.TOTP_ENC_KEY;
  if (!roh) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TOTP_ENC_KEY fehlt — in Produktion erforderlich (kein Klartext-Fallback).");
    }
    return createHash("sha256").update("dev-only-totp-key").digest();
  }
  // Beliebig lange Passphrase auf 32 Byte normalisieren.
  return createHash("sha256").update(roh, "utf8").digest();
}

/** AES-256-GCM. Format: v1.<iv-hex>.<tag-hex>.<ciphertext-hex> */
export function encryptTotpSecret(secretBase32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return `v1.${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
}

/** Umkehrung von encryptTotpSecret. Wirft bei Formatfehler oder falschem Schlüssel. */
export function decryptTotpSecret(gespeichert: string): string {
  const teile = gespeichert.split(".");
  if (teile.length !== 4 || teile[0] !== "v1") {
    throw new Error("TOTP-Secret hat ein unbekanntes Format.");
  }
  const [, ivHex, tagHex, ctHex] = teile;
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Wiederherstellungscodes
// ---------------------------------------------------------------------------

/** Anzahl der bei der Einrichtung ausgegebenen Codes. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Erzeugt Wiederherstellungscodes im Format XXXXX-XXXXX (Base32-Alphabet ohne
 * mehrdeutige Zeichen, 50 Bit Entropie je Code). Rückgabe im Klartext — der
 * Aufrufer zeigt sie einmalig an und speichert nur die Hashes.
 */
export function generateRecoveryCodes(anzahl: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < anzahl; i++) {
    const roh = base32Encode(randomBytes(7)).slice(0, 10);
    codes.push(`${roh.slice(0, 5)}-${roh.slice(5, 10)}`);
  }
  return codes;
}

/**
 * Normalisiert und hasht einen Wiederherstellungscode. SHA-256 ohne Salt ist hier
 * richtig: Die Codes sind hochentropischer Zufall, kein vom Menschen gewähltes
 * Geheimnis — dieselbe Begründung wie bei Session-Tokens.
 */
export function hashRecoveryCode(code: string): string {
  const normalisiert = code.toUpperCase().replace(/[^A-Z2-7]/g, "");
  return createHash("sha256").update(`recovery:${normalisiert}`, "utf8").digest("hex");
}
