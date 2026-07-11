/**
 * middleware.test.ts — Unit-Tests für das Routing (SIA Loop 3).
 *
 * Deckt den bisher ungetesteten ADR-015-Pilot-Rewrite + Subdomain-Rewrite +
 * Double-Rewrite-Guards ab. Ruft die ECHTE middleware() auf (kein Mirror),
 * prüft den `x-middleware-rewrite`-Header (gesetzt von NextResponse.rewrite)
 * bzw. dessen Abwesenheit (next()). Kein DB-Bedarf.
 */

import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const origPilot = process.env.PILOT_TENANT_SLUG;
afterEach(() => {
  if (origPilot === undefined) delete process.env.PILOT_TENANT_SLUG;
  else process.env.PILOT_TENANT_SLUG = origPilot;
});

function req(host: string, path: string): NextRequest {
  return new NextRequest(new URL(`https://${host}${path}`), {
    headers: { host },
  });
}
/** Rewrite-Ziel-Pfad aus dem x-middleware-rewrite-Header (oder null bei next()). */
function rewritePath(res: { headers: { get(k: string): string | null } }): string | null {
  const h = res.headers.get("x-middleware-rewrite");
  return h ? new URL(h).pathname : null;
}

describe("middleware — Haupt-Domain (Single-Domain-Pilot, ADR-015)", () => {
  it("ohne PILOT_TENANT_SLUG: kein Rewrite (neutrale Landing)", () => {
    delete process.env.PILOT_TENANT_SLUG;
    expect(rewritePath(middleware(req("partizip.online", "/")))).toBeNull();
    expect(rewritePath(middleware(req("partizip.online", "/umfragen")))).toBeNull();
  });

  it("mit PILOT_TENANT_SLUG: Haupt-Domain → /{slug}/...", () => {
    process.env.PILOT_TENANT_SLUG = "taunusstein";
    expect(rewritePath(middleware(req("partizip.online", "/")))).toBe("/taunusstein");
    expect(rewritePath(middleware(req("partizip.online", "/umfragen")))).toBe("/taunusstein/umfragen");
    expect(rewritePath(middleware(req("www.partizip.online", "/umfragen")))).toBe("/taunusstein/umfragen");
  });

  it("mit PILOT_TENANT_SLUG: bereits /{slug}/... → kein Doppel-Rewrite", () => {
    process.env.PILOT_TENANT_SLUG = "taunusstein";
    expect(rewritePath(middleware(req("partizip.online", "/taunusstein")))).toBeNull();
    expect(rewritePath(middleware(req("partizip.online", "/taunusstein/umfragen")))).toBeNull();
  });
});

describe("middleware — Subdomain-Routing", () => {
  it("Subdomain /path → /{slug}/path", () => {
    expect(rewritePath(middleware(req("taunusstein.partizip.online", "/umfragen")))).toBe("/taunusstein/umfragen");
  });
  it("Subdomain bereits /{slug}/path → kein Doppel-Rewrite", () => {
    expect(rewritePath(middleware(req("taunusstein.partizip.online", "/taunusstein/umfragen")))).toBeNull();
  });
});
