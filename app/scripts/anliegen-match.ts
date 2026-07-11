/**
 * anliegen-match.ts — CLI für semantisches Matching (M8)
 *
 * Berechnet Kandidaten (confidence >= 0.15, max. 5 je Anliegen),
 * upsertet anliegen_matches (vorgeschlagen).
 * Bestehende bestaetigt/verworfen werden NIE überschrieben.
 *
 * Verwendung:
 *   npm run anliegen:match -- --tenant taunusstein [--anliegen <id>]
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  anliegen,
  anliegenMatches,
  risBodies,
  risDocuments,
  risMeetings,
  tenants,
} from "../src/db/schema.js";
import { computeMatches } from "../src/lib/anliegen/matching.js";

// ---------------------------------------------------------------------------
// CLI-Argument-Parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let tenantSlug: string | undefined;
let filterAnliegenId: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tenant" && args[i + 1]) tenantSlug = args[++i];
  if (args[i] === "--anliegen" && args[i + 1]) filterAnliegenId = args[++i];
}

if (!tenantSlug) {
  console.error("Fehler: --tenant <slug> ist erforderlich.");
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
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug!))
    .limit(1);

  if (tenantRows.length === 0) {
    console.error(`Tenant '${tenantSlug}' nicht gefunden.`);
    await sql.end();
    process.exit(1);
  }

  const tenant = tenantRows[0];
  console.log(`Tenant: ${tenant.slug} (${tenant.id})`);

  // Anliegen laden (tenant-scoped, mit Text)
  const anliegenQuery = db
    .select({
      anliegenId: anliegen.id,
      titel: anliegen.titel,
      beschreibung: anliegen.beschreibung,
    })
    .from(anliegen)
    .where(
      filterAnliegenId
        ? and(
            eq(anliegen.tenantId, tenant.id),
            eq(anliegen.id, filterAnliegenId)
          )
        : eq(anliegen.tenantId, tenant.id)
    );

  const anliegenList = await anliegenQuery;
  console.log(`Anliegen: ${anliegenList.length} gefunden.`);

  if (anliegenList.length === 0) {
    await sql.end();
    return;
  }

  // RIS-Dokumente für den Tenant laden (nur mit body_text)
  const bodyRows = await db
    .select({ id: risBodies.id })
    .from(risBodies)
    .where(eq(risBodies.tenantId, tenant.id));

  if (bodyRows.length === 0) {
    console.log("Keine RIS-Bodies für diesen Tenant — kein Matching möglich.");
    await sql.end();
    return;
  }

  // Dokumente mit body_text aus Tenant-Meetings laden
  const docsForTenant = await db
    .select({
      id: risDocuments.id,
      bodyText: risDocuments.bodyText,
      title: risDocuments.title,
      sourceUrl: risDocuments.sourceUrl,
    })
    .from(risDocuments)
    .innerJoin(risMeetings, eq(risDocuments.meetingId, risMeetings.id))
    .innerJoin(risBodies, eq(risMeetings.bodyId, risBodies.id))
    .where(
      and(
        eq(risBodies.tenantId, tenant.id),
        isNotNull(risDocuments.bodyText)
      )
    );

  console.log(`Dokumente: ${docsForTenant.length} mit body_text.`);

  // Matching für jedes Anliegen
  let totalCandidates = 0;
  let totalUpserted = 0;

  for (const a of anliegenList) {
    const candidates = computeMatches(
      { anliegenId: a.anliegenId, titel: a.titel, beschreibung: a.beschreibung },
      docsForTenant
    );

    if (candidates.length === 0) {
      console.log(`  [${a.titel.slice(0, 50)}] → 0 Kandidaten`);
      continue;
    }

    totalCandidates += candidates.length;

    for (const c of candidates) {
      // Upsert: vorgeschlagen — bestehende bestaetigt/verworfen NIE überschreiben
      const existing = await db
        .select({ id: anliegenMatches.id, status: anliegenMatches.status })
        .from(anliegenMatches)
        .where(
          and(
            eq(anliegenMatches.anliegenId, c.anliegenId),
            eq(anliegenMatches.risDocumentId, c.risDocumentId)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        const curr = existing[0];
        if (curr.status === "bestaetigt" || curr.status === "verworfen") {
          // NIE überschreiben
          continue;
        }
        // vorgeschlagen → confidence aktualisieren
        await db
          .update(anliegenMatches)
          .set({ confidence: c.confidence.toFixed(4) })
          .where(eq(anliegenMatches.id, curr.id));
      } else {
        await db.insert(anliegenMatches).values({
          anliegenId: c.anliegenId,
          risDocumentId: c.risDocumentId,
          confidence: c.confidence.toFixed(4),
          status: "vorgeschlagen",
        });
        totalUpserted++;
      }
    }

    console.log(
      `  [${a.titel.slice(0, 50)}] → ${candidates.length} Kandidaten ` +
      candidates.map(c => `(${(c.confidence * 100).toFixed(1)}%)`).join(", ")
    );
  }

  console.log(`\nErgebnis: ${totalCandidates} Kandidaten, ${totalUpserted} neu eingetragen.`);
  await sql.end();
}

main().catch(err => {
  console.error("Matching fehlgeschlagen:", err);
  process.exit(1);
});
