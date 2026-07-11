/**
 * tenant-portability.ts — Tenant-Config Export/Import (Skalierungs-Roadmap).
 *
 * Zweck: die REGIONALE STRUKTUR einer Kommune (Tenant-Konfiguration + Ortsteile +
 * PLZ-Mapping) portabel machen, um neue Kommunen schnell zu bootstrappen.
 *
 * BEWUSST NUR KONFIGURATION — KEINE Laufzeit-/Personendaten: kein User, keine
 * Stimme, kein Anliegen, keine Session, keine Rolle. Der Export ist damit PII-frei.
 *
 * Sicherheit (Gate-B):
 *   - Export ist strikt tenant-scoped (eq(tenantId)).
 *   - Import legt einen NEUEN Tenant an (neue id), alle Kind-Zeilen referenzieren
 *     diese neue id → kein Cross-Tenant-Schreibzugriff.
 *   - Import bricht ab, wenn der Ziel-Slug bereits existiert (kein Überschreiben).
 *   - Import ist transaktional (alles-oder-nichts) und zod-validiert.
 *
 * Hinweis PLZ: `plz_regionen` ist GLOBAL eindeutig je (plz, ortsteil_code) — eine
 * PLZ gehört zu genau einer Region. Ein Import in eine Datenbank mit überlappenden
 * PLZ schlägt deshalb fehl (Transaktion bricht ab). Gedacht für eine FRISCHE Ziel-DB
 * (neues Deployment) bzw. nicht-überlappende Regionen.
 */

import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { tenants, ortsteile, plzRegionen } from "@/db/schema";

/** Aktuelle Schema-Version des Export-Formats (für künftige Migrationen). */
export const TENANT_EXPORT_VERSION = 1 as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const PLZ_RE = /^\d{5}$/;

const ortsteilSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});

const plzRegionSchema = z.object({
  plz: z.string().regex(PLZ_RE),
  ortsteilCode: z.string().min(1).max(64).nullable(),
  lat: z.string().nullable().optional(),
  lon: z.string().nullable().optional(),
});

export const tenantExportSchema = z.object({
  version: z.literal(TENANT_EXPORT_VERSION),
  tenant: z.object({
    slug: z.string().regex(SLUG_RE).max(63),
    name: z.string().min(1).max(200),
    primaryColor: z.string().max(32).nullable().optional(),
    logoUrl: z.string().max(2048).nullable().optional(),
    welcomeText: z.string().max(5000).nullable().optional(),
    vierAugenPflicht: z.boolean().optional(),
  }),
  ortsteile: z.array(ortsteilSchema),
  plzRegionen: z.array(plzRegionSchema),
});

export type TenantExport = z.infer<typeof tenantExportSchema>;

export interface ImportResult {
  tenantId: string;
  slug: string;
  ortsteile: number;
  plzRegionen: number;
}

/**
 * Exportiert die Konfiguration EINES Tenants (tenant-scoped). Liefert ein
 * validierbares, PII-freies Objekt. Wirft, wenn der Tenant nicht existiert.
 */
export async function exportTenantConfig(db: Db, tenantId: string): Promise<TenantExport> {
  const [t] = await db
    .select({
      slug: tenants.slug,
      name: tenants.name,
      primaryColor: tenants.primaryColor,
      logoUrl: tenants.logoUrl,
      welcomeText: tenants.welcomeText,
      vierAugenPflicht: tenants.vierAugenPflicht,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!t) throw new Error(`Tenant ${tenantId} nicht gefunden.`);

  const ots = await db
    .select({ code: ortsteile.code, name: ortsteile.name })
    .from(ortsteile)
    .where(eq(ortsteile.tenantId, tenantId))
    .orderBy(asc(ortsteile.code));

  const prs = await db
    .select({
      plz: plzRegionen.plz,
      ortsteilCode: plzRegionen.ortsteilCode,
      lat: plzRegionen.lat,
      lon: plzRegionen.lon,
    })
    .from(plzRegionen)
    .where(eq(plzRegionen.tenantId, tenantId))
    .orderBy(asc(plzRegionen.plz));

  // Der Select oben IST bereits die Allowlist (nur Config-Spalten, kein PII) — wir
  // konstruieren das Export-Objekt direkt. Bewusst KEIN strenges .parse() hier:
  // die Längen-Caps des Schemas sind Eingangs-Schutz beim Import, kein Ausgangs-
  // Constraint — valider Bestandsdaten-Export soll nie an einem Cap scheitern.
  return {
    version: TENANT_EXPORT_VERSION,
    tenant: {
      slug: t.slug,
      name: t.name,
      primaryColor: t.primaryColor,
      logoUrl: t.logoUrl,
      welcomeText: t.welcomeText,
      vierAugenPflicht: t.vierAugenPflicht,
    },
    ortsteile: ots,
    plzRegionen: prs,
  };
}

/**
 * Importiert eine Tenant-Config als NEUEN Tenant (transaktional, zod-validiert).
 * `opts.slug` überschreibt den Slug aus dem Export (z. B. um Kollisionen zu lösen).
 * Bricht ab, wenn der Ziel-Slug bereits existiert.
 */
export async function importTenantConfig(
  db: Db,
  data: unknown,
  opts?: { slug?: string }
): Promise<ImportResult> {
  const parsed = tenantExportSchema.parse(data);
  const slug = opts?.slug ?? parsed.tenant.slug;
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Ungültiger Slug: "${slug}".`);
  }

  // Referenzielle Integrität vorab prüfen: jeder ortsteilCode in plzRegionen muss
  // null sein oder zu einem Ortsteil im selben Export gehören (kein Dangling-Ref).
  const codes = new Set(parsed.ortsteile.map((o) => o.code));
  if (codes.size !== parsed.ortsteile.length) {
    throw new Error("Doppelte Ortsteil-Codes im Import.");
  }
  for (const pr of parsed.plzRegionen) {
    if (pr.ortsteilCode != null && !codes.has(pr.ortsteilCode)) {
      throw new Error(`PLZ ${pr.plz}: Ortsteil-Code "${pr.ortsteilCode}" fehlt in ortsteile.`);
    }
  }

  return await db.transaction(async (tx: Db) => {
    const existing = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (existing.length > 0) {
      throw new Error(`Tenant-Slug "${slug}" existiert bereits — Import abgebrochen.`);
    }

    const [t] = await tx
      .insert(tenants)
      .values({
        slug,
        name: parsed.tenant.name,
        primaryColor: parsed.tenant.primaryColor ?? null,
        logoUrl: parsed.tenant.logoUrl ?? null,
        welcomeText: parsed.tenant.welcomeText ?? null,
        vierAugenPflicht: parsed.tenant.vierAugenPflicht ?? false,
      })
      .returning({ id: tenants.id });

    if (parsed.ortsteile.length > 0) {
      await tx.insert(ortsteile).values(
        parsed.ortsteile.map((o) => ({ tenantId: t.id, code: o.code, name: o.name }))
      );
    }

    if (parsed.plzRegionen.length > 0) {
      await tx.insert(plzRegionen).values(
        parsed.plzRegionen.map((pr) => ({
          tenantId: t.id,
          plz: pr.plz,
          ortsteilCode: pr.ortsteilCode,
          lat: pr.lat ?? null,
          lon: pr.lon ?? null,
        }))
      );
    }

    return {
      tenantId: t.id,
      slug,
      ortsteile: parsed.ortsteile.length,
      plzRegionen: parsed.plzRegionen.length,
    };
  });
}
