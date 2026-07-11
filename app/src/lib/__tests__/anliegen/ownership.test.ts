/**
 * ownership.test.ts — Pure-Logik-Tests für M3 (Zurückziehen) und die
 * Pseudonym-Ownership des Anliegens.
 *
 * Kein DB-Zugriff: getestet wird die deterministische creator_ref-Ableitung
 * (Grundlage des Ownership-Vergleichs in zurueckziehenAnliegen) und die
 * Menge der zurückziehbaren Status.
 */

import { describe, it, expect } from "vitest";
import { computeCreatorRefWithSalt } from "@/lib/anliegen/creator-ref";

// Muss zu WITHDRAWABLE_STATES in src/lib/anliegen/actions.ts und der Set in
// src/app/[tenant]/anliegen/[code]/page.tsx passen.
const WITHDRAWABLE = new Set([
  "eingegangen",
  "in_pruefung",
  "im_gremium",
  "beantwortet",
]);

const ALL_STATES = [
  "eingegangen",
  "in_pruefung",
  "im_gremium",
  "beantwortet",
  "umgesetzt",
  "abgelehnt",
  "zurueckgezogen",
];

describe("creator_ref Ownership (M3)", () => {
  const salt = "test-salt-0123456789abcdef0123456789abcdef";

  it("ist deterministisch: gleicher User → gleicher creator_ref", () => {
    const a = computeCreatorRefWithSalt(salt, "user-1");
    const b = computeCreatorRefWithSalt(salt, "user-1");
    expect(a).toBe(b);
  });

  it("unterscheidet verschiedene User (Ownership-Trennung)", () => {
    const a = computeCreatorRefWithSalt(salt, "user-1");
    const b = computeCreatorRefWithSalt(salt, "user-2");
    expect(a).not.toBe(b);
  });

  it("ist pseudonym: creator_ref enthält die userId nicht im Klartext", () => {
    const ref = computeCreatorRefWithSalt(salt, "user-1");
    expect(ref).not.toContain("user-1");
  });

  it("Ownership-Vergleich: nur der Ersteller matcht den gespeicherten creator_ref", () => {
    // Simuliert die Prüfung in zurueckziehenAnliegen: gespeicherter Wert stammt
    // vom Ersteller; ein anderer User berechnet einen anderen Wert.
    const stored = computeCreatorRefWithSalt(salt, "creator");
    expect(computeCreatorRefWithSalt(salt, "creator") === stored).toBe(true);
    expect(computeCreatorRefWithSalt(salt, "angreifer") === stored).toBe(false);
  });

  it("unterschiedlicher Salt → unterschiedlicher creator_ref (Salt-Bindung)", () => {
    const a = computeCreatorRefWithSalt("salt-a", "user-1");
    const b = computeCreatorRefWithSalt("salt-b", "user-1");
    expect(a).not.toBe(b);
  });
});

describe("Zurückziehbare Status (M3 Designentscheidung)", () => {
  it("aktive Bearbeitungs-Status sind zurückziehbar", () => {
    expect(WITHDRAWABLE.has("eingegangen")).toBe(true);
    expect(WITHDRAWABLE.has("in_pruefung")).toBe(true);
    expect(WITHDRAWABLE.has("im_gremium")).toBe(true);
    expect(WITHDRAWABLE.has("beantwortet")).toBe(true);
  });

  it("terminale Status sind NICHT zurückziehbar", () => {
    expect(WITHDRAWABLE.has("umgesetzt")).toBe(false);
    expect(WITHDRAWABLE.has("abgelehnt")).toBe(false);
  });

  it("ein bereits zurückgezogenes Anliegen ist nicht erneut zurückziehbar (Idempotenz)", () => {
    expect(WITHDRAWABLE.has("zurueckgezogen")).toBe(false);
  });

  it("jeder zurückziehbare Status ist ein gültiger Anliegen-Status", () => {
    for (const s of WITHDRAWABLE) {
      expect(ALL_STATES).toContain(s);
    }
  });
});
