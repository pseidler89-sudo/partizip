/**
 * import-draft.ts — Kernlogik für Assisted-V1-Digest-Import
 *
 * Wird von digest-import-draft.ts verwendet. Skript bleibt dünn, Logik hier.
 * Gleiche Transaktion/Persistenz wie digest-generate.ts.
 * generator = "assisted_v1"
 *
 * Verhalten bei existierendem Entwurf:
 *   - Status "entwurf": Fehler (wie digest-generate.ts — kein stilles Überschreiben)
 *   - Status "freigegeben" oder "veroeffentlicht": harter Fehler, kein Anfassen
 */

import { eq } from "drizzle-orm";
import {
  risMeetings,
  risDocuments,
  risBodies,
  digests,
  digestStatements,
  auditEvents,
} from "../../db/schema.js";
import type { DocumentInput, MeetingInput } from "./types.js";
import { parseAndValidateDraftJson } from "./validate-draft.js";
import type { Db } from "../../db/client.js";

export const GENERATOR_NAME = "assisted_v1";

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface ImportDraftResult {
  digestId: string;
  title: string;
  statementsCount: number;
}

// ---------------------------------------------------------------------------
// importAssistedDraft — Kernfunktion
// ---------------------------------------------------------------------------

/**
 * Lädt Meeting + Dokumente, validiert das JSON, legt den Digest an.
 *
 * @param db - Drizzle-DB-Instanz (aus createDb)
 * @param meetingId - UUID der Sitzung
 * @param draftJson - Roher JSON-String mit { title, statements[] }
 * @returns ImportDraftResult
 * @throws Error bei Verletzungen aller Art
 */
export async function importAssistedDraft(
  db: Db,
  meetingId: string,
  draftJson: string
): Promise<ImportDraftResult> {
  // Meeting laden
  const meetingRows = await db
    .select()
    .from(risMeetings)
    .where(eq(risMeetings.id, meetingId))
    .limit(1);

  if (meetingRows.length === 0) {
    throw new Error(`Meeting mit ID "${meetingId}" nicht gefunden.`);
  }

  const meeting = meetingRows[0];

  // Prüfen ob freigegebener/veröffentlichter Digest existiert → harter Stopp
  const existingDigests = await db
    .select({ id: digests.id, status: digests.status })
    .from(digests)
    .where(eq(digests.meetingId, meeting.id));

  for (const d of existingDigests) {
    if (d.status === "freigegeben" || d.status === "veroeffentlicht") {
      throw new Error(
        `Digest für Meeting "${meetingId}" hat Status "${d.status}" (ID: ${d.id}). ` +
        "Freigegebene/veröffentlichte Digests dürfen nicht ersetzt werden."
      );
    }
  }

  // Entwurf bereits vorhanden? → wie digest-generate.ts: Fehler + klarer Hinweis
  const entwurfDigest = existingDigests.find(
    (d: { id: string; status: string }) => d.status === "entwurf"
  );
  if (entwurfDigest) {
    throw new Error(
      `Digest-Entwurf für Meeting "${meetingId}" existiert bereits (ID: ${entwurfDigest.id}). ` +
      "Lösche den bestehenden Entwurf oder nutze die Admin-UI um ihn zu bearbeiten."
    );
  }

  // Tenant-ID über Body ermitteln
  const bodyRows = await db
    .select({ tenantId: risBodies.tenantId })
    .from(risBodies)
    .where(eq(risBodies.id, meeting.bodyId))
    .limit(1);

  if (bodyRows.length === 0) {
    throw new Error(`Body für Meeting "${meetingId}" nicht gefunden.`);
  }

  const tenantId = bodyRows[0].tenantId;

  // Dokumente laden
  const docs = await db
    .select()
    .from(risDocuments)
    .where(eq(risDocuments.meetingId, meeting.id));

  if (docs.length === 0) {
    throw new Error(
      `Keine Dokumente für Meeting "${meetingId}" gefunden. ` +
      "Bitte ris:import zuerst ausführen."
    );
  }

  // DocumentInput-Array aufbauen (für Validierung)
  const docInputs: DocumentInput[] = docs.map((d: typeof docs[number]) => ({
    id: d.id,
    docType: d.docType,
    title: d.title,
    bodyText: d.bodyText,
    sourceUrl: d.sourceUrl,
    externalId: d.externalId,
  }));

  const meetingInput: MeetingInput = {
    id: meeting.id,
    gremium: meeting.gremium,
    title: meeting.title,
    meetingDate: meeting.meetingDate,
    location: meeting.location,
    sourceUrl: meeting.sourceUrl ?? undefined,
  };

  // JSON validieren (identische Regeln wie llm_v2 / validate-draft.ts)
  const validated = parseAndValidateDraftJson(draftJson, docInputs, meetingInput.sourceUrl);

  // Digest + Statements + Audit in echter DB-Transaktion (atomisch, wie digest-generate.ts)
  const digestRow = await db.transaction(async (tx: Db) => {
    const [row] = await tx
      .insert(digests)
      .values({
        tenantId,
        meetingId: meeting.id,
        title: validated.title,
        status: "entwurf",
        generator: GENERATOR_NAME,
      })
      .returning();

    // Statements einfügen
    for (const stmt of validated.statements) {
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
        generator: GENERATOR_NAME,
        statements: validated.statements.length,
      },
    });

    return row;
  });

  return {
    digestId: digestRow.id,
    title: validated.title,
    statementsCount: validated.statements.length,
  };
}
