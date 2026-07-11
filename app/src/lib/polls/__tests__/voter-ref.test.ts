/**
 * voter-ref.test.ts — Unit-Tests für die Pseudonymisierung der Stimmen (M3).
 *
 * ADR-014: Mitstimmen erfordert ein Konto (Stufe 1) — der anonyme Device-Pfad
 * entfällt. Es gibt nur noch die User-Domain. Schwerpunkt: Determinismus
 * (Dedup-Voraussetzung), Salt-Abhängigkeit und das saubere Domain-Präfix.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  computeVoterRefForUser,
  computeVoterRefForUserWithSalt,
  computeVoterRefFromDomain,
  VOTER_REF_DOMAINS,
} from "@/lib/polls/voter-ref";

const SALT = "test-salt-32-bytes-xxxxxxxxxxxxxxxxx";

describe("voter-ref — env-Salt (computeVoterRefForUser, SIA Loop 3 + Roadmap)", () => {
  const origAnliegen = process.env.ANLIEGEN_REF_SALT;
  const origVote = process.env.VOTE_REF_SALT;
  afterEach(() => {
    if (origAnliegen === undefined) delete process.env.ANLIEGEN_REF_SALT;
    else process.env.ANLIEGEN_REF_SALT = origAnliegen;
    if (origVote === undefined) delete process.env.VOTE_REF_SALT;
    else process.env.VOTE_REF_SALT = origVote;
  });

  it("nutzt ANLIEGEN_REF_SALT als Fallback und entspricht der explizit gesalzenen Variante", () => {
    process.env.ANLIEGEN_REF_SALT = SALT;
    delete process.env.VOTE_REF_SALT;
    expect(computeVoterRefForUser("user-1")).toBe(
      computeVoterRefForUserWithSalt(SALT, "user-1")
    );
  });

  it("bevorzugt VOTE_REF_SALT, wenn gesetzt (≠ Anliegen-Salt-Ableitung)", () => {
    process.env.ANLIEGEN_REF_SALT = SALT;
    process.env.VOTE_REF_SALT = "dediziertes-vote-salt-yyyyyyyyyyyyy";
    // Ergebnis entspricht der VOTE_REF_SALT-Ableitung …
    expect(computeVoterRefForUser("user-1")).toBe(
      computeVoterRefForUserWithSalt("dediziertes-vote-salt-yyyyyyyyyyyyy", "user-1")
    );
    // … und unterscheidet sich von der Ableitung mit dem Anliegen-Salt.
    expect(computeVoterRefForUser("user-1")).not.toBe(
      computeVoterRefForUserWithSalt(SALT, "user-1")
    );
  });

  it("wirft fail-closed, wenn beide Salts fehlen", () => {
    delete process.env.ANLIEGEN_REF_SALT;
    delete process.env.VOTE_REF_SALT;
    expect(() => computeVoterRefForUser("user-1")).toThrow(/ANLIEGEN_REF_SALT/);
  });
});

describe("voter-ref (User-Domain, ADR-014)", () => {
  it("ist deterministisch (gleicher Input → gleicher Ref)", () => {
    const a = computeVoterRefForUserWithSalt(SALT, "user-123");
    const b = computeVoterRefForUserWithSalt(SALT, "user-123");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("verschiedene User → verschiedene Refs", () => {
    expect(computeVoterRefForUserWithSalt(SALT, "a")).not.toBe(
      computeVoterRefForUserWithSalt(SALT, "b")
    );
  });

  it("hängt vom Salt ab (anderer Salt → anderer Ref)", () => {
    expect(computeVoterRefForUserWithSalt(SALT, "user-1")).not.toBe(
      computeVoterRefForUserWithSalt("anderer-salt", "user-1")
    );
  });

  it("User-Domain-Präfix wird konsistent angewandt", () => {
    const manual = computeVoterRefFromDomain(
      SALT,
      VOTER_REF_DOMAINS.USER_DOMAIN_PREFIX + "u1"
    );
    expect(manual).toBe(computeVoterRefForUserWithSalt(SALT, "u1"));
    expect(VOTER_REF_DOMAINS.USER_DOMAIN_PREFIX).toBe("vote:user:");
  });
});
