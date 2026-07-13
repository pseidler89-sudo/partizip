/**
 * roles.test.ts — Berechtigungs-Achsen (H1/M2).
 *
 * Sicherheitskritischer Kern: ein `redakteur` darf prüfen/bearbeiten, aber
 * NICHT freigeben/veröffentlichen (Vier-Augen-Hebel). Reine Logik, keine DB.
 */

import { describe, it, expect } from "vitest";
import {
  canRedaktion,
  canFreigeben,
  isAdmin,
  canVerify,
  canBeobachten,
  beobachterDarfSehen,
  hasAnyRole,
  canManageRole,
  manageableRoleTypes,
  REDAKTION_ROLES,
  FREIGABE_ROLES,
  ADMIN_ROLES,
  VERIFIER_ROLES,
  ALL_ROLE_TYPES,
  RESERVE_ROLES,
} from "../roles";

describe("roles — Berechtigungs-Achsen", () => {
  it("redakteur darf Redaktion, aber NICHT Freigabe/Admin", () => {
    expect(canRedaktion(["redakteur"])).toBe(true);
    expect(canFreigeben(["redakteur"])).toBe(false);
    expect(isAdmin(["redakteur"])).toBe(false);
  });

  it("kommune_admin darf alles", () => {
    expect(canRedaktion(["kommune_admin"])).toBe(true);
    expect(canFreigeben(["kommune_admin"])).toBe(true);
    expect(isAdmin(["kommune_admin"])).toBe(true);
  });

  it("super_admin darf alles", () => {
    expect(canRedaktion(["super_admin"])).toBe(true);
    expect(canFreigeben(["super_admin"])).toBe(true);
    expect(isAdmin(["super_admin"])).toBe(true);
  });

  it("user (Bürger) hat keine redaktionellen Rechte", () => {
    expect(canRedaktion(["user"])).toBe(false);
    expect(canFreigeben(["user"])).toBe(false);
    expect(isAdmin(["user"])).toBe(false);
  });

  it("leere Rollenliste → keine Rechte", () => {
    expect(canRedaktion([])).toBe(false);
    expect(canFreigeben([])).toBe(false);
    expect(isAdmin([])).toBe(false);
  });

  it("Mehrfachrolle redakteur+user bleibt ohne Freigabe", () => {
    expect(canRedaktion(["user", "redakteur"])).toBe(true);
    expect(canFreigeben(["user", "redakteur"])).toBe(false);
  });

  it("Mehrfachrolle redakteur+kommune_admin darf freigeben", () => {
    expect(canFreigeben(["redakteur", "kommune_admin"])).toBe(true);
  });

  it("Reserve-Rollen geben keine Digest-Rechte", () => {
    expect(canRedaktion(["ortsteil_admin"])).toBe(false);
    expect(canFreigeben(["kreis_admin"])).toBe(false);
    expect(canRedaktion(["land_admin"])).toBe(false);
  });

  it("hasAnyRole: Schnittmengen-Logik", () => {
    expect(hasAnyRole(["a", "b"], ["b", "c"])).toBe(true);
    expect(hasAnyRole(["a"], ["b", "c"])).toBe(false);
    expect(hasAnyRole([], ["a"])).toBe(false);
  });

  it("Invariante: jede FREIGABE-Rolle ist auch eine REDAKTION-Rolle", () => {
    for (const r of FREIGABE_ROLES) {
      expect((REDAKTION_ROLES as readonly string[]).includes(r)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Eskalationsgrenze — canManageRole (Achse B, sicherheitskritisch)
// ---------------------------------------------------------------------------

describe("canManageRole — Eskalationsgrenze (Privilege-Escalation-Schutz)", () => {
  it("super_admin darf JEDE Rolle verwalten", () => {
    for (const r of ALL_ROLE_TYPES) {
      expect(canManageRole(["super_admin"], r)).toBe(true);
    }
  });

  it("kommune_admin darf user/verifier/redakteur/kommune_admin verwalten", () => {
    expect(canManageRole(["kommune_admin"], "user")).toBe(true);
    expect(canManageRole(["kommune_admin"], "verifier")).toBe(true);
    expect(canManageRole(["kommune_admin"], "redakteur")).toBe(true);
    expect(canManageRole(["kommune_admin"], "kommune_admin")).toBe(true);
  });

  it("kommune_admin darf NIEMALS super_admin verwalten (kritische Grenze)", () => {
    expect(canManageRole(["kommune_admin"], "super_admin")).toBe(false);
  });

  it("kommune_admin darf KEINE Reserve-Rolle verwalten", () => {
    for (const r of RESERVE_ROLES) {
      expect(canManageRole(["kommune_admin"], r)).toBe(false);
    }
  });

  it("Nicht-Admin (user/verifier/redakteur) darf NICHTS verwalten", () => {
    for (const caller of [["user"], ["verifier"], ["redakteur"], []]) {
      for (const r of ALL_ROLE_TYPES) {
        expect(canManageRole(caller, r)).toBe(false);
      }
    }
  });

  it("redakteur darf auch nicht user vergeben (kein Admin)", () => {
    expect(canManageRole(["redakteur"], "user")).toBe(false);
  });

  it("Mehrfachrolle: super_admin gewinnt über kommune_admin", () => {
    expect(canManageRole(["kommune_admin", "super_admin"], "super_admin")).toBe(true);
    expect(canManageRole(["super_admin", "kommune_admin"], "kreis_admin")).toBe(true);
  });

  it("Mehrfachrolle kommune_admin+redakteur bleibt eng begrenzt", () => {
    expect(canManageRole(["kommune_admin", "redakteur"], "kommune_admin")).toBe(true);
    expect(canManageRole(["kommune_admin", "redakteur"], "super_admin")).toBe(false);
  });

  it("Ungültiger/unbekannter roleType → false (Fail-closed)", () => {
    expect(canManageRole(["super_admin"], "root")).toBe(false);
    expect(canManageRole(["super_admin"], "")).toBe(false);
    expect(canManageRole(["kommune_admin"], "gott")).toBe(false);
  });
});

describe("manageableRoleTypes — UI-Filter", () => {
  it("super_admin sieht alle Rollentypen", () => {
    expect(manageableRoleTypes(["super_admin"])).toEqual([...ALL_ROLE_TYPES]);
  });

  it("kommune_admin sieht NICHT super_admin und NICHT Reserve-Rollen", () => {
    const list = manageableRoleTypes(["kommune_admin"]);
    expect(list).toContain("user");
    expect(list).toContain("verifier");
    expect(list).toContain("redakteur");
    expect(list).toContain("kommune_admin");
    expect(list).not.toContain("super_admin");
    for (const r of RESERVE_ROLES) {
      expect(list).not.toContain(r);
    }
  });

  it("Nicht-Admin sieht keine verwaltbaren Rollen", () => {
    expect(manageableRoleTypes(["user"])).toEqual([]);
    expect(manageableRoleTypes([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// beobachter — View-Only-Rolle (Rollen-Governance)
// ---------------------------------------------------------------------------

describe("beobachter — View-Only-Rolle: JEDER Mutations-Guard sagt NEIN", () => {
  // Tabellarisch: jeder Mutations-Guard × beobachter → false (sicherheitskritisch).
  const MUTATION_GUARDS: Array<[string, (roleTypes: string[]) => boolean]> = [
    ["canRedaktion", canRedaktion],
    ["canFreigeben", canFreigeben],
    ["isAdmin", isAdmin],
    ["canVerify", canVerify],
  ];

  for (const [name, guard] of MUTATION_GUARDS) {
    it(`${name}(["beobachter"]) → false`, () => {
      expect(guard(["beobachter"])).toBe(false);
    });

    it(`${name}(["user", "beobachter"]) → false (Mehrfachrolle hebt nichts auf)`, () => {
      expect(guard(["user", "beobachter"])).toBe(false);
    });
  }

  it("beobachter taucht in KEINER Mutations-Rollenliste auf (Invariante)", () => {
    for (const list of [REDAKTION_ROLES, FREIGABE_ROLES, ADMIN_ROLES, VERIFIER_ROLES]) {
      expect((list as readonly string[]).includes("beobachter")).toBe(false);
    }
  });

  it("canBeobachten: beobachter/redakteur/Admins ja — user/verifier/Reserve nein", () => {
    expect(canBeobachten(["beobachter"])).toBe(true);
    expect(canBeobachten(["redakteur"])).toBe(true);
    expect(canBeobachten(["kommune_admin"])).toBe(true);
    expect(canBeobachten(["super_admin"])).toBe(true);
    expect(canBeobachten(["user"])).toBe(false);
    expect(canBeobachten(["verifier"])).toBe(false);
    expect(canBeobachten(["ortsteil_admin"])).toBe(false);
    expect(canBeobachten([])).toBe(false);
  });

  it("beobachter darf KEINE einzige Rolle verwalten (Eskalationsgrenze)", () => {
    for (const r of ALL_ROLE_TYPES) {
      expect(canManageRole(["beobachter"], r)).toBe(false);
    }
    expect(manageableRoleTypes(["beobachter"])).toEqual([]);
  });

  it("kommune_admin und super_admin dürfen beobachter vergeben/entziehen", () => {
    expect(canManageRole(["kommune_admin"], "beobachter")).toBe(true);
    expect(canManageRole(["super_admin"], "beobachter")).toBe(true);
    expect(manageableRoleTypes(["kommune_admin"])).toContain("beobachter");
  });

  it("Eskalationsgrenze unverändert: kommune_admin weiterhin ohne super_admin/Reserve", () => {
    expect(canManageRole(["kommune_admin"], "super_admin")).toBe(false);
    for (const r of RESERVE_ROLES) {
      expect(canManageRole(["kommune_admin"], r)).toBe(false);
    }
  });
});

describe("beobachterDarfSehen — Scope-Sichtbarkeit (fail-closed)", () => {
  const stadtBeobachter = [
    { roleType: "beobachter", scopeLevel: "stadt", scopeCode: null },
  ];
  const nordBeobachter = [
    { roleType: "beobachter", scopeLevel: "ortsteil", scopeCode: "nord" },
  ];

  it("stadt-Beobachter sieht stadtweite UND Ortsteil-Objekte", () => {
    expect(beobachterDarfSehen(stadtBeobachter, "stadt", null)).toBe(true);
    expect(beobachterDarfSehen(stadtBeobachter, "ortsteil", "nord")).toBe(true);
    expect(beobachterDarfSehen(stadtBeobachter, "ortsteil", "sued")).toBe(true);
  });

  it("stadt-Beobachter sieht NICHTS auf höherer Ebene (kreis/land)", () => {
    expect(beobachterDarfSehen(stadtBeobachter, "kreis", null)).toBe(false);
    expect(beobachterDarfSehen(stadtBeobachter, "land", null)).toBe(false);
  });

  it("ortsteil-Beobachter sieht NUR den eigenen Ortsteil-Code", () => {
    expect(beobachterDarfSehen(nordBeobachter, "ortsteil", "nord")).toBe(true);
    expect(beobachterDarfSehen(nordBeobachter, "ortsteil", "sued")).toBe(false);
    expect(beobachterDarfSehen(nordBeobachter, "stadt", null)).toBe(false);
  });

  it("scopeCode NULL auf gleicher Ebene deckt die ganze Ebene ab", () => {
    const ohneCode = [
      { roleType: "beobachter", scopeLevel: "ortsteil", scopeCode: null },
    ];
    expect(beobachterDarfSehen(ohneCode, "ortsteil", "nord")).toBe(true);
    expect(beobachterDarfSehen(ohneCode, "ortsteil", "sued")).toBe(true);
  });

  it("NUR beobachter-Rollen zählen — Admin-/Redaktions-Rollen laufen über eigene Achsen", () => {
    const nurAdmin = [
      { roleType: "kommune_admin", scopeLevel: "stadt", scopeCode: null },
      { roleType: "redakteur", scopeLevel: "stadt", scopeCode: null },
    ];
    expect(beobachterDarfSehen(nurAdmin, "stadt", null)).toBe(false);
  });

  it("unbekannte Scope-Ebenen → false (fail-closed)", () => {
    const kaputt = [{ roleType: "beobachter", scopeLevel: "galaxie", scopeCode: null }];
    expect(beobachterDarfSehen(kaputt, "stadt", null)).toBe(false);
    expect(beobachterDarfSehen(stadtBeobachter, "galaxie", null)).toBe(false);
    expect(beobachterDarfSehen([], "stadt", null)).toBe(false);
  });
});
