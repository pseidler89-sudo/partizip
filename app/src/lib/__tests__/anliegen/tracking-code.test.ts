/**
 * tracking-code.test.ts — Tests für Tracking-Code-Generierung (M8)
 *
 * Prüft: Format, Alphabet, Entropie-Plausibilität, Kollisions-Retry
 */

import { describe, it, expect, vi } from "vitest";
import {
  generateTrackingCode,
  isValidTrackingCodeFormat,
  generateUniqueTrackingCode,
  TRACKING_CODE_ALPHABET,
} from "@/lib/anliegen/tracking-code";

describe("generateTrackingCode", () => {
  it("generiert einen Code im Format TS-XXXX-XXXX", () => {
    const code = generateTrackingCode();
    expect(code).toMatch(/^TS-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("enthält nur Zeichen aus dem definierten Alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateTrackingCode();
      const parts = code.split("-");
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe("TS");

      for (const ch of parts[1] + parts[2]) {
        expect(TRACKING_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it("enthält keine verwechselbaren Zeichen (0, O, 1, I, L)", () => {
    const forbidden = new Set(["0", "O", "1", "I", "L"]);
    for (let i = 0; i < 200; i++) {
      const code = generateTrackingCode();
      for (const ch of code) {
        expect(forbidden.has(ch)).toBe(false);
      }
    }
  });

  it("Alphabet hat mindestens 30 Zeichen (keine verwechselbaren)", () => {
    // ABCDEFGHJKMNPQRSTUVWXYZ23456789 = 31 Zeichen (ohne 0,O,1,I,L)
    expect(TRACKING_CODE_ALPHABET.length).toBeGreaterThanOrEqual(30);
    // Alle Zeichen eindeutig
    const unique = new Set(TRACKING_CODE_ALPHABET.split(""));
    expect(unique.size).toBe(TRACKING_CODE_ALPHABET.length);
    // 8 Zeichen × log2(31) ≈ 39.7 bit Entropie
    const entropyCoverageBits = 8 * Math.log2(TRACKING_CODE_ALPHABET.length);
    expect(entropyCoverageBits).toBeGreaterThan(38);
  });

  it("erzeugt keine Duplikate in 10k Läufen (Entropie-Plausibilität)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      codes.add(generateTrackingCode());
    }
    // Keine Duplikate (40 bit Entropie → P(Kollision in 10k) ≈ 0)
    expect(codes.size).toBe(10_000);
  });

  it("Codes haben immer 12 Zeichen (TS-XXXX-XXXX)", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateTrackingCode()).toHaveLength(12);
    }
  });
});

describe("isValidTrackingCodeFormat", () => {
  it("akzeptiert gültige Codes", () => {
    // Alphabet: ABCDEFGHJKMNPQRSTUVWXYZ23456789 (kein 0,O,1,I,L)
    expect(isValidTrackingCodeFormat("TS-ABCD-2345")).toBe(true);
    expect(isValidTrackingCodeFormat("TS-WXYZ-MNPQ")).toBe(true);
    expect(isValidTrackingCodeFormat("TS-2345-6789")).toBe(true);
    expect(isValidTrackingCodeFormat("TS-ABCD-EFGH")).toBe(true);
  });

  it("lehnt ungültige Codes ab", () => {
    expect(isValidTrackingCodeFormat("")).toBe(false);
    expect(isValidTrackingCodeFormat("TS-ABC-2345")).toBe(false); // 3+4 statt 4+4
    expect(isValidTrackingCodeFormat("RS-ABCD-2345")).toBe(false); // falsches Präfix
    expect(isValidTrackingCodeFormat("TS-ABCD")).toBe(false); // zu kurz
    expect(isValidTrackingCodeFormat("TS-AB0D-2345")).toBe(false); // 0 verboten
    expect(isValidTrackingCodeFormat("TS-ABOD-2345")).toBe(false); // O verboten
    expect(isValidTrackingCodeFormat("TS-AB1D-2345")).toBe(false); // 1 verboten
  });

  it("generierte Codes sind immer gültig", () => {
    for (let i = 0; i < 100; i++) {
      expect(isValidTrackingCodeFormat(generateTrackingCode())).toBe(true);
    }
  });
});

describe("generateUniqueTrackingCode", () => {
  it("gibt Code zurück wenn erste Prüfung true ergibt", async () => {
    const isUnique = vi.fn().mockResolvedValue(true);
    const code = await generateUniqueTrackingCode(isUnique);
    expect(isValidTrackingCodeFormat(code)).toBe(true);
    expect(isUnique).toHaveBeenCalledTimes(1);
  });

  it("wiederholt bei Kollision (retry)", async () => {
    // Erste 2 Aufrufe: Kollision (false), dritter: frei (true)
    const isUnique = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const code = await generateUniqueTrackingCode(isUnique);
    expect(isValidTrackingCodeFormat(code)).toBe(true);
    expect(isUnique).toHaveBeenCalledTimes(3);
  });

  it("wirft Error nach 5 gescheiterten Versuchen", async () => {
    const isUnique = vi.fn().mockResolvedValue(false);
    await expect(generateUniqueTrackingCode(isUnique)).rejects.toThrow();
    expect(isUnique).toHaveBeenCalledTimes(5);
  });
});
