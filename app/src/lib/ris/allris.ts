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
 *
 * WICHTIG — Fixtures: `__fixtures__/allris-to010-real.html` und
 * `allris-to020-real.html` sind UNVERÄNDERTE, live gezogene Seiten von
 * www.taunusstein.de. Sie dürfen nicht „aufgeräumt" werden. Die Vorgänger-
 * Fixtures waren handgeschriebenes Wunsch-HTML — dadurch waren die Tests grün,
 * während der Adapter in der Realität weder Datum noch Dokumente fand.
 * Neue Fixtures deshalb IMMER per Download der echten Seite erzeugen.
 */

import { createHash } from "node:crypto";
import type { RisAdapter, MeetingRef, FetchedMeeting, DocumentRef, FetchFn } from "./types.js";
import { makeRisGetFn } from "./fetch-wrapper.js";
import { extractPdfText } from "./provox.js";

// ---------------------------------------------------------------------------
// HTML-Parsing-Hilfsfunktionen (pure, testbar ohne fetch)
// ---------------------------------------------------------------------------

/**
 * Dekodiert HTML-Entities. `&amp;` MUSS zuletzt ersetzt werden, sonst wird
 * `&amp;lt;` fälschlich zu `<` statt zu `&lt;`.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeFromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeFromCodePoint(Number(n)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Tags entfernen, Entities dekodieren, Whitespace (inkl. NBSP) zu einem Space. */
function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * HTML → zeilenweiser Text. Blockenden werden zu Zeilenumbrüchen, Tabellenzellen
 * zu Leerzeichen. Nötig für die Word-/Aspose-Exporte in to020 (Beschlusstext als
 * verschachtelte <p>/<li>/<td>-Struktur).
 */
function htmlToText(html: string): string {
  // Zeilenumbrüche kommen NUR aus Block-Tags. Die Umbrüche der Quelle selbst sind
  // reine Einrückung (der Word-Export bricht mitten in <span> um) und dürfen nicht
  // als Absatzgrenze zählen → Sentinel statt "\n".
  const BREAK = "\u0000";
  // Tabellenzeilen bleiben EINE Zeile ("Abstimmung: Dafür: 25 Dagegen: 8 …") —
  // sonst zerfällt die Stimmen-Tabelle in Label- und Wert-Zeilen und nachgelagerte
  // Auswertungen (Digest) lesen nur das Label.
  const tablesFlattened = html.replace(/<table[\s\S]*?<\/table>/gi, (table) =>
    table.replace(/<\/(p|div|ol|ul|li|h[1-6])\s*>/gi, " ")
  );
  const withBreaks = tablesFlattened
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, BREAK)
    .replace(/<\/(p|li|tr|div|h[1-6]|dl|dd|table|ol|ul)\s*>/gi, BREAK)
    .replace(/<[^>]*>/g, " ")
    .replace(/<[^>]*$/, " "); // abgeschnittenes Tag am Abschnittsende

  return decodeEntities(withBreaks)
    .split(BREAK)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Löst einen href gegen die Basis-URL auf. ALLRIS 4 liefert ABSOLUTE hrefs
 * (`https://www.taunusstein.de/allris/to020?...`); ältere/andere Installationen
 * liefern relative. Beides muss funktionieren.
 * Entities (`&amp;`) werden dekodiert — sonst gehen Folge-Fetches mit literalem
 * `&amp;` in der Query raus.
 */
function resolveUrl(href: string, baseUrl: string): string | null {
  const decoded = decodeEntities(href).trim();
  if (!decoded || decoded.startsWith("#") || /^(javascript|mailto):/i.test(decoded)) return null;
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * `<base href="…">` der Seite (ALLRIS setzt `…/allris/`). Ohne base-Tag gilt die
 * ALLRIS-Konvention `<baseUrl>/allris/`, damit auch dokument-relative hrefs
 * (`to020?TOLFDNR=…`) korrekt auflösen.
 */
function resolveBaseHref(html: string, baseUrl: string): string {
  const fallback = `${baseUrl.replace(/\/$/, "")}/allris/`;
  const match = html.match(/<base[^>]+href="([^"]*)"/i);
  if (!match) return fallback;
  try {
    return new URL(decodeEntities(match[1]), fallback).toString();
  } catch {
    return fallback;
  }
}

/**
 * Liest ein Feld aus dem ALLRIS-„Grunddaten"-Block. Struktur:
 *   <dt class="colTitle"><span class="label">Datum:</span></dt>
 *   <dd class="colEntry"><span class="text4" id="sidatum">…Mi., 05.04.2017…</span></dd>
 *
 * LABEL-basiert, NICHT positionsbasiert: die Reihenfolge der Felder ist je nach
 * Sitzungsart unterschiedlich, und ein dokumentweiter Regex-Scan trifft
 * zuverlässig den falschen Treffer (z. B. die ALLRIS-Versionszeile im <head>).
 */
function extractGrunddatum(html: string, label: string): string | undefined {
  const pattern = new RegExp(
    `<span[^>]*class="[^"]*\\blabel\\b[^"]*"[^>]*>\\s*${escapeRegExp(label)}\\s*:?\\s*</span>` +
      `[\\s\\S]{0,120}?<dd[^>]*>([\\s\\S]*?)</dd>`,
    "i"
  );
  const match = html.match(pattern);
  if (!match) return undefined;
  const value = stripHtml(match[1]);
  return value.length > 0 ? value : undefined;
}

/** Erstes Grunddaten-Feld, das einen Wert liefert. */
function extractFirstGrunddatum(html: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const value = extractGrunddatum(html, label);
    if (value) return value;
  }
  return undefined;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Parst die to010-Seite (Sitzung/Tagesordnung).
 * Extrahiert: Gremium, Betreff, Datum/Uhrzeit, Ort, Dokumente, TOP-/Vorlagen-Links.
 */
export function parseTo010(
  html: string,
  baseUrl: string,
  silfdnr: string
): { meta: Partial<MeetingRef>; documents: DocumentRef[] } {
  const documents: DocumentRef[] = [];
  const pageBase = resolveBaseHref(html, baseUrl);
  const links = matchLinks(html);

  // Kopfzeile "<Gremium> - <Datum>" als Fallback, falls die Grunddaten fehlen.
  // NICHT das erste <h1> nehmen: das ist der Seitenkopf ("Stadt Taunusstein").
  const headline = extractHeadline(html);

  // Gremium / Betreff — label-basiert aus den Grunddaten
  const gremium = extractGrunddatum(html, "Gremium") ?? headline?.gremium;
  const betreff = extractGrunddatum(html, "Betreff");

  // Datum + Uhrzeit — label-basiert. Der Wert trägt einen Wochentag-Präfix
  // ("Mi., 05.04.2017"); die Uhrzeit steht ohne "Uhr" im eigenen Feld.
  const datumRaw = extractGrunddatum(html, "Datum") ?? headline?.datum;
  const zeitRaw = extractGrunddatum(html, "Uhrzeit");
  const datum = datumRaw?.match(/(\d{1,2}\.\d{1,2}\.\d{4})/)?.[1];
  const zeit = zeitRaw?.match(/(\d{1,2}:\d{2})/)?.[1];
  const meetingDate = datum ? (parseDeutschesDatum(datum, zeit) ?? undefined) : undefined;

  // Ort — auf den Taunusstein-Seiten NICHT vorhanden (kein Ort-/Raum-/Saal-Feld).
  // Labels trotzdem prüfen, damit andere ALLRIS-Installationen bedient werden;
  // wenn nichts da ist, bleibt location bewusst undefined (nichts erfinden).
  const location = extractFirstGrunddatum(html, ["Ort", "Raum", "Sitzungsort", "Sitzungsraum"]);

  // Sitzungsdokumente (PDF-Links)
  // M1(b): Wicket-doc-IDs (doc<N>.pdf) sind INSTABIL → stable external_id aus docType+normalisiertem Label
  // Die Wicket-URL wird in source_url gespeichert und IMMER aktualisiert (UPDATE-Pfad in upsertDocument).
  const stableSourceUrl =
    resolveUrl(`to010?SILFDNR=${encodeURIComponent(silfdnr)}`, pageBase) ??
    `${baseUrl.replace(/\/$/, "")}/allris/to010?SILFDNR=${silfdnr}`;

  const seenDocTypes = new Set<string>();
  for (const link of links) {
    if (!/\/wicket\/resource\/org\.apache\.wicket\.Application\/doc\d+\.pdf/i.test(link.href)) continue;
    const sourceUrl = resolveUrl(link.href, pageBase);
    if (!sourceUrl) continue;

    const linkText = link.text;
    const linkLower = linkText.toLowerCase();

    let docType: DocumentRef["docType"] = "anlage";
    if (linkLower.includes("einladung")) docType = "einladung";
    else if (linkLower.includes("niederschrift") || linkLower.includes("protokoll")) docType = "protokoll";

    // Stabiler natürlicher Key: docType + normalisiertes Label
    // Bsp: 'protokoll:niederschrift_oeffentlich', 'einladung:einladung'
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
    documents.push({ docType, externalId: stableId, title: linkText || undefined, sourceUrl, stableSourceUrl });
  }

  // TO-Links (to020?TOLFDNR=…) — TOPs mit Beschlüssen
  const seenTops = new Set<string>();
  for (const link of links) {
    if (!/(?:^|\/)to020\?/i.test(link.href)) continue;
    const sourceUrl = resolveUrl(link.href, pageBase);
    if (!sourceUrl) continue;
    const tolfdnr = new URL(sourceUrl).searchParams.get("TOLFDNR");
    if (!tolfdnr || seenTops.has(tolfdnr)) continue;
    seenTops.add(tolfdnr);

    // TOP-Nummer steht in derselben Zeile in <td class="tonr"> und ist über
    // dieselbe TOLFDNR verankert (id="link_<TOLFDNR>") — kein Positionsraten.
    const nummer = extractTopNummer(html, tolfdnr);
    const betreffText = link.text;
    let topTitle: string;
    if (nummer && betreffText) topTitle = `TOP ${nummer} – ${betreffText}`;
    else if (nummer) topTitle = `TOP ${nummer}`;
    else if (betreffText) topTitle = betreffText;
    else topTitle = `TOP (TOLFDNR ${tolfdnr})`;

    documents.push({
      docType: "top",
      externalId: tolfdnr,
      title: topTitle,
      sourceUrl,
      stableSourceUrl: sourceUrl,
    });
  }

  // Vorlagen-Links (vo020?VOLFDNR=…)
  const seenVorlagen = new Set<string>();
  for (const link of links) {
    if (!/(?:^|\/)vo020\?/i.test(link.href)) continue;
    const sourceUrl = resolveUrl(link.href, pageBase);
    if (!sourceUrl) continue;
    const volfdnr = new URL(sourceUrl).searchParams.get("VOLFDNR");
    if (!volfdnr || seenVorlagen.has(volfdnr)) continue;
    seenVorlagen.add(volfdnr);

    documents.push({
      docType: "vorlage",
      externalId: volfdnr,
      title: link.text || `Vorlage VOLFDNR ${volfdnr}`,
      sourceUrl,
      stableSourceUrl: sourceUrl,
    });
  }

  return {
    meta: {
      externalId: silfdnr,
      gremium,
      title: betreff ?? gremium,
      meetingDate,
      location,
      sourceUrl: stableSourceUrl,
    },
    documents,
  };
}

/**
 * Alle <a>-Elemente mit href. Der Ankertext darf verschachtelte Tags enthalten
 * (ALLRIS setzt z. B. <span class="zusatzinfo"></span> in den Betreff) — deshalb
 * non-greedy über beliebigen Inhalt und anschließend Tags strippen.
 */
function matchLinks(html: string): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = [];
  const pattern = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    links.push({ href: match[1], text: stripHtml(match[2]) });
  }
  return links;
}

/** TOP-Nummer ("Ö 3.1.1") aus dem Anker id="link_<TOLFDNR>" der Tagesordnungszeile. */
function extractTopNummer(html: string, tolfdnr: string): string | undefined {
  const pattern = new RegExp(
    `<a[^>]*\\bid="link_${escapeRegExp(tolfdnr)}"[^>]*>([\\s\\S]*?)</a>`,
    "i"
  );
  const match = html.match(pattern);
  if (!match) return undefined;
  const value = stripHtml(match[1]);
  return value.length > 0 ? value : undefined;
}

/**
 * Überschrift der Inhaltsspalte ("Ortsbeirat Bleidenstadt - 05.04.2017").
 * Das ERSTE <h1> ist der Seitenkopf ("Stadt Taunusstein") und taugt nicht.
 */
function extractHeadline(html: string): { gremium?: string; datum?: string } | undefined {
  const pattern = /<h1[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i;
  const match = html.match(pattern);
  if (!match) return undefined;
  const text = stripHtml(match[1]);
  if (!text) return undefined;
  const dateMatch = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  const gremium = text.replace(/\s*[-–]\s*\d{1,2}\.\d{1,2}\.\d{4}\s*$/, "").trim();
  return { gremium: gremium || undefined, datum: dateMatch?.[1] };
}

// ---------------------------------------------------------------------------
// to020 (TOP-Detail)
// ---------------------------------------------------------------------------

export interface To020Result {
  beschluss?: string;
  abstimmung?: string;
  /** Beschlussart aus den Grunddaten, z. B. "ungeändert beschlossen". */
  beschlussart?: string;
  votes?: { dafuer: number; dagegen: number; enthaltungen: number };
}

/**
 * Parst die to020-Seite (TOP-Details mit Beschluss und Abstimmung).
 *
 * Die Inhaltsblöcke sind Word-Exporte (Aspose) in aufklappbaren Panels; die
 * Panel-Überschriften stehen NICHT im Panel, sondern als Sprungmarken in der
 * Dokumente-Spalte (`<a href="#showHideLink_id2">Beschluss</a>`). Deshalb wird
 * über diese Sprungmarke der zugehörige Panel-Abschnitt aufgelöst.
 *
 * Es gibt weder <h3>Beschlusstext</h3> noch "Ja-Stimmen:" — die Stimmen stehen
 * als "Dafür/Dagegen/Enthaltungen" in einer Word-Tabelle.
 */
export function parseTo020(html: string): To020Result {
  // Beschlusstext aus dem Panel "Beschluss"
  const beschlussPanel = extractPanel(html, "Beschluss");
  const beschluss = beschlussPanel ? htmlToText(beschlussPanel) || undefined : undefined;

  // Beschlussart/Ergebnis aus den Grunddaten (Label "Beschluss:")
  const beschlussart = extractGrunddatum(html, "Beschluss");

  // Abstimmung: bevorzugt das eigene Panel "Abstimmungsergebnis"; sonst die
  // letzte Stimmen-Tabelle im Beschlusstext (mehrere Abstimmungen je TOP möglich —
  // die letzte ist die über den Gesamtbeschluss).
  const abstimmungPanel = extractPanel(html, "Abstimmungsergebnis");
  const votesSource = htmlToText(abstimmungPanel ?? beschlussPanel ?? "");
  const votes = extractVotes(votesSource);

  const abstimmungParts: string[] = [];
  if (votes) {
    abstimmungParts.push(`Dafür: ${votes.dafuer}`);
    abstimmungParts.push(`Dagegen: ${votes.dagegen}`);
    abstimmungParts.push(`Enthaltungen: ${votes.enthaltungen}`);
  }
  if (beschlussart) abstimmungParts.push(`Ergebnis: ${beschlussart}`);

  return {
    beschluss,
    abstimmung: abstimmungParts.length > 0 ? abstimmungParts.join(", ") : undefined,
    beschlussart,
    votes: votes ?? undefined,
  };
}

/**
 * Schneidet den Panel-Abschnitt heraus, der zur Sprungmarke mit dem gegebenen
 * Label gehört. Panels liegen sequenziell hintereinander; die Anker
 * `id="showHideLink_<key>"` sind die Abschnittsgrenzen.
 */
function extractPanel(html: string, label: string): string | undefined {
  const anchorPattern = new RegExp(
    `<a[^>]*href="#showHideLink_([A-Za-z0-9_]+)"[^>]*>\\s*${escapeRegExp(label)}\\s*</a>`,
    "i"
  );
  const anchorMatch = html.match(anchorPattern);
  if (!anchorMatch) return undefined;
  const key = anchorMatch[1];

  const startPattern = new RegExp(`\\bid="showHideLink_${escapeRegExp(key)}"`);
  const startMatch = startPattern.exec(html);
  if (!startMatch) return undefined;

  // Ende = nächster Panel-Anker (ohne die Wicket-Indicator-IDs, die "-" enthalten)
  const boundaryPattern = /\bid="showHideLink_[A-Za-z0-9_]+"/g;
  boundaryPattern.lastIndex = startMatch.index + startMatch[0].length;
  const next = boundaryPattern.exec(html);
  // Der nächste Anker liegt MITTEN in seinem <a>-Tag → angeschnittenes Tag kappen.
  const section = html
    .slice(startMatch.index, next ? next.index : undefined)
    .replace(/<[^>]*$/, "");

  // Innerhalb des Abschnitts nur den Inhaltsteil (docPart) nehmen, damit der
  // Auf-/Zuklappen-Kopf nicht im Text landet.
  const docPart = section.match(/<div[^>]*class="[^"]*\bdocPart\b[^"]*"[^>]*>([\s\S]*)$/i);
  return docPart ? docPart[1] : section;
}

/** "Dafür: 25 Dagegen: 8 Enthaltungen: 0" — letzte Fundstelle gewinnt. */
function extractVotes(text: string): { dafuer: number; dagegen: number; enthaltungen: number } | null {
  const dafuer = lastNumber(text, /Daf[üu]r\s*:?\s*(\d+)/gi);
  const dagegen = lastNumber(text, /Dagegen\s*:?\s*(\d+)/gi);
  const enthaltungen = lastNumber(text, /Enthaltung(?:en)?\s*:?\s*(\d+)/gi);
  if (dafuer === null && dagegen === null && enthaltungen === null) return null;
  return { dafuer: dafuer ?? 0, dagegen: dagegen ?? 0, enthaltungen: enthaltungen ?? 0 };
}

function lastNumber(text: string, pattern: RegExp): number | null {
  let last: number | null = null;
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) last = Number(match[1]);
  return last;
}

// ---------------------------------------------------------------------------
// Datum-Parsing
// ---------------------------------------------------------------------------

/**
 * "05.04.2017" + "19:30" → Date. Die Zeit ist Ortszeit Europe/Berlin; der
 * UTC-Offset wechselt mit der Sommerzeit (fest verdrahtetes +01:00 lag im
 * Sommerhalbjahr eine Stunde daneben).
 */
function parseDeutschesDatum(datum: string, zeit?: string): Date | null {
  const match = datum.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  const zeitMatch = (zeit ?? "").match(/(\d{1,2}):(\d{2})/);
  const h = zeitMatch ? Number(zeitMatch[1]) : 0;
  const min = zeitMatch ? Number(zeitMatch[2]) : 0;
  return berlinZeitZuDate(Number(y), Number(m), Number(d), h, min);
}

const BERLIN_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function berlinOffsetMs(timestamp: number): number {
  const parts = BERLIN_FORMATTER.formatToParts(new Date(timestamp));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asUtc - timestamp;
}

function berlinZeitZuDate(y: number, m: number, d: number, h: number, min: number): Date | null {
  const naive = Date.UTC(y, m - 1, d, h, min);
  if (!Number.isFinite(naive)) return null;
  // Zwei Durchläufe: der erste Offset stammt aus einer noch ungenauen Instanz,
  // der zweite korrigiert Zeitumstellungs-Grenzfälle.
  let ts = naive - berlinOffsetMs(naive);
  ts = naive - berlinOffsetMs(ts);
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
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
      } else if (this.downloadPdfs && /\.pdf(\?|$)/i.test(doc.sourceUrl)) {
        // PDF laden + Text extrahieren
        // ACHTUNG: doc-IDs bei ALLRIS instabil → immer frisch von Detailseite
        // (vo020 ist eine HTML-Seite, kein PDF — nicht als PDF herunterladen)
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
