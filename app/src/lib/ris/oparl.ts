/**
 * oparl.ts — OParl-1.x-Adapter (Feature B, vorbereitet, umschaltbar je Gremium)
 *
 * OParl (https://oparl.org/) ist ein offener Standard für kommunale Ratsinformationssysteme.
 * Dieser Adapter unterstützt OParl 1.0 / 1.1 JSON-API.
 *
 * Konfiguration:
 *   bodyUrl   — OParl-Body-URL (kommt aus ris_bodies.base_url)
 *   fetchFn   — Injizierbar für Tests (kein Live-HTTP in Tests)
 *   maxPages  — Max. Seiten für Paginierung (Default: 2)
 *   since     — Optional: nur Meetings ab diesem Datum
 *
 * Robustheit:
 *   - Fehlende/null-Felder werden toleriert
 *   - deleted:true-Objekte werden übersprungen
 *   - HTTP-Fehler einzelner Dateien werden übersprungen (warn), kein Gesamtabbruch
 *
 * Dokument-Priorisierung (wie extractive_v1, ADR-009):
 *   vorlage > protokoll > top > tagesordnung > einladung > anlage
 *
 * M-1-Fix: fetchMeeting lädt über externalId (JSON-API-URL); sourceUrl bleibt menschenlesbare web-URL.
 * m-1-Fix: DocumentRef.sourceUrl = web ?? downloadUrl ?? accessUrl (stabile URL direkt persistieren).
 */

import { createHash } from "node:crypto";
import type { RisAdapter, MeetingRef, FetchedMeeting, DocumentRef, FetchFn } from "./types.js";
import { makeRisGetFn } from "./fetch-wrapper.js";
import { extractPdfText } from "./provox.js";

// ---------------------------------------------------------------------------
// OParl-Typen (vereinfacht)
// ---------------------------------------------------------------------------

interface OparlListEnvelope {
  data: unknown[];
  links?: {
    next?: string;
  };
}

interface OparlBody {
  id: string;
  meeting?: string | string[] | OparlListEnvelope;
}

interface OparlMeeting {
  id: string;
  type?: string;
  deleted?: boolean;
  name?: string;
  start?: string;
  location?: { description?: string } | null;
  web?: string;
  invitation?: string | OparlFile | null;
  resultsProtocol?: string | OparlFile | null;
  verbatimProtocol?: string | OparlFile | null;
  auxiliaryFile?: (string | OparlFile)[];
  agendaItem?: (string | OparlAgendaItem)[];
}

interface OparlAgendaItem {
  id?: string;
  deleted?: boolean;
  auxiliaryFile?: (string | OparlFile)[];
  consultation?: (string | OparlConsultation)[] | null;
}

interface OparlConsultation {
  id?: string;
  paper?: string | OparlPaper | null;
}

interface OparlPaper {
  id?: string;
  mainFile?: string | OparlFile | null;
}

interface OparlFile {
  id: string;
  type?: string;
  deleted?: boolean;
  mimeType?: string;
  accessUrl?: string;
  downloadUrl?: string;
  web?: string;
  name?: string;
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Adapter-Optionen
// ---------------------------------------------------------------------------

export interface OparlAdapterOptions {
  /** OParl-Body-URL (aus ris_bodies.base_url) */
  bodyUrl: string;
  /** Injizierbar für Tests */
  fetchFn?: FetchFn;
  /** Max. Seiten für Paginierung (Default: 5; per OPARL_MAX_PAGES-Env überschreibbar) */
  maxPages?: number;
  /** Optional: nur Meetings ab diesem Datum */
  since?: Date;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Lädt ein JSON-Objekt per GET. Wirft bei HTTP-Fehler.
 */
async function fetchJson<T>(
  url: string,
  fetchFn: ReturnType<typeof makeRisGetFn>
): Promise<T> {
  const resp = await fetchFn(url);
  const text = await resp.text();
  return JSON.parse(text) as T;
}

/**
 * Lädt ein OParl-Objekt (URL oder direkt eingebettetes Objekt).
 * Gibt null zurück wenn url leer/falsy.
 */
async function resolveOparlObject<T>(
  ref: string | T | null | undefined,
  fetchFn: ReturnType<typeof makeRisGetFn>
): Promise<T | null> {
  if (!ref) return null;
  if (typeof ref === "string") {
    try {
      return await fetchJson<T>(ref, fetchFn);
    } catch {
      return null;
    }
  }
  return ref as T;
}

/**
 * Gibt die stabile öffentliche URL für eine OParl-File zurück.
 * m-1: web ?? downloadUrl ?? accessUrl — wird direkt als DocumentRef.sourceUrl persistiert.
 * accessUrl bleibt für den tatsächlichen Datei-Download erhalten.
 */
function getStableFileUrl(file: OparlFile): string {
  return file.web ?? file.downloadUrl ?? file.accessUrl ?? file.id;
}

// ---------------------------------------------------------------------------
// OParl-Adapter
// ---------------------------------------------------------------------------

export class OparlAdapter implements RisAdapter {
  private readonly bodyUrl: string;
  private readonly fetchFn: ReturnType<typeof makeRisGetFn>;
  private readonly maxPages: number;
  private readonly since?: Date;

  constructor(opts: OparlAdapterOptions) {
    this.bodyUrl = opts.bodyUrl.replace(/\/$/, "");
    this.fetchFn = makeRisGetFn(opts.fetchFn as Parameters<typeof makeRisGetFn>[0]);
    // H-3: Default 5 (vorher 2 war zu knapp); per OPARL_MAX_PAGES überschreibbar
    this.maxPages = opts.maxPages ?? 5;
    this.since = opts.since;
  }

  /**
   * Lädt die Meeting-Liste aus dem OParl-Body.
   * Paginiert bis maxPages Seiten.
   * Gibt MeetingRef[] zurück.
   */
  async listRecentMeetings(): Promise<MeetingRef[]> {
    // Body laden um meeting-Listen-URL zu ermitteln
    let meetingListUrl: string;
    try {
      const body = await fetchJson<OparlBody>(this.bodyUrl, this.fetchFn);
      if (body.meeting) {
        if (typeof body.meeting === "string") {
          meetingListUrl = body.meeting;
        } else if (Array.isArray(body.meeting)) {
          // Direkt eingebettete IDs — kein separater Listen-Endpoint
          meetingListUrl = "";
        } else {
          // Eingebettetes Listen-Objekt
          meetingListUrl = "";
        }
      } else {
        // Fallback: {bodyUrl}/meeting (OParl-Konvention)
        meetingListUrl = `${this.bodyUrl}/meeting`;
      }
    } catch {
      // Fallback: Standard-URL
      meetingListUrl = `${this.bodyUrl}/meeting`;
    }

    const meetings: MeetingRef[] = [];
    let page = 0;
    let nextUrl: string | undefined = meetingListUrl || `${this.bodyUrl}/meeting`;

    while (nextUrl && page < this.maxPages) {
      let envelope: OparlListEnvelope;
      try {
        envelope = await fetchJson<OparlListEnvelope>(nextUrl, this.fetchFn);
      } catch (err) {
        console.warn(
          `[OparlAdapter] Fehler beim Laden der Meeting-Liste (Seite ${page + 1}): ` +
          `${err instanceof Error ? err.message : err}`
        );
        break;
      }

      const items = Array.isArray(envelope.data) ? envelope.data : [];
      for (const item of items) {
        const meeting = item as OparlMeeting;

        // deleted:true überspringen
        if (meeting.deleted === true) continue;

        // since-Filter
        if (this.since && meeting.start) {
          const meetingDate = new Date(meeting.start);
          if (meetingDate < this.since) continue;
        }

        meetings.push(mapMeetingRef(meeting));
      }

      nextUrl = envelope.links?.next;
      page++;
    }

    return meetings;
  }

  /**
   * Lädt ein Meeting-Objekt und sammelt alle Dokumente.
   * Maximal ~30 Dokumente pro Sitzung.
   * HTTP-Fehler einzelner Dateien werden übersprungen.
   *
   * M-1-Fix: JSON-API-URL aus externalId (= meeting.id) verwenden, NICHT sourceUrl
   * (sourceUrl = menschenlesbare web-Seite → HTML → JSON.parse würde explodieren).
   */
  async fetchMeeting(ref: MeetingRef): Promise<FetchedMeeting> {
    const meeting = await fetchJson<OparlMeeting>(ref.externalId, this.fetchFn);

    if (meeting.deleted === true) {
      // Gelöschtes Meeting — leere Dokument-Liste zurückgeben
      return { meeting: ref, documents: [] };
    }

    const documents: DocumentRef[] = [];
    const MAX_DOCS = 30;

    // Hilfsfunktion: Datei hinzufügen (mit PDF-Extraktion)
    const addFile = async (
      fileRef: string | OparlFile | null | undefined,
      docType: DocumentRef["docType"]
    ): Promise<void> => {
      if (documents.length >= MAX_DOCS) return;
      if (!fileRef) return;

      const file = await resolveOparlObject<OparlFile>(fileRef, this.fetchFn);
      if (!file) return;
      if (file.deleted === true) return;
      if (!file.accessUrl) return;

      // m-1-Fix: stabile URL (web ?? downloadUrl ?? accessUrl) direkt in sourceUrl
      // persistieren — accessUrl wird nur noch zum Herunterladen der Datei benutzt.
      // stableSourceUrl-Feld entfällt (kein toter Codepfad).
      const stableUrl = getStableFileUrl(file);
      const docRef: DocumentRef = {
        docType,
        externalId: file.id,
        title: file.name ?? file.fileName ?? undefined,
        sourceUrl: stableUrl,
      };

      // PDF-Textextraktion
      if (file.mimeType === "application/pdf" || file.accessUrl.toLowerCase().endsWith(".pdf")) {
        try {
          const pdfResp = await this.fetchFn(file.accessUrl);
          if (!pdfResp.ok) {
            throw new Error(`HTTP ${pdfResp.status} beim Laden von ${file.accessUrl}`);
          }
          const buffer = await pdfResp.arrayBuffer();
          const bodyText = await extractPdfText(buffer);
          const contentHash = bodyText ? sha256Hex(bodyText) : undefined;
          documents.push({ ...docRef, bodyText: bodyText ?? null, contentHash });
        } catch (err) {
          // HTTP-Fehler bei einzelner Datei → überspringen, warn
          console.warn(
            `[OparlAdapter] Fehler beim Laden von Datei ${file.id}: ` +
            `${err instanceof Error ? err.message : err}`
          );
          documents.push(docRef);
        }
      } else if (
        file.mimeType === "text/plain" ||
        file.accessUrl.toLowerCase().endsWith(".txt")
      ) {
        // Plaintext direkt laden
        try {
          const textResp = await this.fetchFn(file.accessUrl);
          if (!textResp.ok) {
            throw new Error(`HTTP ${textResp.status} beim Laden von ${file.accessUrl}`);
          }
          const bodyText = (await textResp.text()).trim() || null;
          const contentHash = bodyText ? sha256Hex(bodyText) : undefined;
          documents.push({ ...docRef, bodyText, contentHash });
        } catch (err) {
          console.warn(
            `[OparlAdapter] Fehler beim Laden von Text-Datei ${file.id}: ` +
            `${err instanceof Error ? err.message : err}`
          );
          documents.push(docRef);
        }
      } else {
        documents.push(docRef);
      }
    };

    // Dokumente sammeln (Priorität: vorlage > protokoll > top > einladung > anlage)

    // 1. Einladung
    await addFile(meeting.invitation, "einladung");

    // 2. Protokoll (resultsProtocol + verbatimProtocol)
    await addFile(meeting.resultsProtocol, "protokoll");
    await addFile(meeting.verbatimProtocol, "protokoll");

    // 3. Meeting-Anlagen
    if (Array.isArray(meeting.auxiliaryFile)) {
      for (const f of meeting.auxiliaryFile) {
        await addFile(f, "anlage");
      }
    }

    // 4. AgendaItem-Dokumente (TOP-Anlagen + Vorlagen via consultation→paper)
    if (Array.isArray(meeting.agendaItem)) {
      for (const itemRef of meeting.agendaItem) {
        if (documents.length >= MAX_DOCS) break;

        const item = await resolveOparlObject<OparlAgendaItem>(itemRef, this.fetchFn);
        if (!item) continue;
        if (item.deleted === true) continue;

        // Vorlagen via consultation→paper.mainFile
        if (Array.isArray(item.consultation)) {
          for (const consultRef of item.consultation) {
            if (documents.length >= MAX_DOCS) break;
            const consult = await resolveOparlObject<OparlConsultation>(consultRef, this.fetchFn);
            if (!consult?.paper) continue;
            const paper = await resolveOparlObject<OparlPaper>(consult.paper, this.fetchFn);
            if (paper?.mainFile) {
              await addFile(paper.mainFile, "vorlage");
            }
          }
        }

        // Anlagen des AgendaItems
        if (Array.isArray(item.auxiliaryFile)) {
          for (const f of item.auxiliaryFile) {
            await addFile(f, "anlage");
          }
        }
      }
    }

    // Meeting-Metadaten aus geladenen Daten aktualisieren
    const updatedRef = mapMeetingRef(meeting);

    return {
      meeting: {
        ...ref,
        gremium: updatedRef.gremium ?? ref.gremium,
        title: updatedRef.title ?? ref.title,
        meetingDate: updatedRef.meetingDate ?? ref.meetingDate,
        location: updatedRef.location ?? ref.location,
        sourceUrl: updatedRef.sourceUrl ?? ref.sourceUrl,
      },
      documents,
    };
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: OParl-Meeting → MeetingRef
// ---------------------------------------------------------------------------

function mapMeetingRef(meeting: OparlMeeting): MeetingRef {
  return {
    // externalId = JSON-API-URL (meeting.id) — wird von fetchMeeting zum Laden genutzt
    externalId: meeting.id,
    title: meeting.name ?? undefined,
    gremium: meeting.name ?? undefined,
    meetingDate: meeting.start ? new Date(meeting.start) : undefined,
    location: meeting.location?.description ?? undefined,
    // sourceUrl = menschenlesbare web-URL für Anzeige und Persistenz (NICHT für API-Zugriff)
    sourceUrl: meeting.web ?? meeting.id,
  };
}
