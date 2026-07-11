/**
 * crypto.ts — kryptografische Hilfsfunktionen für Auth
 *
 * Roh-Token: 32 Bytes crypto.randomBytes → base64url (URL-sicher, kein Padding)
 * Hash: SHA-256-Hex des Roh-Tokens — wird in der DB gespeichert.
 * Der Roh-Token verlässt niemals den Server-Speicher (kein Logging, kein Speichern).
 */

import { randomBytes, createHash, createHmac } from "node:crypto";

/**
 * Erzeugt ein kryptografisch sicheres Roh-Token (32 Bytes, base64url-kodiert).
 * Niemals loggen oder dauerhaft speichern.
 */
export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Hasht ein Token (oder beliebige Zeichenkette) mit SHA-256.
 * Gibt den Hex-Digest zurück.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * HMAC-SHA-256 für IP-Hashing mit Salt.
 * Salt kommt aus process.env.IP_HASH_SALT.
 * In Produktion ist der Salt PFLICHT (sonst wäre der Hash ungesalzen und über den
 * IPv4-Raum brute-forcebar → Bruch der Pseudonymisierung). Fehlt er in Produktion,
 * wird hart geworfen (fail-closed, analog ANLIEGEN_REF_SALT). Nur außerhalb von
 * Produktion ist der ungesalzene SHA-256-Fallback für lokale Dev-Umgebungen erlaubt.
 */
export function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT;
  if (!salt) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("IP_HASH_SALT fehlt — in Produktion erforderlich (kein ungesalzener Fallback).");
    }
    return sha256Hex(`ip:${ip}`);
  }
  return createHmac("sha256", salt).update(ip).digest("hex");
}

/**
 * HMAC-SHA-256 für Rate-Limit-Key-Hashing (B1/M1/M3).
 * Wird für BEIDE Scopes (email und ip) genutzt.
 *
 * E-Mail-Keys: hmacRateLimit(tenantId + ':' + email)
 * IP-Keys:     hmacRateLimit(ip)
 *
 * Salt kommt aus process.env.IP_HASH_SALT (gleicher Salt; beide sind Pseudonymisierungs-Hashes).
 * Bei fehlendem Salt: SHA-256 ohne HMAC (Dev-Fallback).
 */
export function hmacRateLimit(key: string): string {
  const salt = process.env.IP_HASH_SALT;
  if (!salt) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("IP_HASH_SALT fehlt — in Produktion erforderlich (kein ungesalzener Fallback).");
    }
    return sha256Hex(`rl:${key}`);
  }
  return createHmac("sha256", salt).update(key).digest("hex");
}
