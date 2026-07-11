/**
 * flag-gate.test.ts — Unit-Test für das serverseitige Anliegen-Feature-Gate.
 *
 * ADR-014: Solange FEATURE_ANLIEGEN_EINREICHEN=false ist, MUSS createAnliegen
 * hart ablehnen — unabhängig von Auth/DB — damit die Server-Action nicht über
 * einen Direktaufruf umgangen werden kann. Der Gate-Check steht vor jedem
 * Auth-/DB-Zugriff, daher braucht dieser Test keine DB.
 *
 * next/headers wird gemockt, weil das Action-Modul es importiert; aufgerufen wird
 * es im deaktivierten Pfad nicht (Early Return).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, set: () => {} }),
  headers: () => ({ get: () => null }),
}));

import { createAnliegen } from "@/lib/anliegen/actions";
import { FEATURE_ANLIEGEN_EINREICHEN } from "@/lib/features";

describe("Anliegen Feature-Gate (serverseitig)", () => {
  it("createAnliegen lehnt bei deaktiviertem Flag hart ab (ohne Auth/DB)", async () => {
    // Dieser Test ist nur aussagekräftig, solange das Modul im Pilot deaktiviert
    // ist. Wird es aktiviert, entfällt der Early-Return-Pfad (Test überspringen).
    if (FEATURE_ANLIEGEN_EINREICHEN) {
      expect(FEATURE_ANLIEGEN_EINREICHEN).toBe(true);
      return;
    }
    const res = await createAnliegen({ titel: "Direktaufruf-Versuch" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Diese Funktion ist derzeit nicht aktiv.");
    expect(res.trackingCode).toBeUndefined();
  });
});
