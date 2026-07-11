/**
 * digest-import-draft.ts — Import von manuell formulierten Digest-Entwürfen (M7)
 *
 * Legt einen Digest-Entwurf mit generator="assisted_v1" an.
 * Validierung identisch zu llm_v2 (gemeinsames validate-draft-Modul).
 *
 * Verwendung:
 *   npm run digest:import-draft -- --meeting <meeting-uuid> --file <pfad-zum-json>
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFile } from "node:fs/promises";
import { importAssistedDraft } from "../src/lib/digest/import-draft.js";
import * as schema from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// CLI-Argumente
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const meetingIdx = args.indexOf("--meeting");
const fileIdx = args.indexOf("--file");
const meetingId = meetingIdx !== -1 ? args[meetingIdx + 1] : null;
const filePath = fileIdx !== -1 ? args[fileIdx + 1] : null;

if (!meetingId || !filePath) {
  console.error("Fehler: --meeting <uuid> und --file <pfad> sind erforderlich");
  console.error(
    "Beispiel: npm run digest:import-draft -- --meeting <meeting-uuid> --file var/digest-export/mein-entwurf.json"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  // Entwurf-JSON-Datei lesen
  let draftJson: string;
  try {
    draftJson = await readFile(filePath!, "utf-8");
  } catch (err) {
    console.error(`Fehler: Datei "${filePath}" konnte nicht gelesen werden.`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    const result = await importAssistedDraft(db as Parameters<typeof importAssistedDraft>[0], meetingId!, draftJson);

    console.log(`\n✓ Digest angelegt (ID: ${result.digestId})`);
    console.log(`Titel: ${result.title}`);
    console.log(`Aussagen: ${result.statementsCount}`);
    console.log(`Generator: assisted_v1`);
    console.log(`Status: entwurf → Freigabe via Admin-UI erforderlich.`);
    console.log(`\nAdmin-UI: /admin/digests/${result.digestId}`);
  } catch (err) {
    console.error("Fehler:", err instanceof Error ? err.message : String(err));
    await sql.end();
    process.exit(1);
  }

  await sql.end();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
