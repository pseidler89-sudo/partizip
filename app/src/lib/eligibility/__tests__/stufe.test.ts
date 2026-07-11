/**
 * stufe.test.ts — Eligibility-Stufenmodell (ADR-003) inkl. N3-Mindestalter-Durchsetzung.
 */

import { describe, it, expect } from "vitest";
import { getStufe } from "../stufe";

const aktiv = {
  verificationStatus: "pending" as const,
  residencyVerifiedAt: null,
  accountStatus: "active" as const,
  minAgeConfirmedAt: new Date(),
};

describe("getStufe", () => {
  it("null user → Stufe 0", () => {
    expect(getStufe(null)).toBe(0);
  });

  it("nicht aktiver Account (locked/deleted) → Stufe 0", () => {
    expect(getStufe({ ...aktiv, accountStatus: "locked" })).toBe(0);
    expect(getStufe({ ...aktiv, accountStatus: "deleted" })).toBe(0);
  });

  it("N3: ohne bestätigtes Mindestalter → Stufe 0, selbst wenn aktiv + verifiziert", () => {
    expect(getStufe({ ...aktiv, minAgeConfirmedAt: null })).toBe(0);
    expect(
      getStufe({
        ...aktiv,
        minAgeConfirmedAt: null,
        verificationStatus: "verified",
        residencyVerifiedAt: new Date(),
      }),
    ).toBe(0);
  });

  it("aktiv + Mindestalter bestätigt, unverifiziert → Stufe 1", () => {
    expect(getStufe(aktiv)).toBe(1);
  });

  it("Wohnsitz verifiziert (verification_status) → Stufe 2", () => {
    expect(getStufe({ ...aktiv, verificationStatus: "verified" })).toBe(2);
  });

  it("Wohnsitz verifiziert (residency_verified_at) → Stufe 2", () => {
    expect(getStufe({ ...aktiv, residencyVerifiedAt: new Date() })).toBe(2);
  });

  // ADR-014 Block 2: Ablauf der Wohnsitz-Verifizierung.
  it("ADR-014: residencyVerifiedUntil in der Vergangenheit → zurück auf Stufe 1", () => {
    const verifiziert = {
      ...aktiv,
      verificationStatus: "verified" as const,
      residencyVerifiedAt: new Date("2024-01-01T00:00:00Z"),
    };
    const abgelaufen = new Date(Date.now() - 60_000); // vor einer Minute
    expect(getStufe({ ...verifiziert, residencyVerifiedUntil: abgelaufen })).toBe(1);
  });

  it("ADR-014: residencyVerifiedUntil in der Zukunft → bleibt Stufe 2", () => {
    const verifiziert = {
      ...aktiv,
      verificationStatus: "verified" as const,
      residencyVerifiedAt: new Date(),
    };
    const gueltig = new Date(Date.now() + 24 * 60 * 60 * 1000); // morgen
    expect(getStufe({ ...verifiziert, residencyVerifiedUntil: gueltig })).toBe(2);
  });

  it("ADR-014: residencyVerifiedUntil = null (grandfathered) → bleibt Stufe 2", () => {
    expect(
      getStufe({
        ...aktiv,
        verificationStatus: "verified",
        residencyVerifiedAt: new Date(),
        residencyVerifiedUntil: null,
      }),
    ).toBe(2);
  });

  it("ADR-014: abgelaufen schlägt verification_status='verified' — Stufe 1, nicht 2", () => {
    // Auch wenn verificationStatus 'verified' bleibt: ein gesetzter, abgelaufener
    // residencyVerifiedUntil drückt die Stufe auf 1 (Ablauf gewinnt).
    expect(
      getStufe({
        ...aktiv,
        verificationStatus: "verified",
        residencyVerifiedAt: new Date(),
        residencyVerifiedUntil: new Date(Date.now() - 1000),
      }),
    ).toBe(1);
  });
});
