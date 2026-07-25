/**
 * digest-publish.ts — Betreiber-CLI zur Digest-Freigabe + Veröffentlichung.
 *
 * SANKTIONIERTER Betreiber-Weg (KEIN direkter DB-Write, der App-Sperren umgeht):
 * das CLI konsultiert dieselbe Kern-Logik wie die Admin-UI — freigebenCore
 * (SoD/Vier-Augen, ALLOW_SELF_APPROVAL) UND veroeffentlichenCore (atomarer CAS,
 * Demo-Fence, Kanal-Versand). Muster wie scripts/grant-role.ts / grant-residency.ts:
 * ein bewusster, auditierter Betreiber-Override für Fälle, in denen der/die Owner
 * die Inhalte real reviewt und die Freigabe+Veröffentlichung an den Betreiber
 * delegiert hat.
 *
 * Die gesamte Orchestrierung liegt testbar in @/lib/digest/publish-cli-core;
 * dieses Skript ist NUR argv-Parsing, Env-Auflösung und Exit-Codes.
 *
 * Ablauf (Status 'entwurf'):
 *   1. [optional] --titel ersetzt VOR der Freigabe den Digest-Titel (1–160 Zeichen).
 *   2. Alle NOCH ungeprüften Aussagen werden als geprüft gestempelt (geprueft_by =
 *      aufgelöster AKTIVER Admin; m7: nur isNull(geprueft_at), nie überschreiben).
 *   3. Freigabe über freigebenCore (SoD unverändert; Selbstfreigabe nur bei
 *      ALLOW_SELF_APPROVAL=true — sonst schlägt die Freigabe ehrlich fehl).
 *   4. [Default] Veröffentlichung über veroeffentlichenCore. --nur-freigeben aus.
 *   5. Zusätzliches, PII-freies Audit-Event digest.cli_publish (Transparenz).
 *
 * Bereits 'freigegeben' ⇒ Schritt 1–3 übersprungen. Bereits 'veroeffentlicht' ⇒
 * idempotenter Hinweis, Exit 0.
 *
 * Verwendung:
 *   npm run digest:publish -- --tenant taunusstein --digest <uuid> --actor-email admin@example.com
 *   npm run digest:publish -- --tenant taunusstein --digest <uuid> --actor-email a@x.de --titel "Neuer Titel"
 *   npm run digest:publish -- --tenant taunusstein --digest <uuid> --actor-email a@x.de --nur-freigeben
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 *      ALLOW_SELF_APPROVAL (nur "true" hebt die Vier-Augen-Selbstfreigabe-Sperre auf)
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema.js";
import { isSelfApprovalAllowed } from "../src/lib/digest/freigabe-core.js";
import { digestPublishCli } from "../src/lib/digest/publish-cli-core.js";
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
const digestId = getArg("--digest");
const actorEmail = getArg("--actor-email");
const titelArg = getArg("--titel");
const nurFreigeben = args.includes("--nur-freigeben");

if (!tenantSlug || !digestId || !actorEmail) {
  console.error("Fehler: --tenant, --digest und --actor-email sind erforderlich.");
  console.error(
    'Beispiel: npm run digest:publish -- --tenant taunusstein --digest <uuid> --actor-email admin@example.com [--titel "..."] [--nur-freigeben]',
  );
  process.exit(1);
}

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg, { schema }) as unknown as Db;

  try {
    const result = await digestPublishCli(db, {
      tenantSlug: tenantSlug!,
      digestId: digestId!,
      actorEmail: actorEmail!,
      neuerTitel: titelArg,
      nurFreigeben,
      allowSelfApproval: isSelfApprovalAllowed(),
    });

    if (!result.ok) {
      console.error(`Fehler: ${result.error}`);
      await pg.end();
      process.exit(1);
    }

    if (result.bereitsVeroeffentlicht) {
      console.log(`✓ Digest ist bereits veröffentlicht — nichts zu tun (idempotent).`);
      console.log(`  Digest: ${result.digestId} · Tenant: ${tenantSlug}`);
      await pg.end();
      process.exit(0);
    }

    console.log(`✓ Fertig.`);
    console.log(`  Tenant:   ${tenantSlug} (${result.tenantName})`);
    console.log(`  Digest:   ${result.digestId}`);
    console.log(`  Actor:    ${result.actorId}`);
    console.log(`  Schritte: ${(result.schritte ?? []).join(" → ")}`);
    console.log(`  Audit:    digest.cli_publish`);

    await pg.end();
  } catch (err) {
    console.error("Fehler:", err instanceof Error ? err.message : String(err));
    await pg.end();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
