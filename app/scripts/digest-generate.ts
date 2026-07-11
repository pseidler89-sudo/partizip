/**
 * digest-generate.ts — Digest-Generierungs-CLI (M7)
 *
 * Legt einen Digest-Entwurf für eine importierte Sitzung an.
 * Fehler wenn Digest für diese Sitzung bereits existiert.
 *
 * Verwendung:
 *   npm run digest:generate -- --meeting <meeting-uuid>
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import {
  risMeetings,
  risDocuments,
  risBodies,
  digests,
  digestStatements,
  auditEvents,
} from "../src/db/schema.js";
import { generateWithFallback } from "../src/lib/digest/select-generator.js";
import type { MeetingInput, DocumentInput } from "../src/lib/digest/types.js";

// ---------------------------------------------------------------------------
// CLI-Argumente
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const meetingIdx = args.indexOf("--meeting");
const meetingId = meetingIdx !== -1 ? args[meetingIdx + 1] : null;

if (!meetingId) {
  console.error("Fehler: --meeting <uuid> ist erforderlich");
  console.error("Beispiel: npm run digest:generate -- --meeting <meeting-uuid>");
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

  // Meeting laden
  const meetingRows = await db
    .select()
    .from(risMeetings)
    .where(eq(risMeetings.id, meetingId!))
    .limit(1);

  if (meetingRows.length === 0) {
    console.error(`Fehler: Meeting mit ID "${meetingId}" nicht gefunden.`);
    await sql.end();
    process.exit(1);
  }

  const meeting = meetingRows[0];

  // Prüfen ob Digest bereits existiert
  const existingDigest = await db
    .select({ id: digests.id })
    .from(digests)
    .where(eq(digests.meetingId, meeting.id))
    .limit(1);

  if (existingDigest.length > 0) {
    console.error(`Fehler: Digest für Meeting "${meetingId}" existiert bereits (ID: ${existingDigest[0].id}).`);
    console.error("Lösche den bestehenden Digest oder nutze die Admin-UI um ihn zu bearbeiten.");
    await sql.end();
    process.exit(1);
  }

  // Tenant-ID über Body ermitteln
  const bodyRows = await db
    .select({ tenantId: risBodies.tenantId })
    .from(risBodies)
    .where(eq(risBodies.id, meeting.bodyId))
    .limit(1);

  if (bodyRows.length === 0) {
    console.error(`Fehler: Body für Meeting nicht gefunden.`);
    await sql.end();
    process.exit(1);
  }

  const tenantId = bodyRows[0].tenantId;

  // Dokumente laden
  const docs = await db
    .select()
    .from(risDocuments)
    .where(eq(risDocuments.meetingId, meeting.id));

  console.log(`Meeting: ${meeting.gremium ?? meeting.title ?? meeting.id}`);
  console.log(`Datum: ${meeting.meetingDate?.toLocaleDateString("de-DE") ?? "unbekannt"}`);
  console.log(`Dokumente: ${docs.length}`);

  // Generator ausführen (mit automatischem Fallback: llm_v2 → extractive_v1)
  const meetingInput: MeetingInput = {
    id: meeting.id,
    gremium: meeting.gremium,
    title: meeting.title,
    meetingDate: meeting.meetingDate,
    location: meeting.location,
    // M1(c): Stabile Meeting-URL für Wicket-PDF-Statement-URLs
    sourceUrl: meeting.sourceUrl,
  };

  const docInputs: DocumentInput[] = docs.map((d) => ({
    id: d.id,
    docType: d.docType,
    title: d.title,
    bodyText: d.bodyText,
    sourceUrl: d.sourceUrl,
    externalId: d.externalId,
  }));

  const draft = await generateWithFallback(meetingInput, docInputs);

  console.log(`\nGenerierter Digest: "${draft.title}"`);
  console.log(`Generator: ${draft.generator}`);
  console.log(`Aussagen: ${draft.statements.length}`);

  if (draft.statements.length === 0) {
    console.warn(
      "Warnung: Keine Aussagen generiert. " +
      "Prüfe ob Dokumente mit body_text vorhanden sind (ris:import lief durch?)."
    );
  }

  // N4: Digest+Statements+Audit in echter DB-Transaktion (atomisch)
  const digestRow = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(digests)
      .values({
        tenantId,
        meetingId: meeting.id,
        title: draft.title,
        status: "entwurf",
        generator: draft.generator,
      })
      .returning();

    // Aussagen einfügen
    for (const stmt of draft.statements) {
      await tx.insert(digestStatements).values({
        digestId: row.id,
        position: stmt.position,
        text: stmt.text,
        sourceDocumentId: stmt.sourceDocumentId,
        sourceUrl: stmt.sourceUrl,
      });
    }

    // Audit
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "system",
      actorRef: null,
      action: "digest.generated",
      targetType: "digest",
      targetId: row.id,
      metadata: {
        meetingId: meeting.id,
        generator: draft.generator,
        statements: draft.statements.length,
      },
    });

    return row;
  });

  console.log(`\n✓ Digest angelegt (ID: ${digestRow.id})`);
  console.log(`Status: entwurf → Freigabe via Admin-UI erforderlich.`);

  // Aussagen ausgeben
  if (draft.statements.length > 0) {
    console.log("\nAussagen:");
    for (const stmt of draft.statements) {
      console.log(`  ${stmt.position}. ${stmt.text}`);
      console.log(`     Quelle: ${stmt.sourceUrl}`);
    }
  }

  await sql.end();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
