/**
 * grant-role.ts — Rollen-Vergabe-CLI (Bootstrap / Notnagel)
 *
 * NUR für den ERST-ADMIN einer Kommune (Bootstrap) oder den Notfall (kein
 * erreichbarer Admin mehr). Im REGELBETRIEB werden Mitwirkende NICHT mehr per
 * CLI berechtigt, sondern über den Einladungs-Flow eingeladen: Admin-Bereich →
 * „Rollen verwalten" → „Mitwirkende einladen" (auditiert, eskalationsgeschützt,
 * per E-Mail bestätigt). Diese CLI bleibt bewusst bestehen, um den allerersten
 * kommune_admin/super_admin anzulegen, bevor überhaupt jemand einladen kann.
 *
 * Vergibt eine Rolle an einen User per E-Mail.
 *
 * Verwendung:
 *   npm run grant-role -- --tenant taunusstein --email admin@example.com --role kommune_admin --scope stadt
 *   npm run grant-role -- --tenant taunusstein --email super@partizip.online --role super_admin --scope stadt
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 *
 * Gate-B: Jede Rollen-Vergabe wird als audit_event gespeichert (PII-frei: kein E-Mail-Log).
 *
 * Block K3 (Vier-Augen): In der App wird die Rolle `verifier` zweistufig
 * vergeben (Vorschlag → Bestätigung, role_appointments). Dieses Skript ist ein
 * BEWUSSTER Betreiber-Bypass und bleibt unangetastet — es vergibt ohnehin nur
 * die Admin-Rollen (VALID_ROLES), keinen `verifier`.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and } from "drizzle-orm";
import {
  tenants,
  users,
  roles,
  auditEvents,
} from "../src/db/schema.js";
import { resolveRegionId } from "./seed-utils.js";
import { normalizeEmail } from "../src/lib/auth/email.js";

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
const roleType = getArg("--role") as "kommune_admin" | "super_admin" | null;
const scopeLevel = (getArg("--scope") ?? "stadt") as "ortsteil" | "stadt" | "kreis" | "land";

const VALID_ROLES = ["kommune_admin", "super_admin"];
const VALID_SCOPES = ["ortsteil", "stadt", "kreis", "land"];

if (!tenantSlug || !email || !roleType) {
  console.error("Fehler: --tenant, --email und --role sind erforderlich");
  console.error("Gültige Rollen: " + VALID_ROLES.join(", "));
  console.error("Gültige Scopes: " + VALID_SCOPES.join(", "));
  process.exit(1);
}

if (!VALID_ROLES.includes(roleType)) {
  console.error(`Ungültige Rolle: "${roleType}". Gültig: ${VALID_ROLES.join(", ")}`);
  process.exit(1);
}

if (!VALID_SCOPES.includes(scopeLevel)) {
  console.error(`Ungültiger Scope: "${scopeLevel}". Gültig: ${VALID_SCOPES.join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  // Tenant laden
  const tenantRows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug!))
    .limit(1);

  if (tenantRows.length === 0) {
    console.error(`Fehler: Tenant "${tenantSlug}" nicht gefunden.`);
    await sql.end();
    process.exit(1);
  }

  const tenant = tenantRows[0];

  // User laden (tenant-scoped!)
  const userRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.email, normalizeEmail(email!))))
    .limit(1);

  if (userRows.length === 0) {
    console.error(
      `Fehler: User mit E-Mail "${email}" in Tenant "${tenantSlug}" nicht gefunden.\n` +
      "Tipp: User muss sich zuerst per Magic-Link eingeloggt haben (Account erstellt)."
    );
    await sql.end();
    process.exit(1);
  }

  const userId = userRows[0].id;

  // ADR-024 contract: Scope-Eingabe → region_id (Dual-Write-Trigger ist entfernt).
  const regionId = await resolveRegionId(db, tenant.id, scopeLevel, null);

  // Rolle vergeben (idempotent)
  await db
    .insert(roles)
    .values({
      tenantId: tenant.id,
      userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      roleType: roleType as any,
      regionId,
    })
    .onConflictDoNothing();

  // Audit-Event (PII-frei: User-UUID, keine E-Mail)
  await db.insert(auditEvents).values({
    tenantId: tenant.id,
    actorType: "system",
    actorRef: null,
    action: "role.granted",
    targetType: "user",
    targetId: userId,
    metadata: {
      roleType,
      scopeLevel,
      tenant: tenantSlug,
      // KEINE E-Mail in metadata — PII-frei
    },
  });

  console.log(`✓ Rolle "${roleType}" (Scope: ${scopeLevel}) vergeben.`);
  console.log(`  Tenant: ${tenantSlug} (${tenant.name})`);
  console.log(`  User-ID: ${userId}`);
  console.log(`  Audit-Event: role.granted`);

  await sql.end();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
