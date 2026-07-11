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
  hasAnyRole,
  canManageRole,
  manageableRoleTypes,
  REDAKTION_ROLES,
  FREIGABE_ROLES,
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
