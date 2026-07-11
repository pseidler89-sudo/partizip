/**
 * middleware.ts — Subdomain-Routing (M2)
 *
 * Unterstützte Muster:
 *   <slug>.partizip.online  → rewrite auf /[tenant]/...
 *   <slug>.localhost[:port] → rewrite auf /[tenant]/...
 *
 * Haupt-Domains (partizip.online, www.partizip.online, localhost, 127.0.0.1)
 * → keine Rewrite, neutrale Landing-Page.
 *
 * API-Routen (/api/*) werden NICHT rewritten — Tenant-Auflösung dort
 * serverseitig aus dem Host-Header (in jedem Route Handler).
 *
 * Test-Override (x-test-host):
 *   NUR aktiv wenn NODE_ENV=test ODER ALLOW_TEST_HOST_OVERRIDE=1.
 *   Sicherheitstest: ohne dieses Flag wird x-test-host ignoriert (M5).
 *
 * MIN4: Host-Normalisierung (lowercase, trailing dot) über lib/host.ts.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { normalizeHost, slugFromNormalizedHost, isMainDomain } from "@/lib/host";

/**
 * Bestimmt den effektiven Host für Routing-Zwecke.
 * allowOverride ist explizit injizierbar für Tests (M5).
 */
export function getEffectiveHost(
  request: NextRequest,
  allowOverride?: boolean
): string {
  const shouldOverride =
    allowOverride ??
    (process.env.NODE_ENV === "test" ||
      process.env.ALLOW_TEST_HOST_OVERRIDE === "1");

  const rawHost = request.headers.get("host") ?? "localhost";

  // Annahme: genau ein vertrauenswürdiger Proxy (z. B. Traefik) hängt x-forwarded-for an.
  // In Produktion wird x-test-host ignoriert (allowOverride=false).
  if (shouldOverride) {
    const testHost = request.headers.get("x-test-host");
    if (testHost) return normalizeHost(testHost);
  }

  return normalizeHost(rawHost);
}

export function middleware(request: NextRequest): NextResponse {
  const host = getEffectiveHost(request);
  const slug = slugFromNormalizedHost(host);

  if (!slug) {
    // Haupt-Domain. Single-Domain-Pilot (ADR-015): ist PILOT_TENANT_SLUG gesetzt
    // und der Host eine bekannte Haupt-Domain, wird die GESAMTE App unter der
    // Haupt-Domain auf den Pilot-Tenant umgeschrieben — kein Subdomain-Redirect.
    // (getTenantFromHost mappt den Host konsistent auf denselben Tenant, sodass
    // Actions/API-Routen, die den Tenant aus dem Host auflösen, identisch greifen.)
    const pilotSlug = process.env.PILOT_TENANT_SLUG?.trim();
    if (pilotSlug && isMainDomain(host)) {
      const purl = request.nextUrl.clone();
      // Bereits auf den Pilot-Slug zeigend? Erlaubt direkte /{slug}/...-Links auf
      // der Haupt-Domain und verhindert Doppel-Rewrite.
      if (
        purl.pathname === `/${pilotSlug}` ||
        purl.pathname.startsWith(`/${pilotSlug}/`)
      ) {
        return NextResponse.next();
      }
      purl.pathname = `/${pilotSlug}${purl.pathname === "/" ? "" : purl.pathname}`;
      return NextResponse.rewrite(purl);
    }
    // Sonst: neutrale Landing-Page, kein Rewrite
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();

  // Bereits umgeschrieben? (Prevent double-rewrite)
  if (url.pathname === `/${slug}` || url.pathname.startsWith(`/${slug}/`)) {
    return NextResponse.next();
  }

  // Rewrite: /path → /[slug]/path
  url.pathname = `/${slug}${url.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: [
    // API-Routen und statische Assets NICHT rewriten
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
