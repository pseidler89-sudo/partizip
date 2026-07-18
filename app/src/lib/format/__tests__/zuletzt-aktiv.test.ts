/**
 * zuletzt-aktiv.test.ts — Unit-Tests der Kalendertag-Differenz + „Zuletzt
 * aktiv"-Formatierung (Block K4, Gate-B-Fix). FIXE Zeitpunkte (injiziertes
 * `jetzt`), dadurch zeitstabil — kein Date.now()-Wackler.
 *
 * Gate-B-Fund: die frühere Millisekunden-Division machte „heute" unerreichbar
 * (heutiger Login ⇒ „gestern", 25 h ⇒ „vor 2 Tagen"). Die Grenzfälle hier
 * pinnen das korrekte Verhalten fest.
 */

import { describe, it, expect } from "vitest";
import { kalendertagDiffBerlin, zuletztAktivLabel } from "@/lib/format/zuletzt-aktiv";

// Referenz-„jetzt": 15.07.2026, 14:00 Berlin (CEST, +02:00) = 12:00 UTC.
const JETZT = new Date("2026-07-15T12:00:00Z");

describe("kalendertagDiffBerlin", () => {
  it("gleicher Kalendertag ⇒ 0 (auch früh morgens: 00:30 Berlin)", () => {
    // 00:30 Berlin am 15.07. = 22:30 UTC am 14.07. — MS-Division ergäbe < -0,5 Tage.
    expect(kalendertagDiffBerlin(new Date("2026-07-14T22:30:00Z"), JETZT)).toBe(0);
    expect(kalendertagDiffBerlin(new Date("2026-07-15T11:59:00Z"), JETZT)).toBe(0);
  });

  it("gestern 23:59 Berlin ⇒ -1 (obwohl nur ~14 h her)", () => {
    // 23:59 Berlin am 14.07. = 21:59 UTC am 14.07.
    expect(kalendertagDiffBerlin(new Date("2026-07-14T21:59:00Z"), JETZT)).toBe(-1);
  });

  it("25 h her, aber Vortag ⇒ -1 (NICHT -2 — der alte Bug)", () => {
    // 13:00 Berlin am 14.07. = 11:00 UTC ⇒ 25 h vor JETZT, ein Kalendertag.
    expect(kalendertagDiffBerlin(new Date("2026-07-14T11:00:00Z"), JETZT)).toBe(-1);
  });

  it("Kalendertag-Grenze: 00:00 Berlin des heutigen Tages ⇒ 0; eine Minute davor ⇒ -1", () => {
    // 00:00 Berlin am 15.07. = 22:00 UTC am 14.07.
    expect(kalendertagDiffBerlin(new Date("2026-07-14T22:00:00Z"), JETZT)).toBe(0);
    expect(kalendertagDiffBerlin(new Date("2026-07-14T21:59:59Z"), JETZT)).toBe(-1);
  });

  it("-7 Tage exakt; DST-Grenze (Okt.) liefert ganze Tage", () => {
    expect(kalendertagDiffBerlin(new Date("2026-07-08T12:00:00Z"), JETZT)).toBe(-7);
    // Über die Herbst-Umstellung (25.10.2026): 24.10. 12:00 Berlin vs.
    // 26.10. 12:00 Berlin sind exakt 2 Kalendertage (49 h Realzeit).
    const vorher = new Date("2026-10-24T10:00:00Z"); // 12:00 CEST
    const nachher = new Date("2026-10-26T11:00:00Z"); // 12:00 CET
    expect(kalendertagDiffBerlin(vorher, nachher)).toBe(-2);
  });
});

describe("zuletztAktivLabel", () => {
  it("null/ungültig ⇒ Noch nie angemeldet", () => {
    expect(zuletztAktivLabel(null, JETZT)).toBe("Noch nie angemeldet");
    expect(zuletztAktivLabel("kein-datum", JETZT)).toBe("Noch nie angemeldet");
  });

  it("heutiger Login ⇒ heute (der alte Bug zeigte gestern)", () => {
    expect(zuletztAktivLabel("2026-07-15T06:00:00Z", JETZT)).toBe("Zuletzt aktiv: heute");
  });

  it("gestern ⇒ gestern (numeric:auto)", () => {
    expect(zuletztAktivLabel("2026-07-14T21:59:00Z", JETZT)).toBe("Zuletzt aktiv: gestern");
  });

  it("25 h her am Vortag ⇒ gestern (NICHT vor 2 Tagen — der alte Bug)", () => {
    expect(zuletztAktivLabel("2026-07-14T11:00:00Z", JETZT)).toBe("Zuletzt aktiv: gestern");
  });

  it("vor 7 Tagen ⇒ vor 7 Tagen", () => {
    expect(zuletztAktivLabel("2026-07-08T12:00:00Z", JETZT)).toBe("Zuletzt aktiv: vor 7 Tagen");
  });
});
