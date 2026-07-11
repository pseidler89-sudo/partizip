/**
 * provox.ts — RIS-Adapter für Rheingau-Taunus-Kreis (Provox IIP) (M7)
 *
 * Scraping-Strategie:
 *   - Sitzungsliste: GET /ris/rtk/meeting/list → HTML-Tabelle parsen
 *   - Sitzungsdetails: GET /ris/rtk/meeting/details/<id>
 *   - Dokument-Downloads: /ris/rtk/file/getfile/<id> → PDF → Textextraktion
 *
 * Alle Parse-Funktionen sind pure (testbar mit Fixtures).
 * Fetch ist injizierbar (Tests übergeben Stubs).
 *
 * Basis-URL: https://www.rheingau-taunus.de
 * Robots.txt: /typo3/ gesperrt, /ris/ frei.
 */

import { createHash } from "node:crypto";
import type { RisAdapter, MeetingRef, FetchedMeeting, DocumentRef, FetchFn } from "./types.js";
import { makeRisGetFn } from "./fetch-wrapper.js";
import { decodeHtmlEntities } from "../text/html-entities.js";

// ---------------------------------------------------------------------------
// HTML-Parsing-Hilfsfunktionen (pure, testbar ohne fetch)
// ---------------------------------------------------------------------------

/**
 * Extrahiert Meetings aus dem HTML der /meeting/list-Seite.
 * Parst beide Tabellen (kommende + letzte Sitzungen).
 */
export function parseMeetingList(html: string, baseUrl: string): MeetingRef[] {
  const meetings: MeetingRef[] = [];

  // Alle Zeilen mit Details-Links finden
  // Muster: <a href="/ris/rtk/meeting/details/NNNN">
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Details-Link extrahieren
    const detailsMatch = rowHtml.match(/href="(\/ris\/rtk\/meeting\/details\/(\d+))"/);
    if (!detailsMatch) continue;

    const detailsPath = detailsMatch[1];
    const externalId = detailsMatch[2];
    const sourceUrl = `${baseUrl}${detailsPath}`;

    // Zellen extrahieren (td-Inhalte)
    const cells: string[] = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      cells.push(stripHtml(cellMatch[1]).trim());
    }

    if (cells.length < 5) continue;

    // Spaltenreihenfolge: Typ | Nr | Datum | Zeit | Gremium | Ort | Links
    const datumStr = cells[2] ?? "";
    const zeitStr = cells[3] ?? "";
    const gremium = cells[4] ?? "";
    const ort = cells[5] ?? "";

    const meetingDate = parseDeutschesDatum(datumStr, zeitStr);

    meetings.push({
      externalId,
      gremium: gremium || undefined,
      title: gremium || undefined,
      meetingDate: meetingDate ?? undefined,
      location: ort || undefined,
      sourceUrl,
    });
  }

  return meetings;
}

/**
 * Extrahiert Metadaten und Dokument-Links aus einer Sitzungsdetail-Seite.
 * Gibt Meeting-Metadaten und Liste aller Dokument-Refs zurück (ohne PDF-Text).
 */
export function parseMeetingDetail(
  html: string,
  baseUrl: string,
  meetingId: string
): { meta: Partial<MeetingRef>; documents: DocumentRef[] } {
  const documents: DocumentRef[] = [];

  // Gremium (h4)
  const gremiumMatch = html.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
  const gremium = gremiumMatch ? stripHtml(gremiumMatch[1]).trim() : undefined;

  // Ort (h5 mit "Sitzungsort:")
  const ortMatch = html.match(/Sitzungsort:\s*([\s\S]*?)<\/h5>/i);
  const location = ortMatch ? stripHtml(ortMatch[1]).trim() : undefined;

  // Datum + Zeit
  let meetingDate: Date | undefined;
  const datumMatch = html.match(/(\d{2}\.\s*\w+\s*\d{4})/);
  const zeitMatch = html.match(/Von\s+(\d{2}:\d{2})/i);
  if (datumMatch) {
    meetingDate = parseDeutschesLangdatum(datumMatch[1], zeitMatch?.[1]) ?? undefined;
  }

  // Sitzungsdateien (Einladung, Protokoll) — aria-label oder title enthält den Dokumenttyp
  // Format (aria-label vor href): <a aria-label="Öffentliche Einladung" target="_blank" href="/ris/rtk/file/getfile/52402">
  // Format (title nach href):     <a href="/ris/rtk/file/getfile/52402" title="Öffentliche Einladung, ...">Einladung</a>
  //
  // Regex matcht den kompletten <a ...> Tag, dann extrahieren wir href/aria-label daraus
  const sitzLinkPattern = /<a([^>]+href="(\/ris\/rtk\/file\/getfile\/(\d+))"[^>]*)>/gi;
  const seenFileIds = new Set<string>();
  let gfMatch: RegExpExecArray | null;

  // Sitzungsdateien-Sektion: alles bis zur ersten Tagesordnungs-Tabelle
  const sitzSectionEnd = html.search(/<table[^>]*class="[^"]*table[^"]*"/i);
  const sitzSection = sitzSectionEnd > 0 ? html.slice(0, sitzSectionEnd) : html;

  while ((gfMatch = sitzLinkPattern.exec(sitzSection)) !== null) {
    const fullAttrs = gfMatch[1]; // alle Attribute des <a>-Tags
    const filePath = gfMatch[2];
    const fileId = gfMatch[3];
    if (seenFileIds.has(fileId)) continue;
    seenFileIds.add(fileId);

    const sourceUrl = `${baseUrl}${filePath}`;

    // aria-label für Dokumenttyp nutzen (kann vor oder nach href stehen)
    const ariaMatch = fullAttrs.match(/aria-label="([^"]*)"/i);
    let labelRaw = ariaMatch?.[1] ?? "";

    // Fallback: title-Attribut im <a>-Tag selbst
    // N5: title im <a> kann Dateigröße enthalten — nur nutzen wenn kein aria-label
    if (!labelRaw) {
      const titleAttrMatch = fullAttrs.match(/title="([^"]*)"/i);
      const candidate = titleAttrMatch?.[1] ?? "";
      // Keine Dateigröße-Angaben als Titel akzeptieren
      if (candidate && !/^Dateigr[öo]|^\d+\s*kB|^\d+\s*MB/i.test(candidate)) {
        labelRaw = candidate;
      }
    }

    // Fallback: Text-Inhalt zwischen <a>...</a> (plain-text links wie "Einladung")
    if (!labelRaw) {
      const afterOpenTag = html.slice(gfMatch.index + gfMatch[0].length, gfMatch.index + gfMatch[0].length + 200);
      const textMatch = afterOpenTag.match(/^([^<]*)</);
      labelRaw = textMatch?.[1]?.trim() ?? "";
    }

    // HTML-Entities dekodieren (&#xD6; → Ö, &#246; → ö, etc.)
    const labelDecoded = decodeHtmlEntities(labelRaw).toLowerCase();

    // N5: Dokument-Titel = aria-label/Linktext, NICHT span-title (der enthält Dateigröße)
    // decodeHtmlEntities für sauberen Titel
    const docTitle = labelRaw ? decodeHtmlEntities(labelRaw) : undefined;

    let docType: DocumentRef["docType"] = "anlage";
    if (labelDecoded.includes("einladung")) docType = "einladung";
    else if (labelDecoded.includes("protokoll") || labelDecoded.includes("niederschrift")) docType = "protokoll";

    documents.push({
      docType,
      externalId: fileId,
      title: docTitle ?? undefined,
      sourceUrl,
    });
  }

  // Tagesordnungs-Zeilen mit getfile-Links (ab erster Tabelle)
  const topRowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  // Nur Tabellen-Teil parsen
  const tableSection = sitzSectionEnd > 0 ? html.slice(sitzSectionEnd) : "";
  topRowPattern.lastIndex = 0;

  while ((rowMatch = topRowPattern.exec(tableSection)) !== null) {
    const rowHtml = rowMatch[1];
    if (!rowHtml.includes("/file/getfile/")) continue;

    const cells: string[] = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }

    const topNum = cells[0] ? stripHtml(cells[0]).trim() : undefined;
    const topBetreff = cells[1] ? stripHtml(cells[1]).trim() : undefined;
    const vorlageNum = cells[3] ? stripHtml(cells[3]).trim() : undefined;

    // getfile-Links in den Zellen
    const getfileLinkPattern = /<a[^>]+href="(\/ris\/rtk\/file\/getfile\/(\d+))"[^>]*>/gi;
    let glMatch: RegExpExecArray | null;
    let fileCount = 0;

    while ((glMatch = getfileLinkPattern.exec(rowHtml)) !== null) {
      const filePath = glMatch[1];
      const fileId = glMatch[2];
      if (seenFileIds.has(fileId)) { fileCount++; continue; }
      seenFileIds.add(fileId);
      const sourceUrl = `${baseUrl}${filePath}`;

      // Ersten Link als Vorlage, weitere als Anlagen
      const docType: DocumentRef["docType"] = fileCount === 0 && vorlageNum ? "vorlage" : "anlage";
      const title = vorlageNum
        ? `${topNum ? `TOP ${topNum}: ` : ""}${topBetreff ?? ""} (${vorlageNum})`
        : `${topNum ? `TOP ${topNum}: ` : ""}${topBetreff ?? ""}`;

      documents.push({
        docType,
        externalId: fileId,
        title: title.trim() || undefined,
        sourceUrl,
      });
      fileCount++;
    }
  }

  return {
    meta: {
      gremium,
      title: gremium,
      meetingDate,
      location,
      externalId: meetingId,
    },
    documents,
  };
}

// ---------------------------------------------------------------------------
// PDF-Textextraktion
// ---------------------------------------------------------------------------

/**
 * Extrahiert Text aus einem PDF-Buffer.
 * Gibt null zurück bei Fehler (kein Scan-PDF, leeres Dokument etc.).
 */
export async function extractPdfText(buffer: ArrayBuffer): Promise<string | null> {
  try {
    // Dynamischer Import — direkt aus lib/pdf-parse.js um zu vermeiden, dass der
    // pdf-parse@1.1.1-Index beim Import Testdateien sucht und fehlschlägt.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfModule = (await import("pdf-parse/lib/pdf-parse.js")) as any;
    // pdf-parse v1: Default-Export ist die Funktion
    const pdfParse: (buf: Buffer, opts?: object) => Promise<{ text: string }> =
      typeof pdfModule === "function"
        ? pdfModule
        : typeof pdfModule.default === "function"
        ? pdfModule.default
        : pdfModule;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await (pdfParse as any)(Buffer.from(buffer));
    return data.text?.trim() || null;
  } catch {
    // pdf-parse-Import fehlgeschlagen oder PDF unlesbar → null zurückgeben
    return null;
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Datum-Parsing
// ---------------------------------------------------------------------------

/** Parst "DD.MM.YYYY" und optionale Zeit "HH:MM" */
function parseDeutschesDatum(datum: string, zeit?: string): Date | null {
  const match = datum.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  const [h, min] = (zeit ?? "00:00").split(":").map(Number);
  return new Date(`${y}-${String(+m).padStart(2, "0")}-${String(+d).padStart(2, "0")}T${String(h ?? 0).padStart(2, "0")}:${String(min ?? 0).padStart(2, "0")}:00+01:00`);
}

/** Parst "Montag, 12. Mai 2026" (deutsches Langdatum) */
function parseDeutschesLangdatum(datum: string, zeit?: string): Date | null {
  const monate: Record<string, string> = {
    januar: "01", februar: "02", märz: "03", april: "04",
    mai: "05", juni: "06", juli: "07", august: "08",
    september: "09", oktober: "10", november: "11", dezember: "12",
  };
  const clean = datum.replace(/\s+/g, " ").trim().toLowerCase();
  const match = clean.match(/(\d{1,2})\.\s*(\w+)\s*(\d{4})/);
  if (!match) return null;
  const [, d, monName, y] = match;
  const m = monate[monName];
  if (!m) return null;
  const [h, min] = (zeit ?? "00:00").split(":").map(Number);
  return new Date(`${y}-${m}-${String(+d).padStart(2, "0")}T${String(h ?? 0).padStart(2, "0")}:${String(min ?? 0).padStart(2, "0")}:00+01:00`);
}

/** Entfernt HTML-Tags und dekodiert Entities */
function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Provox-Adapter
// ---------------------------------------------------------------------------

export interface ProvoxAdapterOptions {
  baseUrl: string;
  /** Injizierbar für Tests */
  fetchFn?: FetchFn;
  /** PDF-Download aktivieren (default: true) */
  downloadPdfs?: boolean;
}

export class ProvoxAdapter implements RisAdapter {
  private readonly baseUrl: string;
  private readonly fetchFn: ReturnType<typeof makeRisGetFn>;
  private readonly downloadPdfs: boolean;

  constructor(opts: ProvoxAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchFn = makeRisGetFn(opts.fetchFn as Parameters<typeof makeRisGetFn>[0]);
    this.downloadPdfs = opts.downloadPdfs ?? true;
  }

  async listRecentMeetings(): Promise<MeetingRef[]> {
    const url = `${this.baseUrl}/ris/rtk/meeting/list`;
    const resp = await this.fetchFn(url);
    const html = await resp.text();
    return parseMeetingList(html, this.baseUrl);
  }

  async fetchMeeting(ref: MeetingRef): Promise<FetchedMeeting> {
    const resp = await this.fetchFn(ref.sourceUrl);
    const html = await resp.text();

    const { meta, documents } = parseMeetingDetail(html, this.baseUrl, ref.externalId);

    const enrichedDocs: DocumentRef[] = [];

    for (const doc of documents) {
      if (this.downloadPdfs && doc.sourceUrl.includes("/file/getfile/")) {
        try {
          const pdfResp = await this.fetchFn(doc.sourceUrl);
          const buffer = await pdfResp.arrayBuffer();
          const bodyText = await extractPdfText(buffer);
          const contentHash = bodyText ? sha256Hex(bodyText) : undefined;
          enrichedDocs.push({ ...doc, bodyText, contentHash });
        } catch {
          // PDF-Download fehlgeschlagen → ohne Text weiterführen
          enrichedDocs.push(doc);
        }
      } else {
        enrichedDocs.push(doc);
      }
    }

    const meeting: MeetingRef = {
      ...ref,
      gremium: meta.gremium ?? ref.gremium,
      title: meta.title ?? ref.title,
      meetingDate: meta.meetingDate ?? ref.meetingDate,
      location: meta.location ?? ref.location,
    };

    return { meeting, documents: enrichedDocs };
  }
}
