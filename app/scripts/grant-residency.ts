/**
 * grant-residency.ts — Wohnsitz-Verifizierung per CLI (Betreiber-Override).
 *
 * BEWUSSTER Betreiber-Bypass für Fälle, in denen der normale Vor-Ort-Flow (Bürger
 * zeigt Konto-QR → Verifizierer scannt) nicht greift:
 *   - Bootstrap: der ALLERERSTE Verifizierer/Admin einer Kommune (Henne-Ei — es
 *     gibt noch niemanden, der ihn vor Ort bestätigen könnte).
 *   - Der Betreiber selbst (Selbst-Verifizierung ist im Flow absichtlich gesperrt).
 *   - Nachweisbarer Ausnahmefall, den ein Admin manuell verantwortet.
 *
 * Setzt exakt dieselben Felder wie grantResidency im echten Flow (verified,
 * 24-Monats-Ablauf, harter residency_region_id-Anker, home_region_id nur via
 * COALESCE an feine Knoten) — mit Methode `remote_admin_override` und einem
 * PII-freien Audit-Event. Grant + Audit laufen in EINER Transaktion.
 *
 * Verwendung:
 *   npm run grant-residency -- --tenant taunusstein --email person@example.com
 *     → Anker = Gemeinde-Knoten des Tenants (Standard).
 *   npm run grant-residency -- --tenant taunusstein --email p@x.de --ars 064390015015
 *     → Anker = Region mit dieser ARS (Gemeinde ODER Ortsteil).
 *   npm run grant-residency -- --tenant taunusstein --email p@x.de --ortsteil Hahn
 *     → Anker = Ortsteil mit diesem Namen (Ortsteile haben oft keine ARS).
 *   Priorität, falls mehrere gesetzt: --ars vor --ortsteil vor Gemeinde-Default.
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { tenants, users, auditEvents, regions, ortsteile } from "../src/db/schema.js";
import { grantResidency } from "../src/lib/verification/qr-core.js";
import { normalizeEmail } from "../src/lib/auth/email.js";
import type { Db } from "../src/db/client.js";

// ---------------------------------------------------------------------------
// CLI-Argumente
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] ?? null : null;
}

const tenantSlug = getArg("--tenant");
const email = getArg("--email");
const ars = getArg("--ars"); // optional: konkrete Region per ARS (Gemeinde/Ortsteil)
const ortsteilName = getArg("--ortsteil"); // optional: Ortsteil per Name (ohne ARS)

if (!tenantSlug || !email) {
  console.error("Fehler: --tenant und --email sind erforderlich.");
  console.error("Optional: --ars <ARS> oder --ortsteil <Name> (Standard: Gemeinde-Knoten).");
  process.exit(1);
}

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg, { schema }) as unknown as Db;

  // Tenant laden
  const tenantRows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug!))
    .limit(1);
  if (tenantRows.length === 0) {
    console.error(`Fehler: Tenant "${tenantSlug}" nicht gefunden.`);
    await pg.end();
    process.exit(1);
  }
  const tenant = tenantRows[0];

  // User laden (tenant-scoped, normalisierte E-Mail); nur aktive Konten.
  const userRows = await db
    .select({ id: users.id, status: users.accountStatus })
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.email, normalizeEmail(email!))))
    .limit(1);
  if (userRows.length === 0) {
    console.error(
      `Fehler: User "${email}" in Tenant "${tenantSlug}" nicht gefunden.\n` +
        "Tipp: Die Person muss sich zuerst einmal per Magic-Link eingeloggt haben.",
    );
    await pg.end();
    process.exit(1);
  }
  if (userRows[0].status !== "active") {
    console.error(`Fehler: Konto ist nicht aktiv (Status: ${userRows[0].status}).`);
    await pg.end();
    process.exit(1);
  }
  const userId = userRows[0].id;

  // Ziel-Region auflösen. Priorität: --ars > --ortsteil (per Name, tenant-scoped)
  // > Standard = Gemeinde-Knoten des Tenants (partieller Unique → deterministisch).
  const regionSelect = {
    id: regions.id,
    typ: regions.typ,
    name: regions.name,
    pathLabel: regions.pathLabel,
  };
  const regionWhere = ars
    ? and(eq(regions.tenantId, tenant.id), eq(regions.ars, ars))
    : ortsteilName
      ? and(
          eq(regions.tenantId, tenant.id),
          eq(regions.typ, "ortsteil"),
          eq(regions.name, ortsteilName),
        )
      : and(eq(regions.tenantId, tenant.id), eq(regions.typ, "gemeinde"));
  const regionRows = await db.select(regionSelect).from(regions).where(regionWhere).limit(1);
  if (regionRows.length === 0) {
    console.error(
      ars
        ? `Fehler: Keine Region mit ARS "${ars}" im Tenant "${tenantSlug}".`
        : ortsteilName
          ? `Fehler: Kein Ortsteil "${ortsteilName}" im Tenant "${tenantSlug}".`
          : `Fehler: Kein Gemeinde-Knoten im Tenant "${tenantSlug}" gefunden.`,
    );
    await pg.end();
    process.exit(1);
  }
  const region = regionRows[0];

  // Ortsteil-Datensatz nur, wenn der Anker ein Ortsteil ist (wie qrEinloesenCore:
  // ortsteile über normalisiertes Label tenant-scoped auflösen).
  let ortsteilId: string | undefined;
  if (region.typ === "ortsteil") {
    const otRows = await db
      .select({ id: ortsteile.id })
      .from(ortsteile)
      .where(
        and(
          eq(ortsteile.tenantId, tenant.id),
          sql`regions_ltree_label(${ortsteile.code}) = ${region.pathLabel}`,
        ),
      )
      .limit(1);
    ortsteilId = otRows[0]?.id;
  }

  // Grant + Audit atomar. grantResidency setzt exakt die Verifizierungs-Felder;
  // der Audit-Eintrag ist PII-frei (nur User-UUID, keine E-Mail).
  const verifiedUntil = await db.transaction(async (tx: Db) => {
    const until = await grantResidency(tx, tenant.id, userId, "remote_admin_override", {
      regionId: region.id,
      regionTyp: region.typ,
      ortsteilId,
    });
    await tx.insert(auditEvents).values({
      tenantId: tenant.id,
      actorType: "admin",
      actorRef: null,
      action: "residency.granted",
      targetType: "user",
      targetId: userId,
      metadata: {
        method: "remote_admin_override",
        regionTyp: region.typ,
        tenant: tenantSlug,
        // KEINE E-Mail — PII-frei.
      },
    });
    return until;
  });

  console.log(`✓ Wohnsitz verifiziert (Betreiber-Override).`);
  console.log(`  Tenant:   ${tenantSlug} (${tenant.name})`);
  console.log(`  User-ID:  ${userId}`);
  console.log(`  Anker:    ${region.name} (${region.typ})${ortsteilId ? " + Ortsteil-Datensatz" : ""}`);
  console.log(`  Gültig bis: ${verifiedUntil.toISOString()}`);
  console.log(`  Methode:  remote_admin_override · Audit: residency.granted`);

  await pg.end();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
