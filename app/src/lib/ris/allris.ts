/**
 * allris.ts — RIS-Adapter für Stadt Taunusstein (ALLRIS net 4) (M7)
 *
 * EINSCHRÄNKUNG: ALLRIS-Listenseiten sind Wicket-Formulare → keine Discovery per API.
 * listRecentMeetings() liest bekannte SILFDNRs aus der Datenbank (manuell erfasst
 * via ris-add-meeting.ts CLI oder importiert).
 *
 * Scraping-Strategie:
 *   - Sitzungsdetails: GET /allris/to010?SILFDNR=<id>&TOLFDNR=... (TO + Dokumente)
 *   - PDF-Links:       Sitzungsbezogen frisch auflösen (doc-IDs instabil!)
 *   - TOP-Details (to020, Beschlusstext + Abstimmung): STILLGELEGT, siehe
 *     „Hälfte B" bei parseTo020 weiter unten. Der Adapter liefert für TOPs
 *     nur Metadaten (Nummer, Betreff, Link), keinen bodyText.
 *
 * SICHERHEIT: Alle Ziel-URLs stammen aus Fremd-HTML. Sie werden gegen eine
 * Scheme-Positivliste, die eigene Origin und den Pfadpräfix `/allris/` geprüft —
 * einmal beim Parsen (parseTo010) und ein zweites Mal unmittelbar vor jedem
 * Fetch (assertAllowedRisUrl). Ohne diese Schranken kann eine manipulierte
 * Seite den Importer zu beliebigen Zielen schicken (SSRF: Cloud-Metadaten,
 * interne Dienste) und die Antwort landet als Digest-Text bzw. als anklickbarer
 * Link auf der öffentlichen Digest-Seite.
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

import type { RisAdapter, MeetingRef, FetchedMeeting, DocumentRef, FetchFn } from "./types.js";
import { makeRisGetFn } from "./fetch-wrapper.js";
import { extractPdfText } from "./provox.js";

// ---------------------------------------------------------------------------
// Grenzen
// ---------------------------------------------------------------------------

/**
 * Obergrenze für Dokumente je Sitzung (analog oparl.ts).
 * Ohne Deckel erzeugt eine manipulierte oder fehlerhafte Seite mit tausenden
 * Links ebenso viele DB-Zeilen und (bei PDFs) ebenso viele gedrosselte Requests
 * à 1,1 s gegen den Stadtserver.
 */
export const MAX_DOCS = 30;

/**
 * Obergrenze für die zu parsende HTML-Größe. Die echten ALLRIS-Seiten liegen bei
 * ~115 KB — 512 KB lassen also den Faktor 4 Luft und schneiden trotzdem alles ab,
 * was kein Sitzungsdokument mehr ist.
 *
 * WARUM so niedrig (und warum ein Budget statt Parser-Chirurgie):
 * Zwei Parse-Pfade sind in der Eingabegröße QUADRATISCH — `matchLinks` sucht je
 * <a>-Tag mit `indexOf`/`slice` bis zum Dateiende, und `extractHeadline` läuft
 * mit einem globalen `[\s\S]*?` über das ganze Dokument. Gemessen: 468 KB
 * brauchten 77 s; auf die frühere Grenze von 2 MB hochgerechnet rund 1300 s.
 * Diese Muster werden hier bewusst NICHT weiter umgebaut (Fix-Freeze auf der
 * Regex-Logik: jede Runde Regex-Chirurgie hat bisher eine neue, schwerere Lücke
 * erzeugt). Stattdessen ein RAHMEN, der unabhängig von der Musterqualität hält:
 * harte Größengrenze hier + hartes Zeitbudget (siehe MAX_PARSE_MS).
 */
export const MAX_HTML_BYTES = 512_000;

/**
 * Wall-Clock-Budget für EINEN Parse-Vorgang (parseTo010/parseTo020).
 * Die echte 115-KB-Seite liegt im einstelligen Millisekundenbereich; 5 s sind
 * also drei Größenordnungen Reserve und greifen nur bei pathologischem Input.
 */
export const MAX_PARSE_MS = 5_000;

/**
 * Schneidet übergroßes HTML ab — laut, nicht still: ein stiller Deckel verdeckt
 * genau den Fehler, den er melden soll.
 */
function capHtml(html: string, kontext: string): string {
  if (html.length <= MAX_HTML_BYTES) return html;
  console.warn(
    `[AllrisAdapter] ${kontext}: HTML ist ${html.length} Zeichen groß und wird auf ` +
      `${MAX_HTML_BYTES} abgeschnitten. Das Ergebnis ist unvollständig.`
  );
  return html.slice(0, MAX_HTML_BYTES);
}

/**
 * Zeitbudget als zweiter Rahmen neben MAX_HTML_BYTES.
 *
 * Die Größengrenze deckelt den WORST CASE, dieses Budget deckelt den REALFALL:
 * Es bricht ab, sobald das Parsen einer einzelnen Seite länger dauert als
 * erlaubt — unabhängig davon, welcher Pfad gerade quadratisch entartet. Der
 * Abbruch ist LAUT (console.warn mit Sitzungs-/Seiten-Kontext) und liefert das
 * bis dahin Ermittelte bzw. ein leeres Ergebnis zurück; ein stiller Abbruch wäre
 * von einer Seite ohne Dokumente nicht zu unterscheiden.
 */
export interface Zeitbudget {
  /** true = Budget aufgebraucht. Warnt beim ersten Mal, danach nicht erneut. */
  abgelaufen(): boolean;
}

function startZeitbudget(kontext: string, budgetMs: number = MAX_PARSE_MS): Zeitbudget {
  const start = Date.now();
  let gewarnt = false;
  return {
    abgelaufen(): boolean {
      const verstrichen = Date.now() - start;
      if (verstrichen < budgetMs) return false;
      if (!gewarnt) {
        gewarnt = true;
        console.warn(
          `[AllrisAdapter] ${kontext}: Zeitbudget von ${budgetMs} ms überschritten ` +
            `(${verstrichen} ms) — Parsen abgebrochen. Das Ergebnis ist unvollständig; ` +
            `Seite prüfen.`
        );
      }
      return true;
    },
  };
}

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
 * Erlaubte Schemes als POSITIVliste. Eine Negativliste (`javascript:`, `mailto:`,
 * …) ist prinzipiell unvollständig — `data:`, `file:`, `gopher:` und alles
 * Künftige rutschen durch.
 */
const ALLOWED_SCHEMES = new Set(["https:", "http:"]);

/** Jede ALLRIS-Ressource liegt unterhalb dieses Pfads. */
const ALLRIS_PATH_PREFIX = "/allris/";

/**
 * Gehört eine bereits aufgelöste URL zur erlaubten ALLRIS-Installation?
 *
 * Drei harte Bedingungen: erlaubtes Scheme, IDENTISCHE Origin wie die
 * konfigurierte Basis-URL (Schema + Host + Port) und Pfad unterhalb `/allris/`.
 * Damit sind `http://169.254.169.254/to020?…` (Cloud-Metadaten),
 * `//attacker.example/…` (protokollrelativ) und ein injiziertes
 * `<base href="https://attacker.example/allris/">` gleichermaßen ausgeschlossen.
 */
export function isAllowedRisUrl(candidate: string, allowedBaseUrl: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(candidate);
    base = new URL(allowedBaseUrl);
  } catch {
    return false;
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return false;
  if (url.origin !== base.origin) return false;
  if (!url.pathname.startsWith(ALLRIS_PATH_PREFIX)) return false;
  return true;
}

/**
 * Löst einen href gegen die Seiten-Basis auf UND prüft ihn gegen die erlaubte
 * Installation. ALLRIS 4 liefert ABSOLUTE hrefs
 * (`https://www.taunusstein.de/allris/to020?...`); ältere/andere Installationen
 * liefern relative. Beides muss funktionieren.
 * Entities (`&amp;`) werden dekodiert — sonst gehen Folge-Fetches mit literalem
 * `&amp;` in der Query raus.
 *
 * Rückgabe `null` = Link verwerfen. Beide Argumente (`href`, `pageBase`) stammen
 * aus Fremd-HTML; die Prüfung erfolgt deshalb gegen `allowedBaseUrl`, das
 * ausschließlich aus der Konfiguration kommt.
 */
function resolveUrl(href: string, pageBase: string, allowedBaseUrl: string): string | null {
  const decoded = decodeEntities(href).trim();
  if (!decoded || decoded.startsWith("#")) return null;
  let resolved: string;
  try {
    resolved = new URL(decoded, pageBase).toString();
  } catch {
    return null;
  }
  return isAllowedRisUrl(resolved, allowedBaseUrl) ? resolved : null;
}

/**
 * `<base href="…">` der Seite (ALLRIS setzt `…/allris/`). Ohne base-Tag gilt die
 * ALLRIS-Konvention `<baseUrl>/allris/`, damit auch dokument-relative hrefs
 * (`to020?TOLFDNR=…`) korrekt auflösen.
 *
 * Ein `<base href>`, das die eigene Origin verlässt oder aus `/allris/`
 * herausführt, wird IGNORIERT (Fallback) — sonst genügt ein einziges injiziertes
 * Tag, um jeden relativen Link der Seite auf einen fremden Host zu ziehen.
 */
function resolveBaseHref(html: string, allowedBaseUrl: string): string {
  const fallback = `${allowedBaseUrl.replace(/\/$/, "")}${ALLRIS_PATH_PREFIX}`;
  const match = html.match(/<base\s([^>]*)>/i);
  const href = match?.[1].match(/\bhref="([^"]*)"/i)?.[1];
  if (!href) return fallback;
  let candidate: string;
  try {
    candidate = new URL(decodeEntities(href), fallback).toString();
  } catch {
    return fallback;
  }
  if (!isAllowedRisUrl(candidate, allowedBaseUrl)) {
    console.warn(
      `[AllrisAdapter] <base href="${href}"> verlässt die erlaubte ALLRIS-Installation ` +
        `(${allowedBaseUrl}${ALLRIS_PATH_PREFIX}) und wird ignoriert.`
    );
    return fallback;
  }
  return candidate;
}

/**
 * Liest ein Feld aus dem ALLRIS-„Grunddaten"-Block. Struktur:
 *   <dt class="colTitle"><span class="label">Datum:</span></dt>
 *   <dd class="colEntry"><span class="text4" id="sidatum">…Mi., 05.04.2017…</span></dd>
 *
 * LABEL-basiert, NICHT positionsbasiert: die Reihenfolge der Felder ist je nach
 * Sitzungsart unterschiedlich, und ein dokumentweiter Regex-Scan trifft
 * zuverlässig den falschen Treffer (z. B. die ALLRIS-Versionszeile im <head>).
 *
 * ReDoS: Der Tag-Kopf wird in EINEM Schritt gefasst (`<span\s([^>]*)>`); die
 * Klassenprüfung läuft danach auf dem isolierten Attributstring. Zwei
 * unbegrenzte `[^>]*` um eine Gruppe herum (`class="[^"]*\blabel\b[^"]*"`)
 * lassen die Laufzeit bei feindlichem Input kubisch wachsen.
 */
function extractGrunddatum(html: string, label: string): string | undefined {
  const spanPattern = new RegExp(
    `<span\\s([^>]*)>\\s*${escapeRegExp(label)}\\s*:?\\s*</span>`,
    "gi"
  );
  let match: RegExpExecArray | null;
  while ((match = spanPattern.exec(html)) !== null) {
    if (!hasClassWord(match[1], "label")) continue;
    // Fenster nach dem Label: der zugehörige <dd>-Wert steht unmittelbar dahinter.
    const window = html.slice(spanPattern.lastIndex, spanPattern.lastIndex + 20_000);
    const ddMatch = window.match(/^[\s\S]{0,120}?<dd[^>]*>([\s\S]*?)<\/dd>/i);
    if (!ddMatch) continue;
    const value = stripHtml(ddMatch[1]);
    if (value.length > 0) return value;
  }
  return undefined;
}

/**
 * Prüft ein Klassenwort auf einem bereits ISOLIERTEN Attributstring
 * (Ergebnis von `<tag\s([^>]*)>`), nicht auf dem Roh-HTML.
 */
function hasClassWord(attrs: string, word: string): boolean {
  const classValue = attrs.match(/\bclass="([^"]*)"/i)?.[1];
  if (!classValue) return false;
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(classValue);
}

/** Erstes Grunddaten-Feld, das einen Wert liefert. */
function extractFirstGrunddatum(html: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const value = extractGrunddatum(html, label);
    if (value) return value;
  }
  return undefined;
}

// HINWEIS: Hier gibt es bewusst keine Hash-Funktion mehr. Der früher im Adapter
// berechnete `contentHash` wurde nie verwendet — scripts/ris-import.ts rechnet
// den Hash beim Upsert selbst aus `body_text` neu.

/**
 * Parst die to010-Seite (Sitzung/Tagesordnung).
 * Extrahiert: Gremium, Betreff, Datum/Uhrzeit, Ort, Dokumente, TOP-/Vorlagen-Links.
 *
 * @param allowedBaseUrl Erlaubte ALLRIS-Installation (aus der KONFIGURATION, nicht
 *   aus der Seite). Jeder Link muss darunter liegen; alles andere wird verworfen.
 *   Default ist `baseUrl`, weil beides in der Praxis dieselbe Quelle ist — der
 *   Parameter macht die Schranke aber explizit und in Tests einzeln setzbar.
 * @param budgetMs Wall-Clock-Budget für diesen Parse-Vorgang (Default MAX_PARSE_MS).
 *   In Tests klein setzbar, um den Abbruchpfad ohne 5-Sekunden-Wartezeit zu prüfen.
 */
export function parseTo010(
  html: string,
  baseUrl: string,
  silfdnr: string,
  allowedBaseUrl: string = baseUrl,
  budgetMs: number = MAX_PARSE_MS
): { meta: Partial<MeetingRef>; documents: DocumentRef[] } {
  const kontext = `to010?SILFDNR=${silfdnr}`;
  html = capHtml(html, kontext);
  const budget = startZeitbudget(kontext, budgetMs);

  const documents: DocumentRef[] = [];
  let verworfeneDocs = 0;
  /** Fügt ein Dokument hinzu; false = Deckel erreicht. */
  const pushDoc = (doc: DocumentRef): boolean => {
    if (documents.length >= MAX_DOCS) {
      verworfeneDocs++;
      return false;
    }
    documents.push(doc);
    return true;
  };

  const pageBase = resolveBaseHref(html, allowedBaseUrl);
  const links = matchLinks(html, budget);

  // Kopfzeile "<Gremium> - <Datum>" als Fallback, falls die Grunddaten fehlen.
  // NICHT das erste <h1> nehmen: das ist der Seitenkopf ("Stadt Taunusstein").
  const headline = extractHeadline(html, budget);

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

  // Stabile Sitzungs-URL (meta.sourceUrl). Sie wird NICHT aus der Seite
  // übernommen, sondern aus Konfiguration + SILFDNR gebaut.
  const meetingPageUrl =
    resolveUrl(`to010?SILFDNR=${encodeURIComponent(silfdnr)}`, pageBase, allowedBaseUrl) ??
    `${allowedBaseUrl.replace(/\/$/, "")}${ALLRIS_PATH_PREFIX}to010?SILFDNR=${encodeURIComponent(silfdnr)}`;

  // Sitzungsdokumente (PDF-Links)
  // M1(b): Wicket-doc-IDs (doc<N>.pdf) sind INSTABIL → stable external_id aus docType+normalisiertem Label
  // Die Wicket-URL wird in source_url gespeichert und IMMER aktualisiert (UPDATE-Pfad in upsertDocument).
  const seenDocTypes = new Set<string>();
  for (const link of links) {
    if (budget.abgelaufen()) break;
    if (!/\/wicket\/resource\/org\.apache\.wicket\.Application\/doc\d+\.pdf/i.test(link.href)) continue;
    const sourceUrl = resolveUrl(link.href, pageBase, allowedBaseUrl);
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

    // HINWEIS: KEIN stableSourceUrl-Feld mehr (analog oparl.ts). Es gibt in
    // `ris_documents` keine Spalte dafür — der Wert wurde nie persistiert. Der
    // Digest ersetzt instabile Wicket-URLs selbst über
    // `extractive_v1.resolveStableUrl(doc, meeting.sourceUrl)`.
    pushDoc({ docType, externalId: stableId, title: linkText || undefined, sourceUrl });
  }

  // TO-Links (to020?TOLFDNR=…) — TOPs mit Beschlüssen
  const seenTops = new Set<string>();
  for (const link of links) {
    if (budget.abgelaufen()) break;
    if (!/(?:^|\/)to020\?/i.test(link.href)) continue;
    const sourceUrl = resolveUrl(link.href, pageBase, allowedBaseUrl);
    if (!sourceUrl) continue;
    const tolfdnr = new URL(sourceUrl).searchParams.get("TOLFDNR");
    if (!tolfdnr || seenTops.has(tolfdnr)) continue;
    seenTops.add(tolfdnr);

    // TOP-Nummer steht in derselben Zeile in <td class="tonr"> und ist über
    // dieselbe TOLFDNR verankert (id="link_<TOLFDNR>") — kein Positionsraten.
    const nummer = extractTopNummer(links, tolfdnr);
    const betreffText = link.text;
    let topTitle: string;
    if (nummer && betreffText) topTitle = `TOP ${nummer} – ${betreffText}`;
    else if (nummer) topTitle = `TOP ${nummer}`;
    else if (betreffText) topTitle = betreffText;
    else topTitle = `TOP (TOLFDNR ${tolfdnr})`;

    pushDoc({
      docType: "top",
      externalId: tolfdnr,
      title: topTitle,
      sourceUrl,
    });
  }

  // Vorlagen-Links (vo020?VOLFDNR=…)
  const seenVorlagen = new Set<string>();
  for (const link of links) {
    if (budget.abgelaufen()) break;
    if (!/(?:^|\/)vo020\?/i.test(link.href)) continue;
    const sourceUrl = resolveUrl(link.href, pageBase, allowedBaseUrl);
    if (!sourceUrl) continue;
    const volfdnr = new URL(sourceUrl).searchParams.get("VOLFDNR");
    if (!volfdnr || seenVorlagen.has(volfdnr)) continue;
    seenVorlagen.add(volfdnr);

    pushDoc({
      docType: "vorlage",
      externalId: volfdnr,
      title: link.text || `Vorlage VOLFDNR ${volfdnr}`,
      sourceUrl,
    });
  }

  if (verworfeneDocs > 0) {
    // LAUT, nicht still: ein stillschweigend greifender Deckel verdeckt genau
    // den Fehler (oder Angriff), den er melden soll.
    console.warn(
      `[AllrisAdapter] Sitzung ${silfdnr}: Obergrenze von ${MAX_DOCS} Dokumenten erreicht, ` +
        `${verworfeneDocs} weitere Dokument(e)/TOP(s) verworfen. ` +
        `Die Sitzung ist unvollständig importiert — Seite prüfen.`
    );
  }

  return {
    meta: {
      externalId: silfdnr,
      gremium,
      title: betreff ?? gremium,
      meetingDate,
      location,
      sourceUrl: meetingPageUrl,
    },
    documents,
  };
}

interface ParsedLink {
  href: string;
  text: string;
  /** Roher Attributstring des <a>-Tags — für id/class-Prüfungen ohne zweiten Scan. */
  attrs: string;
}

/**
 * Alle <a>-Elemente mit href. Der Ankertext darf verschachtelte Tags enthalten
 * (ALLRIS setzt z. B. <span class="zusatzinfo"></span> in den Betreff) — deshalb
 * bis zum nächsten </a> lesen und anschließend Tags strippen.
 *
 * ReDoS: Der Tag-Kopf wird in EINEM Schritt gefasst (`<a\s([^>]*)>`), das href
 * danach aus dem isolierten Attributstring gezogen. Das Vorgängermuster
 * `<a\s+[^>]*href="([^"]*)"[^>]*>` hatte zwei unbegrenzte `[^>]*` um eine
 * Gruppe: an der echten Fixture (115 KB) 16 ms, mit 1200 angehängten
 * `<a href="x"` (128 KB) 10 643 ms — kubisches Wachstum.
 *
 * BEKANNT QUADRATISCH und bewusst NICHT umgebaut (Fix-Freeze auf der
 * Regex-Logik): `indexOf`/`slice` suchen je <a>-Tag bis zum Dateiende. Der
 * Schutz ist der RAHMEN — MAX_HTML_BYTES begrenzt die Länge, das Zeitbudget
 * bricht die Schleife ab. Abbruch = Teilergebnis + Warnung, nie stilles Nichts.
 */
function matchLinks(html: string, budget: Zeitbudget): ParsedLink[] {
  const links: ParsedLink[] = [];
  const tagPattern = /<a\s([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    if (budget.abgelaufen()) break;
    const attrs = match[1];
    const href = attrs.match(/\bhref="([^"]*)"/i)?.[1];
    if (href === undefined) continue;
    const close = html.indexOf("</a", tagPattern.lastIndex);
    const text = close === -1 ? "" : stripHtml(html.slice(tagPattern.lastIndex, close));
    links.push({ href, text, attrs });
  }
  return links;
}

/**
 * TOP-Nummer ("Ö 3.1.1") aus dem Anker id="link_<TOLFDNR>" der Tagesordnungszeile.
 * Arbeitet auf den bereits geparsten Links — kein zweiter Scan über das HTML.
 */
function extractTopNummer(links: ParsedLink[], tolfdnr: string): string | undefined {
  const idPattern = new RegExp(`\\bid="link_${escapeRegExp(tolfdnr)}"`, "i");
  for (const link of links) {
    if (!idPattern.test(link.attrs)) continue;
    if (link.text.length > 0) return link.text;
  }
  return undefined;
}

/**
 * Überschrift der Inhaltsspalte ("Ortsbeirat Bleidenstadt - 05.04.2017").
 * Das ERSTE <h1> ist der Seitenkopf ("Stadt Taunusstein") und taugt nicht.
 *
 * ReDoS: wie oben — Tag-Kopf in einem Schritt, Klassenprüfung auf dem
 * isolierten Attributstring.
 *
 * BEKANNT QUADRATISCH: das globale `[\s\S]*?` läuft ohne passendes `</h1>` bis
 * zum Dateiende, und zwar je `<h1`-Kandidat erneut. Auch hier kein Regex-Umbau,
 * sondern der Rahmen: Größengrenze + Zeitbudget (Abbruch mit Warnung).
 */
function extractHeadline(
  html: string,
  budget: Zeitbudget
): { gremium?: string; datum?: string } | undefined {
  const pattern = /<h1\s([^>]*)>([\s\S]*?)<\/h1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (budget.abgelaufen()) return undefined;
    if (!hasClassWord(match[1], "title")) continue;
    const text = stripHtml(match[2]);
    if (!text) continue;
    const dateMatch = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    const gremium = text.replace(/\s*[-–]\s*\d{1,2}\.\d{1,2}\.\d{4}\s*$/, "").trim();
    return { gremium: gremium || undefined, datum: dateMatch?.[1] };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// to020 (TOP-Detail) — „Hälfte B", STILLGELEGT
// ---------------------------------------------------------------------------
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ STILLGELEGT — parseTo020 wird von fetchMeeting NICHT mehr aufgerufen.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// WARUM (an Live-Daten reproduziert, Gate-B):
//   - Der Panel-Text ist ein WORTPROTOKOLL, kein Beschluss. Er enthält
//     Änderungsanträge, Wortmeldungen und mehrere Abstimmungen hintereinander.
//   - Die Stimmenzahlen sind keiner Abstimmung eindeutig zuzuordnen: extractVotes
//     sammelt „Dafür/Dagegen/Enthaltungen" dokumentweit ein und nimmt je Feld die
//     letzte Fundstelle — die drei Zahlen können damit aus DREI VERSCHIEDENEN
//     Abstimmungen stammen.
//   - Ergebnis im Feldtest: der Digest veröffentlichte die Stimmen eines
//     ABGELEHNTEN Änderungsantrags (6/27) als Ergebnis des Hauptbeschlusses
//     (25/8) — namentlich, parteibezogen, automatisch auf Mastodon und Bluesky.
//     Eine falsche Abstimmungszahl über eine benannte Fraktion ist der teuerste
//     denkbare Fehler dieser Plattform. Deshalb: lieber keine Aussage als eine
//     möglicherweise falsche.
//
// WAS ZUR REAKTIVIERUNG NÖTIG IST (alle vier Punkte, nicht einzeln):
//   1. STRUKTURIERTE ÜBERGABE statt Text-Rückparse: `votes`/`beschlussart` müssen
//      als Felder bis zum Digest durchgereicht werden. Heute serialisiert der
//      Adapter sie in den bodyText und `extractive_v1.ts` (buildTopStatement,
//      `bodyText.match(/Abstimmung:\s*(.+)/i)`) parst sie wieder heraus — eine
//      Textzeile im Beschluss, die zufällig „Abstimmung:" enthält, wird dort zum
//      amtlichen Ergebnis.
//   2. Nur der LETZTE `Beschluss:`-Abschnitt des Panels zählt (die maßgebliche
//      Abstimmung), nicht der gesamte Paneltext.
//   3. Stimmen nur als TRIPEL aus EINEM gemeinsamen Fundkontext (eine Tabelle,
//      eine Zeile) — nie drei unabhängige Einzeltreffer. Doppelpunkt ist Pflicht
//      (`Dafür: 25`), damit Fließtext („dafür 25 Jahre") nicht greift.
//   4. Unvollständig oder mehrdeutig (fehlendes Feld, mehrere Kandidaten-Tripel)
//      → `null`. Kein Auffüllen fehlender Werte mit 0.
//
// Die Funktion bleibt samt Tests erhalten, weil sie das Parsing dokumentiert und
// die Grundlage für Punkt 2–4 ist. Sie ist bis dahin ohne Aufrufer im Produktivpfad.

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
 *
 * STILLGELEGT — siehe Kommentarblock oben. Kein Aufrufer im Produktivpfad.
 */
export function parseTo020(html: string, budgetMs: number = MAX_PARSE_MS): To020Result {
  html = capHtml(html, "to020");
  const budget = startZeitbudget("to020", budgetMs);

  // Beschlusstext aus dem Panel "Beschluss"
  const beschlussPanel = extractPanel(html, "Beschluss", budget);
  const beschluss = beschlussPanel ? htmlToText(beschlussPanel) || undefined : undefined;

  // Beschlussart/Ergebnis aus den Grunddaten (Label "Beschluss:")
  const beschlussart = extractGrunddatum(html, "Beschluss");

  // Abstimmung: bevorzugt das eigene Panel "Abstimmungsergebnis"; sonst die
  // letzte Stimmen-Tabelle im Beschlusstext (mehrere Abstimmungen je TOP möglich —
  // die letzte ist die über den Gesamtbeschluss).
  const abstimmungPanel = extractPanel(html, "Abstimmungsergebnis", budget);
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
function extractPanel(html: string, label: string, budget: Zeitbudget): string | undefined {
  // ReDoS-sicher: Tag-Kopf in einem Schritt, href danach aus dem isolierten
  // Attributstring (nicht zwei freie [^>]* um eine Gruppe herum).
  const labelPattern = new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, "i");
  const anchor = matchLinks(html, budget).find(
    (link) => /^#showHideLink_[A-Za-z0-9_]+$/.test(link.href) && labelPattern.test(link.text)
  );
  if (!anchor) return undefined;
  const key = anchor.href.replace("#showHideLink_", "");

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
  // Auf-/Zuklappen-Kopf nicht im Text landet. Tag-Kopf wieder in EINEM Schritt.
  const divPattern = /<div\s([^>]*)>/gi;
  let divMatch: RegExpExecArray | null;
  while ((divMatch = divPattern.exec(section)) !== null) {
    if (hasClassWord(divMatch[1], "docPart")) return section.slice(divPattern.lastIndex);
  }
  return section;
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

  /**
   * Zahl der Fehler, die beim letzten fetchMeeting-Lauf verschluckt wurden
   * (fehlgeschlagene PDF-Downloads, PDFs ohne extrahierbaren Text, verworfene
   * Ziel-URLs). Der Aufrufer
   * (scripts/ris-import.ts) spiegelt sie in den Exit-Code: ein Import, der
   * still mit Code 0 endet, obwohl Texte fehlen, ist von einem erfolgreichen
   * Import nicht zu unterscheiden.
   */
  get errorCount(): number {
    return this.fehler;
  }
  private fehler = 0;

  /**
   * ZWEITE SCHRANKE unmittelbar vor jedem Fetch. Die erste sitzt in parseTo010;
   * diese hier greift auch für URLs, die über einen anderen Weg hereinkommen —
   * etwa `ref.sourceUrl` aus der Datenbank, die bei einem früheren Import aus
   * Fremd-HTML befüllt worden sein kann.
   */
  private assertAllowedRisUrl(url: string, kontext: string): void {
    if (isAllowedRisUrl(url, this.baseUrl)) return;
    throw new Error(
      `[AllrisAdapter] Ziel-URL außerhalb der erlaubten ALLRIS-Installation ` +
        `(${this.baseUrl}${ALLRIS_PATH_PREFIX}) — nicht abgerufen: ${url} (${kontext})`
    );
  }

  async fetchMeeting(ref: MeetingRef): Promise<FetchedMeeting> {
    this.fehler = 0;

    // Sitzungsseite laden — auch die Einstiegs-URL wird geprüft.
    this.assertAllowedRisUrl(ref.sourceUrl, `Sitzung ${ref.externalId}`);
    const resp = await this.fetchFn(ref.sourceUrl);
    const html = await resp.text();

    const { meta, documents: rawDocs } = parseTo010(html, this.baseUrl, ref.externalId, this.baseUrl);

    const enrichedDocs: DocumentRef[] = [];

    for (const doc of rawDocs) {
      if (doc.docType === "top") {
        // HÄLFTE B STILLGELEGT: kein to020-Abruf, kein bodyText, kein contentHash.
        // TOPs sind reine Metadaten (Nummer, Betreff, Link) — siehe der
        // Kommentarblock bei parseTo020. Das spart nebenbei einen gedrosselten
        // Request (1,1 s) je TOP gegen den Stadtserver.
        enrichedDocs.push(doc);
      } else if (this.downloadPdfs && /\.pdf(\?|$)/i.test(doc.sourceUrl)) {
        // PDF laden + Text extrahieren
        // ACHTUNG: doc-IDs bei ALLRIS instabil → immer frisch von Detailseite
        // (vo020 ist eine HTML-Seite, kein PDF — nicht als PDF herunterladen)
        try {
          this.assertAllowedRisUrl(doc.sourceUrl, `Dokument ${doc.externalId ?? doc.title ?? "?"}`);
          const pdfResp = await this.fetchFn(doc.sourceUrl);
          const buffer = await pdfResp.arrayBuffer();
          const bodyText = await extractPdfText(buffer);
          // extractPdfText WIRFT NICHT: ein unlesbares oder leeres PDF kommt als
          // `null` zurück. Der catch unten greift dafür also nie — ohne diese
          // Prüfung blieb errorCount 0 und der Import meldete „✓ n Dokument(e)
          // importiert" mit Exit 0, obwohl kein einziger Text angekommen war
          // (gemessen: 5 PDFs geladen, 5-mal null, Exit 0).
          if (bodyText === null) {
            this.fehler++;
            console.warn(
              `[AllrisAdapter] PDF ohne lesbaren Text: ${doc.sourceUrl} — ` +
                `Textextraktion lieferte nichts (unlesbares, leeres oder reines Bild-PDF). ` +
                `Das Dokument bleibt ohne bodyText.`
            );
          }
          // KEIN contentHash hier: scripts/ris-import.ts rechnet ihn ohnehin aus
          // dem bodyText neu — ein zweiter Hash wäre toter Code, der auseinanderlaufen kann.
          enrichedDocs.push({ ...doc, bodyText });
        } catch (err) {
          // NICHT still verschlucken: ein leerer catch löscht beim nächsten
          // Import den bereits korrekt importierten Text (ris-import schrieb
          // body_text/content_hash auf NULL), und der Lauf endete mit Code 0.
          this.fehler++;
          console.warn(
            `[AllrisAdapter] Dokument konnte nicht geladen werden: ${doc.sourceUrl} — ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
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
