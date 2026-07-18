/**
 * anzeige.test.ts — Unit-Tests für die reinen Anzeige-Helfer der Rollenträger-
 * Identität (Block J1). Kein DB-Zugriff. Sichert vor allem die Pseudonymitäts-
 * Invarianten: Person/Klarname erscheinen NUR bei Rollenträgern mit Namen.
 */

import { describe, it, expect } from "vitest";
import {
  initialen,
  istRollentraeger,
  rollentraegerAnzeige,
  fragestellerBadge,
} from "@/lib/identity/anzeige";

describe("initialen", () => {
  it("nimmt bei einem Wort dessen ersten Buchstaben", () => {
    expect(initialen("Maria")).toBe("M");
  });
  it("nimmt bei zwei Wörtern Vor- und Nachname", () => {
    expect(initialen("Maria Musterfrau")).toBe("MM");
  });
  it("nimmt bei mehreren Wörtern erstes + letztes Wort", () => {
    expect(initialen("Anna Lena von Beispiel")).toBe("AB");
  });
  it("behandelt Bindestrich-Namen als getrennte Worte", () => {
    expect(initialen("Klaus-Peter Schmidt")).toBe("KS");
  });
  it("ist robust bei mehrfachen Leerzeichen", () => {
    expect(initialen("  Maria   Musterfrau  ")).toBe("MM");
  });
  it("liefert Großbuchstaben (auch aus Kleinschreibung)", () => {
    expect(initialen("maria musterfrau")).toBe("MM");
  });
  it("ist code-point-sicher bei Unicode (Umlaut/Sonderzeichen)", () => {
    expect(initialen("Ömer Çalışkan")).toBe("ÖÇ");
  });
  it("liefert bei leerer/whitespace-Eingabe einen leeren String", () => {
    expect(initialen("")).toBe("");
    expect(initialen("   ")).toBe("");
    expect(initialen(null)).toBe("");
    expect(initialen(undefined)).toBe("");
  });
});

describe("istRollentraeger", () => {
  it("false bei keiner Rolle oder nur `user`", () => {
    expect(istRollentraeger([])).toBe(false);
    expect(istRollentraeger(["user"])).toBe(false);
  });
  it("true, sobald eine Rolle ≠ `user` vorliegt", () => {
    expect(istRollentraeger(["user", "verifier"])).toBe(true);
    expect(istRollentraeger(["kommune_admin"])).toBe(true);
    expect(istRollentraeger(["beobachter"])).toBe(true);
  });
});

describe("rollentraegerAnzeige", () => {
  it("gibt für einen Bürger (keine Rolle) name/funktion = null zurück", () => {
    const vm = rollentraegerAnzeige({
      displayName: "Heimlich Bürger",
      funktion: "irgendwas",
      roleTypes: ["user"],
      institution: "Musterstadt",
    });
    expect(vm.istRollentraeger).toBe(false);
    // Pseudonymität: selbst ein (fälschlich) gesetzter Name wird NICHT gezeigt.
    expect(vm.name).toBeNull();
    expect(vm.funktion).toBeNull();
    expect(vm.initialen).toBe("");
    expect(vm.institution).toBe("Musterstadt");
  });

  it("zeigt für einen Rollenträger MIT Namen Klarname + Funktion + Initialen", () => {
    const vm = rollentraegerAnzeige({
      displayName: "Maria Musterfrau",
      funktion: "Bürgermeisterin",
      roleTypes: ["kommune_admin"],
      institution: "Musterstadt",
    });
    expect(vm.istRollentraeger).toBe(true);
    expect(vm.name).toBe("Maria Musterfrau");
    expect(vm.funktion).toBe("Bürgermeisterin");
    expect(vm.initialen).toBe("MM");
  });

  it("Rollenträger OHNE Namen → nur Institution (Fallback), Funktion unterdrückt", () => {
    const vm = rollentraegerAnzeige({
      displayName: null,
      funktion: "Bürgermeisterin",
      roleTypes: ["kommune_admin"],
      institution: "Musterstadt",
    });
    expect(vm.name).toBeNull();
    // Ohne sichtbaren Namen keine freischwebende Amtsbezeichnung.
    expect(vm.funktion).toBeNull();
    expect(vm.initialen).toBe("");
    expect(vm.institution).toBe("Musterstadt");
  });
});

describe("fragestellerBadge", () => {
  const inst = "Gemeinde Musterstadt";

  it("erstellt_von NULL (ersteller = null) ⇒ nur Institution", () => {
    const b = fragestellerBadge(inst, null);
    expect(b).toEqual({ institution: inst });
    expect(b.person).toBeUndefined();
  });

  it("Ersteller kein Rollenträger ⇒ nur Institution", () => {
    const b = fragestellerBadge(inst, {
      displayName: "Heimlich Bürger",
      funktion: null,
      istRollentraeger: false,
    });
    expect(b).toEqual({ institution: inst });
  });

  it("Rollenträger OHNE display_name ⇒ nur Institution", () => {
    const b = fragestellerBadge(inst, {
      displayName: null,
      funktion: "Bürgermeisterin",
      istRollentraeger: true,
    });
    expect(b).toEqual({ institution: inst });
  });

  it("Rollenträger MIT display_name ⇒ Institution + Person (+ Funktion + Initialen)", () => {
    const b = fragestellerBadge(inst, {
      displayName: "Maria Musterfrau",
      funktion: "Bürgermeisterin",
      istRollentraeger: true,
    });
    expect(b.institution).toBe(inst);
    expect(b.person).toBe("Maria Musterfrau");
    expect(b.funktion).toBe("Bürgermeisterin");
    expect(b.initialen).toBe("MM");
  });

  it("Rollenträger mit Namen aber ohne Funktion ⇒ Person ohne Funktion", () => {
    const b = fragestellerBadge(inst, {
      displayName: "Maria Musterfrau",
      funktion: null,
      istRollentraeger: true,
    });
    expect(b.person).toBe("Maria Musterfrau");
    expect(b.funktion).toBeUndefined();
    expect(b.initialen).toBe("MM");
  });

  it("behandelt Whitespace-only display_name wie leer (nur Institution)", () => {
    const b = fragestellerBadge(inst, {
      displayName: "   ",
      funktion: "Amt",
      istRollentraeger: true,
    });
    expect(b).toEqual({ institution: inst });
  });
});
