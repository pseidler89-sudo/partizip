/**
 * Prüft die Umrechnung Berliner Ortszeit → Zeitpunkt, insbesondere über die
 * Sommerzeitgrenze hinweg. Der Bug, den das verhindert: ein fest verdrahtetes
 * "+01:00" ließ jede Sitzung im Sommerhalbjahr eine Stunde zu früh erscheinen.
 */

import { describe, it, expect } from "vitest";
import { berlinZeitZuDate } from "../zeitzone";

/** Kurzschreibweise: erwarteter UTC-Zeitpunkt als ISO-String. */
const utc = (d: Date | null) => d?.toISOString() ?? null;

describe("berlinZeitZuDate", () => {
  it("rechnet im Winterhalbjahr mit +01:00 (MEZ)", () => {
    expect(utc(berlinZeitZuDate(2026, 1, 15, 19, 30))).toBe("2026-01-15T18:30:00.000Z");
  });

  it("rechnet im Sommerhalbjahr mit +02:00 (MESZ) — der eigentliche Fehler", () => {
    expect(utc(berlinZeitZuDate(2026, 8, 5, 19, 30))).toBe("2026-08-05T17:30:00.000Z");
  });

  it("trifft den Tag der Umstellung auf Sommerzeit", () => {
    // Umstellung 2026: Sonntag, 29. März, 02:00 → 03:00.
    expect(utc(berlinZeitZuDate(2026, 3, 29, 1, 0))).toBe("2026-03-29T00:00:00.000Z"); // noch MEZ
    expect(utc(berlinZeitZuDate(2026, 3, 29, 4, 0))).toBe("2026-03-29T02:00:00.000Z"); // schon MESZ
  });

  it("trifft den Tag der Umstellung auf Winterzeit", () => {
    // Umstellung 2026: Sonntag, 25. Oktober, 03:00 → 02:00.
    expect(utc(berlinZeitZuDate(2026, 10, 25, 1, 0))).toBe("2026-10-24T23:00:00.000Z"); // noch MESZ
    expect(utc(berlinZeitZuDate(2026, 10, 25, 4, 0))).toBe("2026-10-25T03:00:00.000Z"); // schon MEZ
  });

  it("behandelt Mitternacht korrekt (hour12:false liefert dort 24)", () => {
    expect(utc(berlinZeitZuDate(2026, 8, 5, 0, 0))).toBe("2026-08-04T22:00:00.000Z");
    expect(utc(berlinZeitZuDate(2026, 1, 15, 0, 0))).toBe("2026-01-14T23:00:00.000Z");
  });

  it("liefert für unsinnige Angaben null statt eines Invalid Date", () => {
    expect(berlinZeitZuDate(Number.NaN, 1, 1, 0, 0)).toBeNull();
  });

  it("stimmt mit der Berliner Ortszeit überein, aus der gerechnet wurde", () => {
    // Rückprobe: Formatiert man das Ergebnis wieder in Berliner Ortszeit, muss
    // dieselbe Uhrzeit herauskommen — für jeden Monat des Jahres.
    const fmt = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    for (let monat = 1; monat <= 12; monat++) {
      const d = berlinZeitZuDate(2026, monat, 15, 19, 30);
      expect(d).not.toBeNull();
      expect(fmt.format(d as Date)).toBe("19:30");
    }
  });
});
