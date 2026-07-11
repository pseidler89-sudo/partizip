import { describe, it, expect } from "vitest";
import { isAdult } from "../age.js";

describe("isAdult", () => {
  // Hilfsfunktion: Datum aus year/month/day bauen (UTC-neutral)
  function d(year: number, month: number, day: number = 1) {
    return new Date(year, month - 1, day);
  }

  // --- NULL-Fälle (konservativ: immer false) ---

  it("gibt false zurück bei birthYear=null", () => {
    expect(isAdult(null, 6, d(2026, 7))).toBe(false);
  });

  it("gibt false zurück bei birthMonth=null", () => {
    expect(isAdult(2000, null, d(2026, 7))).toBe(false);
  });

  it("gibt false zurück bei beiden Werten null", () => {
    expect(isAdult(null, null, d(2026, 7))).toBe(false);
  });

  it("gibt false zurück bei birthYear=undefined", () => {
    expect(isAdult(undefined, 6, d(2026, 7))).toBe(false);
  });

  it("gibt false zurück bei birthMonth=undefined", () => {
    expect(isAdult(2000, undefined, d(2026, 7))).toBe(false);
  });

  // --- Klar volljährig ---

  it("ist volljährig wenn nowYear deutlich über birthYear+18", () => {
    // geboren 1990-06, jetzt 2026-07 → 36 Jahre → volljährig
    expect(isAdult(1990, 6, d(2026, 7))).toBe(true);
  });

  it("ist volljährig wenn nowYear genau birthYear+19", () => {
    // geboren 2007-03, jetzt 2026-04 → 19 Jahre → volljährig
    expect(isAdult(2007, 3, d(2026, 4))).toBe(true);
  });

  // --- Grenzfälle: genau 18 ---

  it("ist NICHT volljährig im Geburtsmonat selbst (Monat noch nicht abgelaufen)", () => {
    // geboren 2008-06, jetzt 2026-06 (18. Geburtstag läuft noch)
    expect(isAdult(2008, 6, d(2026, 6))).toBe(false);
  });

  it("ist NICHT volljährig am ersten Tag des Geburtsmonats", () => {
    // geboren 2008-06, jetzt 2026-06-01 → Monat noch nicht abgelaufen
    expect(isAdult(2008, 6, d(2026, 6, 1))).toBe(false);
  });

  it("ist NICHT volljährig am letzten Tag des Geburtsmonats (30. Juni)", () => {
    // geboren 2008-06, jetzt 2026-06-30 → Monat noch nicht vollständig abgelaufen
    expect(isAdult(2008, 6, d(2026, 6, 30))).toBe(false);
  });

  it("ist volljährig einen Monat NACH dem 18. Geburtsmonat", () => {
    // geboren 2008-06, jetzt 2026-07 → Monat vollständig abgelaufen
    expect(isAdult(2008, 6, d(2026, 7))).toBe(true);
  });

  it("ist NICHT volljährig einen Monat VOR dem 18. Geburtsmonat", () => {
    // geboren 2008-06, jetzt 2026-05 → noch unter 18
    expect(isAdult(2008, 6, d(2026, 5))).toBe(false);
  });

  // --- Dezember-Sonderfall ---

  it("ist NICHT volljährig im Dezember des 18. Jahres", () => {
    // geboren 2008-12, jetzt 2026-12 → Dezember noch nicht abgelaufen
    expect(isAdult(2008, 12, d(2026, 12))).toBe(false);
  });

  it("ist volljährig im Januar des Jahres NACH dem 18. Dezember-Geburtstag", () => {
    // geboren 2008-12, jetzt 2027-01 → Monat vollständig vorbei
    expect(isAdult(2008, 12, d(2027, 1))).toBe(true);
  });

  // --- Januar-Geburtstag ---

  it("ist NICHT volljährig im Januar des 18. Jahres", () => {
    // geboren 2008-01, jetzt 2026-01 → January noch nicht abgelaufen
    expect(isAdult(2008, 1, d(2026, 1))).toBe(false);
  });

  it("ist volljährig im Februar des 18. Jahres (Januar abgelaufen)", () => {
    // geboren 2008-01, jetzt 2026-02
    expect(isAdult(2008, 1, d(2026, 2))).toBe(true);
  });

  // --- Geburtsjahr = nowYear+18 nicht möglich in der Realität, aber logisch korrekt ---

  it("ist NICHT volljährig wenn nowYear < birthYear+18", () => {
    // geboren 2010-01, jetzt 2026-12 → erst 2028-01 volljährig
    expect(isAdult(2010, 1, d(2026, 12))).toBe(false);
  });

  // --- Monatsgrenze: Monat des 18. Geburtstags vs. jetzt ---

  it("ist volljährig wenn nowMonth > birthMonth im selben Jahr (year=birthYear+18)", () => {
    // geboren 2008-03, jetzt 2026-04 → 18, April nach März → volljährig
    expect(isAdult(2008, 3, d(2026, 4))).toBe(true);
  });

  it("ist NICHT volljährig wenn nowMonth < birthMonth im selben Jahr (year=birthYear+18)", () => {
    // geboren 2008-03, jetzt 2026-02 → 18 aber Monat noch nicht erreicht
    expect(isAdult(2008, 3, d(2026, 2))).toBe(false);
  });

  // --- N5: ungültige birthMonth-Werte (0 und 13) ---

  it("gibt false zurück bei birthMonth=0 (ungültig, außerhalb 1–12)", () => {
    expect(isAdult(2000, 0, d(2026, 7))).toBe(false);
  });

  it("gibt false zurück bei birthMonth=13 (ungültig, außerhalb 1–12)", () => {
    expect(isAdult(2000, 13, d(2026, 7))).toBe(false);
  });

  // --- N5: nowYear = birthYear+19, nowMonth < birthMonth → noch volljährig (19 Jahre bereits) ---

  it("ist volljährig wenn nowYear = birthYear+19 und nowMonth < birthMonth", () => {
    // geboren 2007-08, jetzt 2026-04 → 18 Jahre vollständig (seit Sept 2025), 19. Lj läuft
    expect(isAdult(2007, 8, d(2026, 4))).toBe(true);
  });

  // --- N5: TZ-Randfall — UTC 31.12. 23:30 = Berlin 01.01. (Neujahr) ---
  // Dokumentiert: Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin" }) liefert
  // für new Date("2025-12-31T22:30:00Z") das Berliner Datum 01.01.2026 (UTC+1 im Winter).
  // Daher: nowYear=2026, nowMonth=1 → Person geboren 2008-01 gilt als NICHT volljährig
  // (Monat January noch nicht abgelaufen), während UTC-basiert nowYear=2025 wäre (nicht 18).
  // Der TZ-Aware-Pfad gibt hier false zurück (konservativ korrekt).
  it("TZ-Randfall: UTC 31.12.2025 22:30 = Berlin 01.01.2026 → 2008-01 noch NICHT volljährig", () => {
    const utcNewYearsEve = new Date("2025-12-31T22:30:00Z"); // = Berlin 01.01.2026 00:30
    // 2008-01 + 18 = 2026-01; nowMonth (Berlin)=1 = birthMonth → nicht volljährig (Monat noch nicht abgelaufen)
    expect(isAdult(2008, 1, utcNewYearsEve)).toBe(false);
  });
});
