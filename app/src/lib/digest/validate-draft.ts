/**
 * validate-draft.ts — Gemeinsame Validierung für Digest-Entwürfe (Assisted + LLM)
 *
 * Wird von llm_v2.ts und digest-import-draft.ts verwendet.
 * Identische harte Regeln: title 1–160, 1–30 Statements, text 1–500,
 * sourceDocumentId muss zu den übergebenen Dokumenten gehören.
 * sourceUrl wird NIEMALS aus dem Input übernommen — serverseitig abgeleitet.
 *
 * Wirft bei jeder Regelverletzung einen verständlichen Fehler.
 */

import type { DocumentInput, DraftStatement } from "./types.js";
import { resolveStableUrl } from "./extractive_v1.js";

// ---------------------------------------------------------------------------
// Grenzwerte (identisch zu llm_v2.ts)
// ---------------------------------------------------------------------------

export const MAX_TITLE_CHARS = 160;
export const MAX_STATEMENTS = 30;
export const MIN_STATEMENTS = 1;
export const MAX_STATEMENT_CHARS = 500;
export const MIN_STATEMENT_CHARS = 1;

// ---------------------------------------------------------------------------
// Eingabe-Rohdaten-Typen (wie LLM/Import sie liefern)
// ---------------------------------------------------------------------------

export interface RawStatement {
  text: string;
  sourceDocumentId: string;
  /** Wird ignoriert — sourceUrl wird serverseitig abgeleitet */
  sourceUrl?: string;
}

export interface RawDraftInput {
  title: string;
  statements: RawStatement[];
}

// ---------------------------------------------------------------------------
// Validierungsergebnis
// ---------------------------------------------------------------------------

export interface ValidatedDraft {
  title: string;
  /** Statements mit server-seitiger position + sourceUrl */
  statements: DraftStatement[];
}

// ---------------------------------------------------------------------------
// validateDraft — Kernfunktion
// ---------------------------------------------------------------------------

/**
 * Validiert ein rohes JSON-Objekt gegen die Digest-Regeln.
 *
 * @param raw - Rohes (beliebiges) Objekt, z. B. aus JSON.parse
 * @param allowedDocs - Dokumente der Sitzung; sourceDocumentId muss darin vorkommen
 * @param meetingSourceUrl - Stabile Meeting-URL für Wicket-PDF-Fallback
 * @returns Validiertes {title, statements} mit serverseitiger position + sourceUrl
 * @throws Error bei jeder Regelverletzung
 */
export function validateDraft(
  raw: unknown,
  allowedDocs: DocumentInput[],
  meetingSourceUrl?: string
): ValidatedDraft {
  // Dokument-Lookup aufbauen
  const docById = new Map<string, DocumentInput>(allowedDocs.map((d) => [d.id, d]));
  const validDocIds = new Set(allowedDocs.map((d) => d.id));

  // Eingabe muss ein Objekt sein
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Eingabe ist kein JSON-Objekt.");
  }

  const data = raw as Record<string, unknown>;

  // title validieren (1–160 Zeichen, nicht leer)
  if (typeof data?.title !== "string" || data.title.trim() === "") {
    throw new Error("'title' fehlt oder ist kein nicht-leerer String.");
  }
  const title = (data.title as string).trim();
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(
      `'title' ist zu lang (${title.length} Zeichen, maximal ${MAX_TITLE_CHARS} erlaubt).`
    );
  }

  // statements validieren
  if (!Array.isArray(data?.statements)) {
    throw new Error("'statements' ist kein Array.");
  }

  const stmts = data.statements as unknown[];

  if (stmts.length < MIN_STATEMENTS) {
    throw new Error(
      `'statements' ist leer (mindestens ${MIN_STATEMENTS} Aussage erwartet).`
    );
  }

  if (stmts.length > MAX_STATEMENTS) {
    throw new Error(
      `'statements' enthält ${stmts.length} Einträge (maximal ${MAX_STATEMENTS} erlaubt).`
    );
  }

  const validatedStatements: DraftStatement[] = [];

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i] as Record<string, unknown>;

    // text validieren
    if (typeof stmt?.text !== "string") {
      throw new Error(`statements[${i}].text ist kein String.`);
    }
    const text = stmt.text.trim();
    if (text.length < MIN_STATEMENT_CHARS) {
      throw new Error(`statements[${i}].text ist leer.`);
    }
    if (text.length > MAX_STATEMENT_CHARS) {
      throw new Error(
        `statements[${i}].text ist zu lang (${text.length} Zeichen, max ${MAX_STATEMENT_CHARS}).`
      );
    }

    // sourceDocumentId validieren — MUSS eine der übergebenen IDs sein
    if (typeof stmt?.sourceDocumentId !== "string") {
      throw new Error(`statements[${i}].sourceDocumentId ist kein String.`);
    }
    const sourceDocumentId = stmt.sourceDocumentId.trim();
    if (!validDocIds.has(sourceDocumentId)) {
      throw new Error(
        `statements[${i}].sourceDocumentId "${sourceDocumentId}" ist keine gültige Dokument-ID ` +
        `dieser Sitzung. Erlaubte IDs: ${[...validDocIds].slice(0, 5).join(", ")}${validDocIds.size > 5 ? "…" : ""}`
      );
    }

    // sourceUrl serverseitig ableiten — NIEMALS aus dem Input übernehmen
    const srcDoc = docById.get(sourceDocumentId)!;
    const sourceUrl = resolveStableUrl(srcDoc, meetingSourceUrl);

    // position serverseitig nummerieren (1-basiert, sequenziell)
    validatedStatements.push({
      position: i + 1,
      text,
      sourceDocumentId,
      sourceUrl,
    });
  }

  return { title, statements: validatedStatements };
}

// ---------------------------------------------------------------------------
// parseAndValidateDraftJson — Hilfsfunktion für Skripte
// ---------------------------------------------------------------------------

/**
 * Parst einen JSON-String und validiert ihn über validateDraft.
 * Bereinigt optional Markdown-Code-Blöcke (```json ... ```).
 *
 * @throws Error bei ungültigem JSON oder Regelverletzung
 */
export function parseAndValidateDraftJson(
  jsonText: string,
  allowedDocs: DocumentInput[],
  meetingSourceUrl?: string
): ValidatedDraft {
  // Markdown-Codeblöcke entfernen falls vorhanden (defensiv)
  const cleaned = jsonText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Eingabe ist kein gültiges JSON. Rohantwort (gekürzt): ${jsonText.slice(0, 300)}`
    );
  }

  return validateDraft(parsed, allowedDocs, meetingSourceUrl);
}
