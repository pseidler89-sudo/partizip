/**
 * totp-benachrichtigung.test.ts — Inhalt der Sicherheits-Mail bei Änderungen am
 * zweiten Faktor (Review #59, Befund 3).
 *
 * Ohne DB und ohne SMTP: geprüft wird der reine Textbaustein. Die harte Regel
 * ist die Auslassung — die Mail warnt, sie liefert keine Angriffsfläche. Wer
 * hier einen Code, ein Secret oder einen auslösenden Link einbaut, macht die
 * Warnung selbst zum Werkzeug.
 */

import { describe, it, expect } from "vitest";
import { zweiFaktorAenderungInhalt, type ZweiFaktorEreignis } from "../mail";

const KONTAKT = "kontakt@example.invalid";
const ZEITPUNKT = new Date("2026-08-06T12:34:00Z");

const EREIGNISSE: ZweiFaktorEreignis[] = [
  "aktiviert",
  "wiederherstellungscode",
  "neu_eingerichtet",
];

describe("zweiFaktorAenderungInhalt", () => {
  it("nennt Ereignis und Zeitpunkt in Europe/Berlin", () => {
    const { betreff, text, html } = zweiFaktorAenderungInhalt("aktiviert", ZEITPUNKT, KONTAKT);
    expect(betreff).toContain("Zwei-Faktor");
    // 12:34 UTC = 14:34 Berliner Sommerzeit.
    expect(text).toContain("6. August 2026");
    expect(text).toContain("14:34");
    expect(html).toContain("14:34");
  });

  it("fordert bei jedem Ereignis zur sofortigen Meldung auf", () => {
    for (const ereignis of EREIGNISSE) {
      const { text, html } = zweiFaktorAenderungInhalt(ereignis, ZEITPUNKT, KONTAKT);
      expect(text).toContain(KONTAKT);
      expect(text.toLowerCase()).toContain("umgehend");
      expect(html).toContain(`mailto:${KONTAKT}`);
    }
  });

  it("unterscheidet die drei Anlässe im Betreff", () => {
    const betreffe = EREIGNISSE.map(
      (e) => zweiFaktorAenderungInhalt(e, ZEITPUNKT, KONTAKT).betreff
    );
    expect(new Set(betreffe).size).toBe(EREIGNISSE.length);
  });

  it("weist beim Gerätewechsel auf die entwerteten Wiederherstellungscodes hin", () => {
    const { text } = zweiFaktorAenderungInhalt("neu_eingerichtet", ZEITPUNKT, KONTAKT);
    expect(text).toContain("Wiederherstellungscodes");
    expect(text).toContain("ungültig");
  });

  it("enthält keinen auslösenden Link — nur die mailto-Kontaktadresse", () => {
    for (const ereignis of EREIGNISSE) {
      const { text, html } = zweiFaktorAenderungInhalt(ereignis, ZEITPUNKT, KONTAKT);
      expect(text).not.toMatch(/https?:\/\//);
      const linkZiele = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(linkZiele).toEqual([`mailto:${KONTAKT}`]);
    }
  });

  it("enthält weder Secret noch Codes — die Funktion bekommt sie gar nicht erst", () => {
    // Aufrufsignatur ist der Beweis: Ereignis, Zeitpunkt, Kontaktadresse. Der
    // Test hält fest, dass typische Geheimnis-Marker nicht auftauchen können.
    for (const ereignis of EREIGNISSE) {
      const { text, html } = zweiFaktorAenderungInhalt(ereignis, ZEITPUNKT, KONTAKT);
      for (const inhalt of [text, html]) {
        // Kein Base32-Secret (≥ 16 Zeichen A-Z2-7 am Stück) …
        expect(inhalt).not.toMatch(/\b[A-Z2-7]{16,}\b/);
        // … und kein Wiederherstellungscode im Format XXXXX-XXXXX.
        expect(inhalt).not.toMatch(/\b[A-Z2-7]{5}-[A-Z2-7]{5}\b/);
      }
    }
  });
});
