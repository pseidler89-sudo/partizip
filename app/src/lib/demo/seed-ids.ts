/**
 * demo/seed-ids.ts — kanonische Quelle der deterministischen Seed-IDs.
 *
 * Die Musterstadt-Seeds (scripts/seed-musterstadt.ts) erzeugen ihre Datensätze
 * mit deterministischen UUID-v5-IDs. Reset-Skript UND Server-Actions müssen
 * dieselben IDs kennen: das Reset-Skript, um Besucher-Spielstände von den
 * kuratierten Seed-Daten zu trennen; die Actions, um die Seed-Fragen/-Digests
 * des Demo-Rundgangs vor Veränderung durch ephemere Demo-Admins zu schützen.
 * Vorher lebte uuidV5 nur in scripts/seed-utils.ts — von dort re-exportiert
 * (KEINE Drift), damit App-Code keine scripts/-Datei importieren muss.
 *
 * BEWUSST ohne "use server" und ohne DB-Abhängigkeit: reine Funktionen,
 * nutzbar aus Actions, Skripten und Unit-Tests.
 */

import { createHash } from "node:crypto";

/** Namespace-UUID der Seed-Skripte (UUID-v5 DNS namespace, RFC 4122). */
export const SEED_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Deterministische UUID v5 (RFC 4122 name-based, SHA-1): natürlicher Schlüssel →
 * immer dieselbe UUID → idempotente Inserts über onConflictDoNothing/-Update.
 */
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

/**
 * Seed-Schlüssel der drei Musterstadt-Beispiel-Fragen — MUSS den in
 * scripts/seed-musterstadt.ts verwendeten Keys entsprechen (dort: id("poll:…")).
 */
export const MUSTERSTADT_SEED_POLL_KEYS = [
  "poll:offen",
  "poll:verbindlich",
  "poll:geschlossen",
] as const;

/** Seed-Schlüssel des veröffentlichten Musterstadt-Beispiel-Digests (id("digest")). */
export const MUSTERSTADT_SEED_DIGEST_KEYS = ["digest"] as const;

/** Deterministische ID eines Musterstadt-Seed-Datensatzes (== seed-musterstadt.ts). */
export function musterstadtSeedId(slug: string, key: string): string {
  return uuidV5(SEED_NAMESPACE, `musterstadt:${slug}:${key}`);
}

/** Die drei Seed-Poll-IDs des Demo-Mandanten (für Reset-NOT-IN und Guards). */
export function musterstadtSeedPollIds(slug: string): string[] {
  return MUSTERSTADT_SEED_POLL_KEYS.map((key) => musterstadtSeedId(slug, key));
}

/** Ist die Poll-ID eine der drei kuratierten Musterstadt-Seed-Fragen? */
export function istMusterstadtSeedPollId(slug: string, pollId: string): boolean {
  return musterstadtSeedPollIds(slug).includes(pollId);
}

/** Ist die Digest-ID der kuratierte Musterstadt-Beispiel-Digest? */
export function istMusterstadtSeedDigestId(slug: string, digestId: string): boolean {
  return MUSTERSTADT_SEED_DIGEST_KEYS.some(
    (key) => musterstadtSeedId(slug, key) === digestId,
  );
}
