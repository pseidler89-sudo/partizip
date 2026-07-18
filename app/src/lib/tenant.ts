/**
 * tenant.ts — Tenant-Auflösung aus Host-Header
 *
 * Unterstützte Formate:
 *   <slug>.partizip.online   → Produktion
 *   <slug>.localhost:3000    → Lokale Entwicklung
 *   <slug>.localhost         → Lokale Entwicklung (ohne Port)
 *
 * Haupt-Domains (partizip.online, www.partizip.online, localhost, 127.0.0.1)
 * ergeben null → neutrale Landing-Page.
 *
 * Nur aktive Tenants (is_active = true) werden zurückgegeben.
 *
 * MIN4: Host-Normalisierung (lowercase, trailing dot) über lib/host.ts.
 */

import { eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { tenants } from "@/db/schema";
import { normalizeHost, slugFromNormalizedHost, isMainDomain } from "@/lib/host";

export type TenantRow = {
  id: string;
  slug: string;
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
  welcomeText: string | null;
  isActive: boolean;
  // Block L (ADR-028): KI-Neutralitäts-Check je Tenant (Default false). Steuert, ob
  // eine zur Aktivierung gebrachte Umfrage zuerst in den Zustand `in_pruefung` geht.
  kiNeutralitaetsPflicht: boolean;
};

/**
 * Extrahiert den Tenant-Slug aus einem Host-Header-Wert.
 * Normalisiert vor der Extraktion (lowercase, trailing dot).
 * Gibt null zurück für Haupt-Domains oder nicht erkannte Muster.
 *
 * Re-exported for tests/compat; intern wird slugFromNormalizedHost genutzt.
 */
export function slugFromHost(host: string): string | null {
  return slugFromNormalizedHost(normalizeHost(host));
}

/**
 * Lädt einen aktiven Tenant aus der DB anhand seines Slugs.
 * Gibt null zurück, wenn kein aktiver Tenant mit diesem Slug existiert.
 */
export async function getTenantBySlug(slug: string): Promise<TenantRow | null> {
  // DATABASE_URL zur Laufzeit lesen (nicht bei Modul-Init) damit Tests
  // process.env.DATABASE_URL in beforeAll setzen können.
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);
  const rows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      primaryColor: tenants.primaryColor,
      logoUrl: tenants.logoUrl,
      welcomeText: tenants.welcomeText,
      isActive: tenants.isActive,
      kiNeutralitaetsPflicht: tenants.kiNeutralitaetsPflicht,
    })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);

  const tenant = rows[0] ?? null;
  if (!tenant || !tenant.isActive) return null;
  return tenant;
}

/**
 * Lädt einen aktiven Tenant aus der DB anhand des Host-Headers.
 *
 * Subdomain (`<slug>.partizip.online`) → der zugehörige Tenant (unverändert).
 *
 * Single-Domain-Pilot (ADR-015): ist KEIN Subdomain-Slug erkennbar, der Host
 * aber eine bekannte Haupt-Domain UND `PILOT_TENANT_SLUG` gesetzt, wird der
 * Pilot-Tenant zurückgegeben — so läuft die gesamte App im Pilot unter
 * `partizip.online` (kein Subdomain-Redirect nötig). Ohne env / bei Fremd-Hosts
 * → null (neutrale Landing-Page; Tenant-Isolation unverändert).
 */
export async function getTenantFromHost(host: string): Promise<TenantRow | null> {
  const slug = slugFromHost(host);
  if (slug) return getTenantBySlug(slug);

  // Single-Domain-Pilot: Haupt-Domain → Pilot-Tenant (env-gesteuert).
  const pilotSlug = process.env.PILOT_TENANT_SLUG?.trim();
  if (pilotSlug && isMainDomain(host)) return getTenantBySlug(pilotSlug);

  return null;
}
