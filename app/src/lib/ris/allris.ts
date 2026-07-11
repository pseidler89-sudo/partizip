/**
 * allris.ts — RIS-Adapter für Stadt Taunusstein (ALLRIS net 4) (M7)
 *
 * EINSCHRÄNKUNG: ALLRIS-Listenseiten sind Wicket-Formulare → keine Discovery per API.
 * listRecentMeetings() liest bekannte SILFDNRs aus der Datenbank (manuell erfasst
 * via ris-add-meeting.ts CLI oder importiert).
 *
 * Scraping-Strategie:
 *   - Sitzungsdetails: GET /allris/to010?SILFDNR=<id>&TOLFDNR=... (TO + Dokumente)
 *   - TOP-Details:     GET /allris/to020?TOLFDNR=<id> (Beschlusstext + Abstimmung)
 *   - PDF-Links:       Sitzungsbezogen frisch auflösen (doc-IDs instabil!)
 *
 * Robots.txt: /allris/___tmp/ gesperrt; relevante Pfade frei.
 */

import { createHash } from "node:crypto";
import type { RisAdapter, MeetingRef, FetchedMeeting, DocumentRef, FetchFn } from "./types.js";
import { makeRisGetFn } from "./fetch-wrapper.js";
import { extractPdfText } from "./provox.js";

// ---------------------------------------------------------------------------
// HTML-Parsing-Hilfsfunktionen (pure, testbar ohne fetch)
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Parst die to010-Seite (Sitzung/Tagesordnung).
 * Extrahiert: Gremium, Datum, Ort, Sitzungsnummer, Dokumente, TOP-Links.
 */
export function parseTo010(
  html: string,
  baseUrl: string,
  silfdnr: string
): { meta: Partial<MeetingRef>; documents: DocumentRef[] } {
  const documents: DocumentRef[] = [];

  // Gremium (h1)
  const gremiumMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const gremium = gremiumMatch ? stripHtml(gremiumMatch[1]).trim() : undefined;

  // Datum
  let meetingDate: Date | undefined;
  const datumMatch = html.match(/(\d{2}\.\d{2}\.\d{4})/);
  if (datumMatch) {
    const zeitMatch = html.match(/(\d{2}:\d{2})\s*Uhr/);
    meetingDate = parseDeutschesDatum(datumMatch[1], zeitMatch?.[1]) ?? undefined;
  }

  // Ort
  const ortMatch = html.match(/Ort:<\/td>\s*<td[^>]*>([^<]+)/i);
  const location = ortMatch ? ortMatch[1].trim() : undefined;

  // Sitzungsdokumente (PDF-Links)
  // M1(b): Wicket-doc-IDs (doc<N>.pdf) sind INSTABIL → stable external_id aus docType+normalisiertem Label
  // Die Wicket-URL wird in source_url gespeichert und IMMER aktualisiert (UPDATE-Pfad in upsertDocument).
  const pdfLinkPattern = /<a\s+href="(\/allris\/wicket\/resource\/org\.apache\.wicket\.Application\/(doc\d+\.pdf))"[^>]*>([^<]*)<\/a>/gi;
  let pdfMatch: RegExpExecArray | null;
  const seenDocTypes = new Set<string>();

  while ((pdfMatch = pdfLinkPattern.exec(html)) !== null) {
    const pdfPath = pdfMatch[1];
    const linkText = pdfMatch[3].trim();
    const linkLower = linkText.toLowerCase();
    const sourceUrl = `${baseUrl}${pdfPath}`;

    let docType: DocumentRef["docType"] = "anlage";
    if (linkLower.includes("einladung")) docType = "einladung";
    else if (linkLower.includes("niederschrift") || linkLower.includes("protokoll")) docType = "protokoll";

    // Stabiler natürlicher Key: docType + normalisiertes Label
    // Bsp: 'protokoll:oeffentlich', 'einladung:oeffentlich'
    const normalLabel = linkText
      .toLowerCase()
      .replace(/ö/g, "oe").replace(/ä/g, "ae").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      || docType;
    const stableId = `${docType}:${normalLabel}`;

    if (seenDocTypes.has(stableId)) continue;
    seenDocTypes.add(stableId);

    // M1(c): Stabile Seiten-URL für Digest-Statements (Wicket-URL ist instabil)
    const stableSourceUrl = `${baseUrl}/allris/to010?SILFDNR=${silfdnr}`;

    documents.push({ docType, externalId: stableId, title: linkText || undefined, sourceUrl, stableSourceUrl });
  }

  // TO-Links (to020?TOLFDNR=...) — TOPs mit Beschlüssen
  const topLinkPattern = /<a\s+href="(\/allris\/to020\?TOLFDNR=(\d+))"[^>]*>/gi;
  let topMatch: RegExpExecArray | null;

  while ((topMatch = topLinkPattern.exec(html)) !== null) {
    const topPath = topMatch[1];
    const tolfdnr = topMatch[2];
    const sourceUrl = `${baseUrl}${topPath}`;

    // Gehe in den Kontext dieser Zeile für Bezeichnung
    const rowStart = Math.max(0, topMatch.index - 500);
    const rowContext = html.slice(rowStart, topMatch.index + 200);
    const topNumMatch = rowContext.match(/<td[^>]*>\s*(\d+)\s*<\/td>/);
    const topTitle = topNumMatch ? `TOP ${topNumMatch[1]}` : `TOP (TOLFDNR ${tolfdnr})`;

    documents.push({
      docType: "top",
      externalId: tolfdnr,
      title: topTitle,
      sourceUrl,
    });
  }

  // Vorlagen-Links (vo020?VOLFDNR=...)
  const vorlageLinkPattern = /<a\s+href="(\/allris\/vo020\?VOLFDNR=(\d+))"[^>]*>([^<]*)<\/a>/gi;
  let vorlageMatch: RegExpExecArray | null;

  while ((vorlageMatch = vorlageLinkPattern.exec(html)) !== null) {
    const vorlagePath = vorlageMatch[1];
    const volfdnr = vorlageMatch[2];
    const title = vorlageMatch[3].trim();
    const sourceUrl = `${baseUrl}${vorlagePath}`;

    documents.push({
      docType: "vorlage",
      externalId: volfdnr,
      title: title || `Vorlage VOLFDNR ${volfdnr}`,
      sourceUrl,
    });
  }

  return {
    meta: {
      externalId: silfdnr,
      gremium,
      title: gremium,
      meetingDate,
      location,
      sourceUrl: `${baseUrl}/allris/to010?SILFDNR=${silfdnr}`,
    },
    documents,
  };
}

/**
 * Parst die to020-Seite (TOP-Details mit Beschluss und Abstimmung).
 * Extrahiert: Beschlusstext, Abstimmungsergebnis.
 */
export function parseTo020(html: string): { beschluss?: string; abstimmung?: string } {
  // Beschlusstext
  const beschlussMatch = html.match(/<h3[^>]*>Beschlusstext<\/h3>([\s\S]*?)(?=<h3|<div class="anlagen|$)/i);
  const beschluss = beschlussMatch ? stripHtml(beschlussMatch[1]).trim() : undefined;

  // Abstimmungsergebnis
  const abstimmungParts: string[] = [];
  const jaMatch = html.match(/Ja-Stimmen:<\/td>\s*<td[^>]*>(\d+)/i);
  const neinMatch = html.match(/Nein-Stimmen:<\/td>\s*<td[^>]*>(\d+)/i);
  const entMatch = html.match(/Enthaltungen:<\/td>\s*<td[^>]*>(\d+)/i);
  const ergebMatch = html.match(/Ergebnis:<\/td>\s*<td[^>]*>([^<]+)/i);

  if (jaMatch) abstimmungParts.push(`Ja: ${jaMatch[1]}`);
  if (neinMatch) abstimmungParts.push(`Nein: ${neinMatch[1]}`);
  if (entMatch) abstimmungParts.push(`Enthaltungen: ${entMatch[1]}`);
  if (ergebMatch) abstimmungParts.push(`Ergebnis: ${ergebMatch[1].trim()}`);

  const abstimmung = abstimmungParts.length > 0 ? abstimmungParts.join(", ") : undefined;

  return { beschluss, abstimmung };
}

// ---------------------------------------------------------------------------
// Datum-Parsing
// ---------------------------------------------------------------------------

function parseDeutschesDatum(datum: string, zeit?: string): Date | null {
  const match = datum.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  const [h, min] = (zeit ?? "00:00").split(":").map(Number);
  return new Date(`${y}-${String(+m).padStart(2, "0")}-${String(+d).padStart(2, "0")}T${String(h ?? 0).padStart(2, "0")}:${String(min ?? 0).padStart(2, "0")}:00+01:00`);
}

// ---------------------------------------------------------------------------
// ALLRIS-Adapter
// ---------------------------------------------------------------------------

export interface AllrisAdapterOptions {
  baseUrl: string;
  /** Liste bekannter SILFDNRs (aus DB, via ris-add-meeting CLI erfasst) */
  knownSilfdnrs: string[];
  /** Injizierbar für Tests */
  fetchFn?: FetchFn;
  /** PDF-Download aktivieren (default: true) */
  downloadPdfs?: boolean;
}

export class AllrisAdapter implements RisAdapter {
  private readonly baseUrl: string;
  private readonly knownSilfdnrs: string[];
  private readonly fetchFn: ReturnType<typeof makeRisGetFn>;
  private readonly downloadPdfs: boolean;

  constructor(opts: AllrisAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.knownSilfdnrs = opts.knownSilfdnrs;
    this.fetchFn = makeRisGetFn(opts.fetchFn as Parameters<typeof makeRisGetFn>[0]);
    this.downloadPdfs = opts.downloadPdfs ?? true;
  }

  /**
   * EINSCHRÄNKUNG: ALLRIS-Listenseiten benötigen Formular-Submits.
   * listRecentMeetings() gibt nur die manuell erfassten SILFDNRs zurück,
   * angereichert mit Metadaten von der to010-Seite.
   *
   * Für eine vollständige Discovery: Stadt Taunusstein um OParl-Aktivierung bitten
   * (ALLRIS net hat OParl als Modul; ist in Taunusstein nur nicht aktiviert).
   */
  async listRecentMeetings(): Promise<MeetingRef[]> {
    if (this.knownSilfdnrs.length === 0) {
      console.warn(
        "[AllrisAdapter] Keine SILFDNRs konfiguriert. " +
        "Nutze 'npm run ris:add-meeting -- --body taunusstein-stadt --silfdnr <ID>' " +
        "um Sitzungen manuell zu erfassen."
      );
      return [];
    }

    const refs: MeetingRef[] = [];
    for (const silfdnr of this.knownSilfdnrs) {
      refs.push({
        externalId: silfdnr,
        sourceUrl: `${this.baseUrl}/allris/to010?SILFDNR=${silfdnr}`,
      });
    }
    return refs;
  }

  async fetchMeeting(ref: MeetingRef): Promise<FetchedMeeting> {
    // Sitzungsseite laden
    const resp = await this.fetchFn(ref.sourceUrl);
    const html = await resp.text();

    const { meta, documents: rawDocs } = parseTo010(html, this.baseUrl, ref.externalId);

    const enrichedDocs: DocumentRef[] = [];

    for (const doc of rawDocs) {
      if (doc.docType === "top") {
        // to020-Seite laden für Beschlusstext
        try {
          const topResp = await this.fetchFn(doc.sourceUrl);
          const topHtml = await topResp.text();
          const { beschluss, abstimmung } = parseTo020(topHtml);
          let bodyText: string | null = null;
          if (beschluss) {
            bodyText = beschluss;
            if (abstimmung) bodyText += `\nAbstimmung: ${abstimmung}`;
          }
          const contentHash = bodyText ? sha256Hex(bodyText) : undefined;
          enrichedDocs.push({ ...doc, bodyText, contentHash });
        } catch {
          enrichedDocs.push(doc);
        }
      } else if (
        this.downloadPdfs &&
        (doc.sourceUrl.includes("/wicket/resource/") || doc.sourceUrl.includes("/vo020"))
      ) {
        // PDF laden + Text extrahieren
        // ACHTUNG: doc-IDs bei ALLRIS instabil → immer frisch von Detailseite
        try {
          const pdfResp = await this.fetchFn(doc.sourceUrl);
          const buffer = await pdfResp.arrayBuffer();
          const bodyText = await extractPdfText(buffer);
          const contentHash = bodyText ? sha256Hex(bodyText) : undefined;
          enrichedDocs.push({ ...doc, bodyText, contentHash });
        } catch {
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
      sourceUrl: meta.sourceUrl ?? ref.sourceUrl,
    };

    return { meeting, documents: enrichedDocs };
  }
}
