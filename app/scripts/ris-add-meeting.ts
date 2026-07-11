/**
 * ris-add-meeting.ts — Manuelle ALLRIS-SILFDNR-Erfassung (M7)
 *
 * ALLRIS-Listenseiten sind Wicket-Formulare → keine automatische Discovery.
 * Dieses Script erlaubt die manuelle Erfassung einer Sitzungs-ID (SILFDNR).
 * Die ID wird dann beim nächsten ris:import aufgegriffen.
 *
 * Verwendung:
 *   npm run ris:add-meeting -- --body taunusstein-stadt --silfdnr 4021
 *   npm run ris:add-meeting -- --body taunusstein-stadt --silfdnr 4021 --title "StVV 05.04.2017"
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import {
  risBodies,
  risMeetings,
  auditEvents,
} from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// CLI-Argumente
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const bodyKeyIdx = args.indexOf("--body");
const silfdnrIdx = args.indexOf("--silfdnr");
const titleIdx = args.indexOf("--title");

const bodyKey = bodyKeyIdx !== -1 ? args[bodyKeyIdx + 1] : null;
const silfdnr = silfdnrIdx !== -1 ? args[silfdnrIdx + 1] : null;
const title = titleIdx !== -1 ? args[titleIdx + 1] : null;

if (!bodyKey || !silfdnr) {
  console.error("Fehler: --body <key> und --silfdnr <id> sind erforderlich");
  console.error("Beispiel: npm run ris:add-meeting -- --body taunusstein-stadt --silfdnr 4021");
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

  // Body laden
  const bodyRows = await db
    .select()
    .from(risBodies)
    .where(eq(risBodies.key, bodyKey!))
    .limit(1);

  if (bodyRows.length === 0) {
    console.error(`Fehler: RIS-Body mit key="${bodyKey}" nicht gefunden.`);
    await sql.end();
    process.exit(1);
  }

  const body = bodyRows[0];

  // ALLRIS-spezifisch: Basis-URL für to010
  const sourceUrl = `${body.baseUrl}/allris/to010?SILFDNR=${silfdnr}`;

  // Idempotent einfügen
  const [row] = await db
    .insert(risMeetings)
    .values({
      bodyId: body.id,
      externalId: silfdnr!,
      title: title ?? null,
      sourceUrl,
      fetchedAt: new Date(),
      rawMeta: { addedManually: true },
    })
    .onConflictDoUpdate({
      target: [risMeetings.bodyId, risMeetings.externalId],
      set: {
        title: title ?? null,
        sourceUrl,
        rawMeta: { addedManually: true },
      },
    })
    .returning({ id: risMeetings.id });

  // Audit
  await db.insert(auditEvents).values({
    tenantId: body.tenantId,
    actorType: "system",
    actorRef: null,
    action: "ris.meeting.added_manually",
    metadata: {
      bodyKey: body.key,
      silfdnr,
      title: title ?? null,
    },
  });

  console.log(`Sitzung SILFDNR ${silfdnr} für Body "${bodyKey}" erfasst (ID: ${row.id}).`);
  console.log(`Jetzt: npm run ris:import -- --body ${bodyKey} --meeting ${silfdnr}`);
  await sql.end();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
