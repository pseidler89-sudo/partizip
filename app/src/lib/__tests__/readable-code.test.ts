import { describe, it, expect } from "vitest";
import {
  generateReadableCode,
  readableCodePattern,
  READABLE_CODE_ALPHABET,
} from "@/lib/readable-code";

describe("readable-code", () => {
  it("erzeugt das Format PREFIX-XXXX-XXXX mit gültigem Alphabet", () => {
    const pattern = readableCodePattern("BELEG");
    for (let i = 0; i < 200; i++) {
      const code = generateReadableCode("BELEG");
      expect(code).toMatch(pattern);
      expect(code.startsWith("BELEG-")).toBe(true);
    }
  });

  it("nutzt ein Alphabet ohne mehrdeutige Zeichen (I, L, O, U)", () => {
    expect(READABLE_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(READABLE_CODE_ALPHABET.length).toBe(32);
  });

  it("das Pattern ist präfix-spezifisch (lehnt fremde Präfixe ab)", () => {
    const termin = readableCodePattern("TERMIN");
    expect(generateReadableCode("BELEG")).not.toMatch(termin);
    expect(generateReadableCode("TERMIN")).toMatch(termin);
  });

  it("erzeugt mit hoher Wahrscheinlichkeit verschiedene Codes (CSPRNG)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) codes.add(generateReadableCode("X"));
    // 40 Bit Entropie → bei 500 Ziehungen praktisch keine Kollision.
    expect(codes.size).toBe(500);
  });
});
