/**
 * crypto.test.ts — Unit-Tests für die Pseudonymisierungs-Hashes (SIA Loop 3).
 *
 * Deckt den Loop-2-Fix ab: hashIp()/hmacRateLimit() MÜSSEN in Produktion bei
 * fehlendem IP_HASH_SALT werfen (fail-closed) und dürfen NUR außerhalb von
 * Produktion auf ungesalzenes SHA-256 zurückfallen. Kein DB-Bedarf.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { hashIp, hmacRateLimit, sha256Hex } from "@/lib/auth/crypto";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("crypto — hashIp / hmacRateLimit (fail-closed)", () => {
  it("wirft in Produktion ohne IP_HASH_SALT (fail-closed)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IP_HASH_SALT", "");
    expect(() => hashIp("1.2.3.4")).toThrow(/IP_HASH_SALT/);
    expect(() => hmacRateLimit("k")).toThrow(/IP_HASH_SALT/);
  });

  it("fällt außerhalb Produktion ohne Salt auf SHA-256 zurück (Dev-Fallback, wirft NICHT)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("IP_HASH_SALT", "");
    expect(() => hashIp("1.2.3.4")).not.toThrow();
    expect(hashIp("1.2.3.4")).toBe(sha256Hex("ip:1.2.3.4"));
    expect(hmacRateLimit("k")).toBe(sha256Hex("rl:k"));
  });

  it("mit Salt: deterministisch, salt-abhängig, != ungesalzenes SHA-256", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IP_HASH_SALT", "salt-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const a1 = hashIp("9.9.9.9");
    const a2 = hashIp("9.9.9.9");
    expect(a1).toBe(a2); // deterministisch
    expect(a1).not.toBe(sha256Hex("ip:9.9.9.9")); // gesalzen ≠ ungesalzen

    vi.stubEnv("IP_HASH_SALT", "salt-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    const b1 = hashIp("9.9.9.9");
    expect(b1).not.toBe(a1); // anderer Salt → anderer Hash
  });
});
