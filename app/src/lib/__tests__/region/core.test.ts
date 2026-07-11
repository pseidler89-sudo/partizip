/**
 * core.test.ts — reine Unit-Tests der Region-Helfer (ADR-015), ohne DB.
 */

import { describe, it, expect } from "vitest";
import {
  serializeRegionCookie,
  parseRegionCookie,
  normalizePlz,
  isValidPlz,
  coercePlz,
  haversineKm,
} from "@/lib/region/core";

describe("region/core — Cookie-Kodierung", () => {
  it("serialisiert null/leer zum Stadt-Sentinel", () => {
    expect(serializeRegionCookie(null)).toBe("-");
    expect(serializeRegionCookie("")).toBe("-");
  });

  it("serialisiert einen Ortsteil-Code unverändert", () => {
    expect(serializeRegionCookie("wehen")).toBe("wehen");
  });

  it("parst fehlendes/leeres Cookie als null (→ Haustür)", () => {
    expect(parseRegionCookie(undefined)).toBeNull();
    expect(parseRegionCookie(null)).toBeNull();
    expect(parseRegionCookie("")).toBeNull();
    expect(parseRegionCookie("   ")).toBeNull();
  });

  it("parst Sentinel als bestätigte Region ohne Ortsteil", () => {
    expect(parseRegionCookie("-")).toEqual({ ortsteilCode: null });
  });

  it("parst gültigen Ortsteil-Code", () => {
    expect(parseRegionCookie("wehen")).toEqual({ ortsteilCode: "wehen" });
    expect(parseRegionCookie(" wehen ")).toEqual({ ortsteilCode: "wehen" });
  });

  it("behandelt unplausible Werte defensiv als Stadt-Ebene (kein Fehler)", () => {
    expect(parseRegionCookie("DROP TABLE users")).toEqual({ ortsteilCode: null });
    expect(parseRegionCookie("../../etc")).toEqual({ ortsteilCode: null });
  });

  it("round-trip: serialize → parse", () => {
    expect(parseRegionCookie(serializeRegionCookie("wehen"))).toEqual({ ortsteilCode: "wehen" });
    expect(parseRegionCookie(serializeRegionCookie(null))).toEqual({ ortsteilCode: null });
  });
});

describe("region/core — PLZ", () => {
  it("normalisiert auf reine Ziffern", () => {
    expect(normalizePlz("65232")).toBe("65232");
    expect(normalizePlz(" 65 232 ")).toBe("65232");
    expect(normalizePlz("abc")).toBe("");
  });

  it("validiert 5-stellige PLZ", () => {
    expect(isValidPlz("65232")).toBe(true);
    expect(isValidPlz(" 65232 ")).toBe(true);
    expect(isValidPlz("652")).toBe(false);
    expect(isValidPlz("652321")).toBe(false);
    expect(isValidPlz("abcde")).toBe(false);
  });

  it("coercePlz ergänzt bei 4 Ziffern eine führende 0 (Tippfehler-Toleranz)", () => {
    expect(coercePlz("1067")).toBe("01067"); // Dresden ohne führende Null
    expect(coercePlz(" 1067 ")).toBe("01067"); // inkl. Whitespace-Bereinigung
    expect(isValidPlz(coercePlz("1067"))).toBe(true);
  });

  it("coercePlz lässt 5-stellige und andere Längen unverändert (nur Ziffern)", () => {
    expect(coercePlz("65232")).toBe("65232");
    expect(coercePlz("65-232")).toBe("65232");
    expect(coercePlz("652")).toBe("652"); // bleibt ungültig → isValidPlz=false
    expect(isValidPlz(coercePlz("652"))).toBe(false);
  });
});

describe("region/core — Haversine", () => {
  it("Distanz zum selben Punkt ist (nahezu) 0", () => {
    expect(haversineKm(50.1466, 8.1505, 50.1466, 8.1505)).toBeLessThan(0.001);
  });

  it("1 Grad Breitengrad ≈ 111 km", () => {
    const d = haversineKm(50, 8, 51, 8);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it("ferne Punkte sind klar weit entfernt", () => {
    // Taunusstein → Berlin (~440 km)
    const d = haversineKm(50.1466, 8.1505, 52.52, 13.405);
    expect(d).toBeGreaterThan(400);
  });
});
