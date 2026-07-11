/**
 * seed-utils.ts — geteilte Helfer der Seed-Skripte.
 *
 * Deterministische UUID v5 (RFC 4122 name-based, SHA-1): natürlicher Schlüssel →
 * immer dieselbe UUID → idempotente Inserts über onConflictDoNothing/-Update.
 * Vorher in seed.ts und seed-demo.ts dupliziert — hier EINMAL.
 */

import { createHash } from "node:crypto";

/** Namespace-UUID der Seed-Skripte (UUID-v5 DNS namespace, RFC 4122). */
export const SEED_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

export function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const sha1 = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(name, "utf-8")]))
    .digest();
  sha1[6] = (sha1[6] & 0x0f) | 0x50; // version 5
  sha1[8] = (sha1[8] & 0x3f) | 0x80; // variant 10
  const hex = sha1.toString("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
