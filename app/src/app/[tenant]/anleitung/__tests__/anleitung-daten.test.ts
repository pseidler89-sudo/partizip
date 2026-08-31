/**
 * anleitung-daten.test.ts — Struktur-Netz für die Anleitungs-Inhalte.
 *
 * OHNE DATENBANK, ohne Rendering: reine Datenprüfung. Der Zweck ist nicht,
 * Formulierungen festzunageln (die soll der Owner frei ändern können), sondern
 * die Zusagen der Struktur zu halten:
 *
 *   - Jede Spur hat das vollständige Muster (erster Satz, Schritte, Wissen,
 *     Fragen) — eine halb gefüllte Spur wäre in der Oberfläche ein Loch.
 *   - Anker-Ids sind eindeutig und stabil: die Abholseite und das
 *     Inhaltsverzeichnis springen darauf.
 *   - Jede real betriebene Rolle findet einen Abschnitt; die Betreiberrolle und
 *     die Reserve-Rollen finden BEWUSST keinen.
 *   - Links sind tenant-relativ (führendes „/") — sonst landet ein Klick auf
 *     dem falschen Mandanten. Einzige Ausnahme: `absolut` (Präsentations-Deck).
 */

import { describe, it, expect } from "vitest";
import {
  AUFGABEN_SPUREN,
  BUERGER_SPUR,
  EINSTIEG_KARTEN,
  ROLLE_ZU_ABSCHNITT,
  abschnitteFuerRollen,
  type AnleitungLink,
  type AnleitungSpur,
} from "../anleitung-daten";

const ALLE_SPUREN: AnleitungSpur[] = [BUERGER_SPUR, ...AUFGABEN_SPUREN];

function alleLinks(spur: AnleitungSpur): AnleitungLink[] {
  return [
    ...spur.schritte.flatMap((s) => (s.link ? [s.link] : [])),
    ...spur.weiter,
  ];
}

describe("Anleitungs-Daten: Struktur", () => {
  it("jede Spur ist vollständig", () => {
    for (const spur of ALLE_SPUREN) {
      expect(spur.id, "Anker-Id fehlt").toMatch(/^[a-z][a-z-]*$/);
      expect(spur.titel.length, `${spur.id}: Titel`).toBeGreaterThan(0);
      expect(spur.kurz.length, `${spur.id}: Kurzfassung`).toBeGreaterThan(0);
      expect(spur.ersterSatz.length, `${spur.id}: erster Satz`).toBeGreaterThan(0);
      expect(spur.schritte.length, `${spur.id}: Schritte`).toBeGreaterThan(0);
      expect(spur.wissen.length, `${spur.id}: „Das sollten Sie wissen"`).toBeGreaterThan(0);
      expect(spur.fragen.length, `${spur.id}: Nachschlag-Fragen`).toBeGreaterThan(0);
    }
  });

  it("Anker-Ids sind eindeutig", () => {
    const ids = ALLE_SPUREN.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Schritt-Titel und Fragen sind je Spur eindeutig (sie dienen als React-key)", () => {
    for (const spur of ALLE_SPUREN) {
      const titel = spur.schritte.map((s) => s.titel);
      expect(new Set(titel).size, `${spur.id}: doppelter Schritt-Titel`).toBe(titel.length);
      const fragen = spur.fragen.map((f) => f.f);
      expect(new Set(fragen).size, `${spur.id}: doppelte Frage`).toBe(fragen.length);
      const wissen = spur.wissen.map((w) => w.titel);
      expect(new Set(wissen).size, `${spur.id}: doppelter Hinweis-Titel`).toBe(wissen.length);
    }
  });

  it("höchstens ein Sprung-Link je Schritt und alle Links sind tenant-relativ", () => {
    for (const spur of ALLE_SPUREN) {
      for (const link of alleLinks(spur)) {
        expect(link.label.length, `${spur.id}: Link ohne Beschriftung`).toBeGreaterThan(0);
        expect(link.href, `${spur.id}: ${link.label}`).toMatch(/^\//);
        // Keine absoluten URLs in den Spuren — die Anleitung verlinkt in die App.
        expect(link.href.startsWith("//"), `${spur.id}: ${link.label}`).toBe(false);
      }
    }
  });
});

describe("Anleitungs-Daten: Abholseite", () => {
  it("bietet genau die drei Situationen an", () => {
    expect(EINSTIEG_KARTEN.map((k) => k.key)).toEqual([
      "mitmachen",
      "aufgaben",
      "vorstellen",
    ]);
  });

  it("die Bürger- und die Rollenträger-Karte zeigen auf existierende Routen", () => {
    const ziele = EINSTIEG_KARTEN.filter((k) => !k.link.absolut).map((k) => k.link.href);
    expect(ziele).toEqual(["/anleitung/mitmachen", "/anleitung/aufgaben"]);
  });

  it("die Präsentation wird absolut verlinkt (liegt außerhalb des Tenant-Routings)", () => {
    const deck = EINSTIEG_KARTEN.find((k) => k.key === "vorstellen");
    expect(deck?.link.absolut).toBe(true);
    expect(deck?.link.href).toBe("/praesentation");
  });
});

describe("Anleitungs-Daten: Rollen-Zuordnung", () => {
  it("jede in Betrieb befindliche Rolle findet einen Abschnitt", () => {
    for (const rolle of ["verifier", "redakteur", "kommune_admin", "beobachter"]) {
      const treffer = abschnitteFuerRollen([rolle]);
      expect(treffer.length, `${rolle} ohne Abschnitt`).toBe(1);
      expect(AUFGABEN_SPUREN.map((s) => s.id)).toContain(treffer[0].spurId);
    }
  });

  it("Betreiberrolle und Reserve-Rollen bekommen bewusst KEINEN Abschnitt", () => {
    for (const rolle of ["super_admin", "ortsteil_admin", "kreis_admin", "land_admin", "user"]) {
      expect(abschnitteFuerRollen([rolle]), `${rolle} sollte leer sein`).toEqual([]);
    }
  });

  it("Mehrfachrollen ergeben mehrere Abschnitte, ohne Dopplung und in fester Reihenfolge", () => {
    const treffer = abschnitteFuerRollen([
      "beobachter",
      "verifier",
      "verifier",
      "unbekannte_rolle",
    ]);
    expect(treffer.map((t) => t.spurId)).toEqual(["verifizierung", "beobachtung"]);
  });

  it("ohne Rollen (ausgeloggt) gibt es keinen persönlichen Hinweis", () => {
    expect(abschnitteFuerRollen([])).toEqual([]);
  });

  it("jede Zuordnung zeigt auf eine existierende Spur", () => {
    for (const [rolle, eintrag] of Object.entries(ROLLE_ZU_ABSCHNITT)) {
      expect(
        AUFGABEN_SPUREN.some((s) => s.id === eintrag.spurId),
        `${rolle} → ${eintrag.spurId} existiert nicht`,
      ).toBe(true);
    }
  });
});
