/**
 * ris-import.ts — RIS-Import-CLI (M7)
 *
 * Importiert/aktualisiert Meetings + Dokumente idempotent.
 * Idempotenz: UNIQUE-Keys (body_id, external_id) + content_hash-Vergleich.
 *
 * Verwendung:
 *   npm run ris:import -- --body rheingau-taunus-kreis
 *   npm run ris:import -- --body rheingau-taunus-kreis --meeting 3452
 *   npm run ris:import -- --body taunusstein-stadt
 *
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 *
 * DROSSELUNG: min. 1100 ms zwischen Requests je Host (fetch-wrapper.ts).
 * Live-HTTP-Requests: NUR in diesem CLI (nicht in Tests!).
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  risBodies,
  risMeetings,
  risDocuments,
  auditEvents,
} from "../src/db/schema.js";
import { ProvoxAdapter } from "../src/lib/ris/provox.js";
import { AllrisAdapter } from "../src/lib/ris/allris.js";
import { OparlAdapter } from "../src/lib/ris/oparl.js";
import type { MeetingRef, DocumentRef } from "../src/lib/ris/types.js";

// ---------------------------------------------------------------------------
// CLI-Argumente
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const bodyKeyIdx = args.indexOf("--body");
const meetingIdx = args.indexOf("--meeting");

const bodyKey = bodyKeyIdx !== -1 ? args[bodyKeyIdx + 1] : null;
const meetingFilter = meetingIdx !== -1 ? args[meetingIdx + 1] : null;

if (!bodyKey) {
  console.error("Fehler: --body <key> ist erforderlich");
  console.error("Beispiel: npm run ris:import -- --body rheingau-taunus-kreis");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
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

  // Body aus DB laden
  const bodyRows = await db
    .select()
    .from(risBodies)
    .where(eq(risBodies.key, bodyKey!))
    .limit(1);

  if (bodyRows.length === 0) {
    console.error(`Fehler: RIS-Body mit key="${bodyKey}" nicht in der DB gefunden.`);
    console.error("Führe zuerst 'npm run db:seed' aus um ris_bodies zu befüllen.");
    await sql.end();
    process.exit(1);
  }

  const body = bodyRows[0];
  console.log(`RIS-Body: ${body.key} (${body.risType}) @ ${body.baseUrl}`);
  console.log(`Tenant-ID: ${body.tenantId}`);

  // Adapter erstellen
  let adapter: ProvoxAdapter | AllrisAdapter | OparlAdapter;

  if (body.risType === "provox_iip") {
    adapter = new ProvoxAdapter({
      baseUrl: body.baseUrl,
      downloadPdfs: true,
    });
  } else if (body.risType === "allris4") {
    // Bekannte SILFDNRs aus DB laden
    const existingMeetings = await db
      .select({ externalId: risMeetings.externalId })
      .from(risMeetings)
      .where(eq(risMeetings.bodyId, body.id));

    const knownSilfdnrs = existingMeetings.map((m) => m.externalId);

    if (meetingFilter) {
      knownSilfdnrs.push(meetingFilter);
    }

    adapter = new AllrisAdapter({
      baseUrl: body.baseUrl,
      knownSilfdnrs: [...new Set(knownSilfdnrs)],
      downloadPdfs: true,
    });
  } else if (body.risType === "oparl") {
    // H-3: OPARL_MAX_PAGES überschreibt den Default (5); NaN-sicher
    const envMaxPages = parseInt(process.env.OPARL_MAX_PAGES ?? "", 10);
    const maxPages = Number.isFinite(envMaxPages) && envMaxPages > 0 ? envMaxPages : undefined;
    adapter = new OparlAdapter({
      bodyUrl: body.baseUrl,
      maxPages,
    });
  } else {
    console.error(`Unbekannter RIS-Typ: ${body.risType}`);
    await sql.end();
    process.exit(1);
  }

  // Meetings abrufen
  console.log("Lade Sitzungsliste…");
  const meetingRefs = await (adapter as { listRecentMeetings(): Promise<MeetingRef[]> }).listRecentMeetings();

  // Filter: einzelne Sitzung?
  const toProcess = meetingFilter
    ? meetingRefs.filter((r) => r.externalId === meetingFilter)
    : meetingRefs;

  if (meetingFilter && toProcess.length === 0) {
    // Bei ALLRIS: meetingFilter als neuen SILFDNR hinzufügen
    if (body.risType === "allris4") {
      toProcess.push({
        externalId: meetingFilter,
        sourceUrl: `${body.baseUrl}/allris/to010?SILFDNR=${meetingFilter}`,
      });
    } else {
      console.error(`Meeting ${meetingFilter} nicht in der Sitzungsliste gefunden.`);
      await sql.end();
      process.exit(1);
    }
  }

  console.log(`${toProcess.length} Sitzung(en) werden importiert.`);

  let importedMeetings = 0;
  let importedDocs = 0;
  // Fehler werden gezählt und im Exit-Code gespiegelt. Ein Lauf, der Texte
  // verliert, aber mit Code 0 endet, ist von einem erfolgreichen Lauf nicht zu
  // unterscheiden — genau so bleiben kaputte Importe unbemerkt.
  let fehler = 0;

  for (const ref of toProcess) {
    console.log(`\nSitzung ${ref.externalId}: ${ref.gremium ?? ref.title ?? "?"} (${ref.meetingDate?.toLocaleDateString("de-DE") ?? "kein Datum"})`);

    // Meeting in DB upserten
    const [meetingRow] = await db
      .insert(risMeetings)
      .values({
        bodyId: body.id,
        externalId: ref.externalId,
        gremium: ref.gremium ?? null,
        title: ref.title ?? null,
        meetingDate: ref.meetingDate ?? null,
        location: ref.location ?? null,
        sourceUrl: ref.sourceUrl,
        fetchedAt: new Date(),
        rawMeta: {},
      })
      .onConflictDoUpdate({
        target: [risMeetings.bodyId, risMeetings.externalId],
        set: {
          gremium: ref.gremium ?? null,
          title: ref.title ?? null,
          meetingDate: ref.meetingDate ?? null,
          location: ref.location ?? null,
          sourceUrl: ref.sourceUrl,
          fetchedAt: new Date(),
        },
      })
      .returning();

    const meetingId = meetingRow.id;

    // Details + Dokumente laden
    console.log(`  → Details abrufen…`);
    let fetchedMeeting: Awaited<ReturnType<typeof adapter.fetchMeeting>>;
    try {
      fetchedMeeting = await adapter.fetchMeeting(ref);
    } catch (err) {
      console.error(`  Fehler beim Abrufen: ${err instanceof Error ? err.message : err}`);
      fehler++;
      continue;
    }

    // Vom Adapter verschluckte Einzelfehler (z. B. fehlgeschlagene PDF-Downloads)
    // mitzählen — sonst meldet der Import Erfolg, obwohl Texte fehlen.
    const adapterFehler = (adapter as { errorCount?: number }).errorCount ?? 0;
    if (adapterFehler > 0) {
      console.error(`  ${adapterFehler} Dokument(e) konnten nicht geladen werden.`);
      fehler += adapterFehler;
    }

    // Meeting-Metadaten aktualisieren
    const m = fetchedMeeting.meeting;
    await db
      .update(risMeetings)
      .set({
        gremium: m.gremium ?? null,
        title: m.title ?? null,
        meetingDate: m.meetingDate ?? null,
        location: m.location ?? null,
        fetchedAt: new Date(),
      })
      .where(eq(risMeetings.id, meetingId));

    importedMeetings++;

    // Dokumente upserten
    for (const doc of fetchedMeeting.documents) {
      await upsertDocument(db, meetingId, doc);
      importedDocs++;
    }

    console.log(`  ✓ ${fetchedMeeting.documents.length} Dokument(e) importiert`);
  }

  // Audit-Event
  await db.insert(auditEvents).values({
    tenantId: body.tenantId,
    actorType: "system",
    actorRef: null,
    action: "ris.import.completed",
    metadata: {
      bodyKey: body.key,
      meetings: importedMeetings,
      documents: importedDocs,
    },
  });

  console.log(`\nImport abgeschlossen: ${importedMeetings} Sitzungen, ${importedDocs} Dokumente.`);
  await sql.end();

  if (fehler > 0) {
    console.error(
      `\n${fehler} Fehler beim Import — Ergebnis ist unvollständig. Exit-Code 1.`
    );
    process.exit(1);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertDocument(db: any, meetingId: string, doc: DocumentRef): Promise<void> {
  const newHash = doc.bodyText ? sha256Hex(doc.bodyText) : null;

  // M1(a): Lookup per IS NOT DISTINCT FROM — funktioniert korrekt auch bei NULL external_id
  // (Postgres: NULL = NULL → false, aber NULL IS NOT DISTINCT FROM NULL → true)
  const existing = await db
    .select({ id: risDocuments.id, contentHash: risDocuments.contentHash })
    .from(risDocuments)
    .where(
      and(
        eq(risDocuments.meetingId, meetingId),
        eq(risDocuments.docType, doc.docType),
        doc.externalId !== null && doc.externalId !== undefined
          ? eq(risDocuments.externalId, doc.externalId)
          : isNull(risDocuments.externalId)
      )
    )
    .limit(1);

  // Ein Lauf OHNE Text (Adapter hat keinen geliefert, PDF-Download fehlgeschlagen,
  // Stadt-Website antwortet 500) darf einen bereits importierten Text NIE
  // überschreiben: body_text/content_hash würden auf NULL fallen und der Digest
  // verlöre seine Grundlage — still, mit Exit-Code 0.
  const textFelder =
    newHash !== null
      ? { bodyText: doc.bodyText ?? null, contentHash: newHash }
      : {};

  if (existing.length > 0) {
    if (existing[0].contentHash === newHash && newHash !== null) {
      // Unverändert → überspringen (nur wenn hash vorhanden und gleich)
      return;
    }
    // Explizites UPDATE (auch wenn hash sich geändert hat oder neu vorhanden).
    // Ohne neuen Text bleiben body_text/content_hash unangetastet.
    await db
      .update(risDocuments)
      .set({
        title: doc.title ?? null,
        sourceUrl: doc.sourceUrl,
        ...textFelder,
        fetchedAt: new Date(),
      })
      .where(eq(risDocuments.id, existing[0].id));
    return;
  }

  // Neu anlegen
  await db
    .insert(risDocuments)
    .values({
      meetingId,
      docType: doc.docType,
      externalId: doc.externalId ?? null,
      title: doc.title ?? null,
      bodyText: doc.bodyText ?? null,
      sourceUrl: doc.sourceUrl,
      contentHash: newHash,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      // Fallback für Race-Condition (NULLS NOT DISTINCT sichert DB-seitig)
      target: [risDocuments.meetingId, risDocuments.docType, risDocuments.externalId],
      set: {
        title: doc.title ?? null,
        sourceUrl: doc.sourceUrl,
        ...textFelder,
        fetchedAt: new Date(),
      },
    });
}

main().catch((err) => {
  console.error("Import fehlgeschlagen:", err);
  process.exit(1);
});
