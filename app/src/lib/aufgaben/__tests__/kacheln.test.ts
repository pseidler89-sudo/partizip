/**
 * kacheln.test.ts — Aufgaben-Kachel-Sichtbarkeit (Discoverability).
 *
 * Nutzt die ECHTEN Prädikate aus lib/auth/roles.ts (keine Spiegelung): ein
 * `verifier` sieht NUR die Verifizierungs-Kacheln, ein Admin alle, ein
 * Nicht-Rollenträger keine (und wird von der Route weg-redirectet).
 */

import { describe, it, expect } from "vitest";
import { aufgabenKacheln, hatAufgaben } from "../kacheln";

function keys(roleTypes: string[]): string[] {
  return aufgabenKacheln(roleTypes).map((k) => k.key);
}

describe("aufgabenKacheln — Discoverability spiegelt Server-Enforcement", () => {
  it("verifier → nur Verifizieren-Kacheln, keine Admin-Kacheln", () => {
    expect(keys(["verifier"])).toEqual(["verifizieren", "termine"]);
    expect(hatAufgaben(["verifier"])).toBe(true);
  });

  it("redakteur → nur Ratsinfos/Digests (kein Verifizieren, kein Standort)", () => {
    expect(keys(["redakteur"])).toEqual(["digests"]);
    expect(hatAufgaben(["redakteur"])).toBe(true);
  });

  it("beobachter → nur die Lese-Übersicht", () => {
    expect(keys(["beobachter"])).toEqual(["uebersicht"]);
    expect(hatAufgaben(["beobachter"])).toBe(true);
  });

  it("kommune_admin → alle Kacheln, /admin genau EINMAL (Verwaltung, keine Übersicht)", () => {
    const k = keys(["kommune_admin"]);
    expect(k).toEqual([
      "verifizieren",
      "termine",
      "umfrage",
      "standorte",
      "digests",
      "verwaltung",
    ]);
    // /admin erscheint nur als „verwaltung", nicht zusätzlich als „uebersicht".
    expect(k).not.toContain("uebersicht");
    // Kein Duplikat auf denselben href.
    const hrefs = aufgabenKacheln(["kommune_admin"]).map((x) => x.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("super_admin → wie Admin (alle Kacheln)", () => {
    expect(keys(["super_admin"])).toEqual([
      "verifizieren",
      "termine",
      "umfrage",
      "standorte",
      "digests",
      "verwaltung",
    ]);
  });

  it("kombiniert verifier+redakteur → Verifizieren + Digests, kein /admin-Verwaltung", () => {
    expect(keys(["verifier", "redakteur"])).toEqual([
      "verifizieren",
      "termine",
      "digests",
    ]);
  });

  it("Nicht-Rollenträger (reiner user) → keine Kacheln, kein Zugang", () => {
    expect(keys(["user"])).toEqual([]);
    expect(hatAufgaben(["user"])).toBe(false);
    expect(hatAufgaben([])).toBe(false);
  });

  it("jede Kachel hat einen href OHNE Tenant-Präfix (beginnt mit /)", () => {
    for (const k of aufgabenKacheln(["kommune_admin"])) {
      expect(k.href.startsWith("/")).toBe(true);
      expect(k.href.startsWith("/admin") || k.href.startsWith("/verifizieren")).toBe(true);
    }
  });
});
