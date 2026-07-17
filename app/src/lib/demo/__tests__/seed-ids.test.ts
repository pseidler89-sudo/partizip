/**
 * seed-ids.test.ts — Unit-Tests der kanonischen Seed-ID-Bibliothek (Block I).
 *
 * Die Guards in polls/digest/actions und der nächtliche Reset hängen daran,
 * dass die hier erzeugten IDs EXAKT denen von scripts/seed-musterstadt.ts
 * entsprechen (uuid5 über `musterstadt:${slug}:${key}`). Reine Funktionen,
 * keine DB nötig.
 */

import { describe, it, expect } from "vitest";
import {
  SEED_NAMESPACE,
  uuidV5,
  musterstadtSeedId,
  musterstadtSeedPollIds,
  istMusterstadtSeedPollId,
  istMusterstadtSeedDigestId,
  MUSTERSTADT_SEED_POLL_KEYS,
} from "@/lib/demo/seed-ids";

describe("demo/seed-ids", () => {
  it("uuidV5 ist deterministisch und RFC-4122-konform (Version 5, Variante 10)", () => {
    const a = uuidV5(SEED_NAMESPACE, "musterstadt:demo:poll:offen");
    const b = uuidV5(SEED_NAMESPACE, "musterstadt:demo:poll:offen");
    expect(a).toBe(b);
    // Version-Nibble = 5, Variant-Bits = 10xx (8/9/a/b).
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("istMusterstadtSeedPollId: erkennt alle drei Seed-Poll-Keys", () => {
    for (const key of MUSTERSTADT_SEED_POLL_KEYS) {
      expect(istMusterstadtSeedPollId("demo", musterstadtSeedId("demo", key))).toBe(true);
    }
    expect(musterstadtSeedPollIds("demo")).toHaveLength(3);
  });

  it("istMusterstadtSeedPollId: fremde UUIDs und andere Seed-Keys sind KEINE Seed-Polls", () => {
    // Zufällige (nicht-deterministische) UUID.
    expect(istMusterstadtSeedPollId("demo", "123e4567-e89b-42d3-a456-426614174000")).toBe(false);
    // Der Seed-DIGEST ist keine Poll-ID.
    expect(istMusterstadtSeedPollId("demo", musterstadtSeedId("demo", "digest"))).toBe(false);
  });

  it("istMusterstadtSeedPollId: die IDs sind slug-gebunden (anderer Slug ⇒ andere IDs)", () => {
    const idDemo = musterstadtSeedId("demo", "poll:offen");
    expect(istMusterstadtSeedPollId("anderer-slug", idDemo)).toBe(false);
    expect(istMusterstadtSeedPollId("anderer-slug", musterstadtSeedId("anderer-slug", "poll:offen"))).toBe(true);
  });

  it("istMusterstadtSeedDigestId: erkennt den Seed-Digest, nicht die Poll-IDs", () => {
    expect(istMusterstadtSeedDigestId("demo", musterstadtSeedId("demo", "digest"))).toBe(true);
    expect(istMusterstadtSeedDigestId("demo", musterstadtSeedId("demo", "poll:offen"))).toBe(false);
    expect(istMusterstadtSeedDigestId("demo", "123e4567-e89b-42d3-a456-426614174000")).toBe(false);
  });
});
