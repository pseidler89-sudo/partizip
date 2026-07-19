import { describe, it, expect } from "vitest";
import { istVerifiziert } from "../me-status";

describe("istVerifiziert", () => {
  it("true bei Stufe >= 2", () => {
    expect(istVerifiziert({ user: { stufe: 2, verificationStatus: "pending" } })).toBe(true);
    expect(istVerifiziert({ user: { stufe: 3, verificationStatus: "pending" } })).toBe(true);
  });

  it("true bei verificationStatus 'verified' (auch ohne Stufe)", () => {
    expect(istVerifiziert({ user: { verificationStatus: "verified" } })).toBe(true);
    expect(istVerifiziert({ user: { stufe: 1, verificationStatus: "verified" } })).toBe(true);
  });

  it("false bei Stufe < 2 und nicht verified", () => {
    expect(istVerifiziert({ user: { stufe: 1, verificationStatus: "pending" } })).toBe(false);
    expect(istVerifiziert({ user: { stufe: 0, verificationStatus: "rejected" } })).toBe(false);
  });

  it("tolerant bei fehlenden/leeren Feldern → false", () => {
    expect(istVerifiziert(null)).toBe(false);
    expect(istVerifiziert(undefined)).toBe(false);
    expect(istVerifiziert({})).toBe(false);
    expect(istVerifiziert({ user: null })).toBe(false);
    expect(istVerifiziert({ user: {} })).toBe(false);
    expect(istVerifiziert({ user: { stufe: null, verificationStatus: null } })).toBe(false);
  });
});
