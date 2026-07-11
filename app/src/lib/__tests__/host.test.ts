/**
 * host.test.ts — Unit-Tests für die Host-Helfer (SIA Loop 3).
 *
 * isMainDomain entscheidet, ob das ADR-015-Pilot-Rewrite greift, und schützt
 * Fremd-Hosts vor dem Pilot-Mapping — daher direkt testen. Pur, kein DB.
 */

import { describe, it, expect } from "vitest";
import { isMainDomain, slugFromNormalizedHost, normalizeHost } from "@/lib/host";

describe("isMainDomain", () => {
  it("erkennt bekannte Haupt-Domains (auch mit Port/trailing-dot)", () => {
    for (const h of ["partizip.online", "www.partizip.online", "staging.partizip.online", "localhost", "localhost:3000", "127.0.0.1", "partizip.online."]) {
      expect(isMainDomain(h)).toBe(true);
    }
  });

  it("staging.partizip.online ist neutraler Single-Domain-Einstieg → kein Tenant-Slug", () => {
    expect(slugFromNormalizedHost(normalizeHost("staging.partizip.online"))).toBeNull();
  });

  it("ist false für Subdomains und Fremd-Hosts (kein Pilot-Mapping)", () => {
    for (const h of ["taunusstein.partizip.online", "evil.com", "partizip.online.evil.com", "foo.localhost"]) {
      expect(isMainDomain(h)).toBe(false);
    }
  });
});

describe("slugFromNormalizedHost (Regressionsanker)", () => {
  it("liefert Slug für Subdomain, null für Haupt-Domain/Fremd-Host", () => {
    expect(slugFromNormalizedHost(normalizeHost("taunusstein.partizip.online"))).toBe("taunusstein");
    expect(slugFromNormalizedHost(normalizeHost("partizip.online"))).toBeNull();
    expect(slugFromNormalizedHost(normalizeHost("evil.com"))).toBeNull();
  });
});
