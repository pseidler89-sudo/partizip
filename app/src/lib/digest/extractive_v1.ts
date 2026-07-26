/**
 * extractive_v1.ts — Deterministischer Digest-Generator (M7)
 *
 * Strategie: Aus Beschlussvorlagen + Tagesordnungs-TOPs + Protokoll strukturierte Aussagen bauen.
 * Priorität (ADR-009): vorlage > top > Fallback einladung/tagesordnung > Protokoll-Hinweis
 *
 * KEIN LLM — deterministisch, wartungsarm, reproduzierbar.
 * Jede Aussage MUSS eine sourceDocumentId haben — keine Aussage ohne Quelle.
 *
 * M1(c): sourceUrl in Statements = stableSourceUrl wenn vorhanden, sonst sourceUrl.
 *        NIEMALS Wicket-Resource-URLs in digest_statements.
 *
 * Neutralitätskodex (Konzept Kap. 10): Nur Tatsachen aus den Dokumenten,
 * keine Bewertungen, keine Parteinennung.
 */

import type { DigestGenerator, DraftDigest, MeetingInput, DocumentInput, DraftStatement } from "./types.js";

export const GENERATOR_NAME = "extractive_v1";

/**
 * RIEGEL: Aus TOP-Dokumenten werden KEINE Aussagen erzeugt.
 *
 * WARUM GESPERRT
 * Der ALLRIS-Adapter liefert für TOPs bewusst keinen Beschluss- und keinen
 * Abstimmungstext mehr (`allris.ts`, „Hälfte B stillgelegt"). Grund: der
 * to020-Paneltext ist ein Wortprotokoll mit mehreren Abstimmungen hintereinander;
 * die Extraktion traf die ERSTE statt der maßgeblichen Abstimmung. Im Feldtest
 * wären dadurch die Stimmen eines ABGELEHNTEN Änderungsantrags (6/27) als
 * Ergebnis des Hauptbeschlusses (25/8) veröffentlicht worden — namentlich,
 * parteibezogen, automatisch auf Mastodon und Bluesky. Lieber keine Aussage als
 * eine möglicherweise falsche.
 *
 * WARUM ALS KONSTANTE UND NICHT „bodyText ist ja leer"
 * Der Schutz hing bisher allein daran, dass ein Feld leer bleibt. Sobald
 * `body_text` bei TOPs wieder gefüllt wird — durch die Import-CLI, ein Restore
 * aus einem älteren Backup oder einen künftigen Adapter-Fix —, liefe
 * `buildTopStatement` samt seinem `bodyText.match(/Abstimmung:\s*(.+)/i)` sofort
 * wieder mit, ohne dass jemand eine Entscheidung getroffen hätte. Der LESEPFAD
 * muss deshalb selbst gesperrt sein.
 *
 * WAS ZUR REAKTIVIERUNG NÖTIG IST (alle vier Punkte, nicht einzeln)
 *  1. STRUKTURIERTE ÜBERGABE: `votes`/`beschlussart` müssen als eigene Felder bis
 *     hierher durchgereicht werden. Kein Text-Rückparse in dieser Datei — eine
 *     Zeile im Beschlusstext, die zufällig „Abstimmung:" enthält, wird sonst zum
 *     amtlichen Ergebnis.
 *  2. Nur der LETZTE `Beschluss:`-Abschnitt zählt (die maßgebliche Abstimmung),
 *     nicht der gesamte Paneltext.
 *  3. Stimmen nur als TRIPEL aus EINEM gemeinsamen Fundkontext (eine Tabelle,
 *     eine Zeile) — nie drei unabhängige Einzeltreffer.
 *  4. Unvollständig oder mehrdeutig → `null`. Kein Auffüllen fehlender Werte mit 0.
 *
 * Erst wenn 1–4 erfüllt sind, wird hier auf `true` gestellt. `buildTopStatement`
 * bleibt bis dahin erhalten, weil es die Formatierung dokumentiert.
 */
// Typ bewusst `boolean` statt des Literaltyps `false`: der Wert ist ein Schalter,
// kein Beweis für den Compiler. Sonst hält TypeScript den Aktiv-Zweig für toten
// Code und der Riegel ließe sich nicht mehr sinnvoll testen.
export const TOP_STATEMENTS_AKTIV: boolean = false;

export class ExtractiveV1Generator implements DigestGenerator {
  async generate(meeting: MeetingInput, documents: DocumentInput[]): Promise<DraftDigest> {
    const gremium = meeting.gremium ?? meeting.title ?? "Das Gremium";
    const dateStr = meeting.meetingDate
      ? formatDate(meeting.meetingDate)
      : "unbekanntes Datum";

    const title = `${gremium} – Sitzung vom ${dateStr}`;

    // M1(c): Stabile Meeting-URL als Fallback für Wicket-PDF-Dokumente
    // (meeting.sourceUrl ist to010?SILFDNR=... bei ALLRIS, meeting/details/<id> bei Provox)
    const meetingSourceUrl = (meeting as MeetingInput & { sourceUrl?: string }).sourceUrl;

    const statements: DraftStatement[] = [];
    let position = 1;

    // M4: Vorlagen (docType='vorlage') — Priorität vor TOPs (ADR-009)
    const vorlageDocs = documents.filter((d) => d.docType === "vorlage" && d.bodyText);

    for (const doc of vorlageDocs) {
      if (!doc.bodyText) continue;
      const stmt = buildVorlageStatement(doc, position);
      if (stmt) {
        statements.push({
          position,
          text: stmt,
          sourceDocumentId: doc.id,
          // M1(c): stabile URL verwenden (kein Wicket-Resource-URL)
          sourceUrl: resolveStableUrl(doc, meetingSourceUrl),
        });
        position++;
      }
    }

    // TOP-Dokumente (Beschlusstexte) — GESPERRT, siehe TOP_STATEMENTS_AKTIV.
    // Der Riegel steht VOR dem bodyText-Filter: auch ein TOP MIT gefülltem
    // bodyText (Restore, CLI-Import, künftiger Adapter-Fix) erzeugt nichts.
    const topDocs = TOP_STATEMENTS_AKTIV
      ? documents.filter((d) => d.docType === "top" && d.bodyText)
      : [];

    for (const doc of topDocs) {
      if (!doc.bodyText) continue;

      const stmt = buildTopStatement(doc, gremium, position);
      if (stmt) {
        statements.push({
          position,
          text: stmt,
          sourceDocumentId: doc.id,
          sourceUrl: resolveStableUrl(doc, meetingSourceUrl),
        });
        position++;
      }
    }

    // Falls keine Vorlagen UND keine TOPs mit Beschlüssen: Tagesordnung als Fallback
    if (statements.length === 0) {
      const toDocs = documents.filter(
        (d) => (d.docType === "tagesordnung" || d.docType === "einladung") && d.bodyText
      );

      for (const doc of toDocs.slice(0, 1)) {
        if (!doc.bodyText) continue;
        const stmt = buildAgendaSummary(doc, gremium, dateStr);
        if (stmt) {
          statements.push({
            position,
            text: stmt,
            sourceDocumentId: doc.id,
            sourceUrl: resolveStableUrl(doc, meetingSourceUrl),
          });
          position++;
        }
        break;
      }
    }

    // Protokoll-Hinweis als letzte Aussage (falls Protokoll verfügbar)
    const protokoll = documents.find((d) => d.docType === "protokoll");
    if (protokoll && statements.length > 0) {
      statements.push({
        position,
        text: `Das öffentliche Protokoll der Sitzung ist verfügbar.`,
        sourceDocumentId: protokoll.id,
        sourceUrl: resolveStableUrl(protokoll, meetingSourceUrl),
      });
    }

    return { title, generator: GENERATOR_NAME, statements };
  }
}

// ---------------------------------------------------------------------------
// M1(c): Stabile URL auflösen
// ---------------------------------------------------------------------------

/**
 * Gibt die stabile öffentliche URL für Digest-Statements zurück.
 *
 * Regeln:
 * - Wenn doc.sourceUrl eine instabile Wicket-Resource-URL enthält
 *   ("/wicket/resource/") → meetingSourceUrl (to010?SILFDNR=... Seite) verwenden.
 * - Provox getfile-URLs (/file/getfile/<id>) sind stabil → direkt verwenden.
 * - ALLRIS to020/vo020-URLs sind stabil → direkt verwenden.
 * - Falls meetingSourceUrl nicht verfügbar → doc.sourceUrl als Fallback.
 */
export function resolveStableUrl(doc: DocumentInput, meetingSourceUrl?: string): string {
  // Instabile Wicket-URL erkennen
  if (doc.sourceUrl.includes("/wicket/resource/") && meetingSourceUrl) {
    return meetingSourceUrl;
  }
  return doc.sourceUrl;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * M4: Baut eine Aussage aus einer Vorlage (Beschlussvorlage).
 * Briefkopf-Bereinigung per cleanBoilerplate().
 * Format (Neutralitätskodex): nur Fakten, keine Bewertung.
 * Beispiel: "Vorlage XI/1524: Zukunftsfähige Berufsschule — Fachklassen ab 2026/27."
 */
function buildVorlageStatement(
  doc: DocumentInput,
  position: number
): string | null {
  if (!doc.bodyText) return null;

  const cleanText = cleanBoilerplate(doc.bodyText);
  if (!cleanText) return null;

  // Vorlage-Nummer aus Titel extrahieren (z.B. "TOP III.5: Haushaltssatzung (XII/16)")
  // oder aus externalId (file-ID, nicht direkt als Vorlagen-Nr nutzbar)
  // Titel enthält oft bereits die Nummer
  const titleClean = doc.title
    ? doc.title.replace(/\s*\(\d+(\s*kB)?\)\s*$/i, "").trim()
    : `Vorlage ${position}`;

  // Ersten sinnvollen Satz aus bereinigtem Text
  const firstSentence = extractFirstMeaningfulSentence(cleanText);
  if (!firstSentence) return null;

  // Max. 300 Zeichen
  const kurz = firstSentence.length > 300
    ? firstSentence.slice(0, 297) + "…"
    : firstSentence;

  return `${kurz} (Vorlage: ${titleClean})`;
}

/**
 * Baut eine Aussage aus einem TOP-Dokument.
 * Format (Neutralitätskodex): nur Fakten, keine Bewertung.
 * Beispiel: "TOP 3: Der Kreistag hat die Haushaltssatzung 2026 beschlossen (Abstimmung: Ja: 28, Nein: 7, Enthaltungen: 2, Ergebnis: angenommen)."
 */
function buildTopStatement(
  doc: DocumentInput,
  gremium: string,
  position: number
): string | null {
  const bodyText = doc.bodyText!;

  // Abstimmungsergebnis extrahieren (aus parseTo020 injiziert)
  const abstimmungMatch = bodyText.match(/Abstimmung:\s*(.+)/i);
  const abstimmung = abstimmungMatch?.[1]?.trim();

  // Beschlusstext — bereinigen
  const beschlussText = bodyText
    .replace(/Abstimmung:.*$/im, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!beschlussText) return null;

  // Titel des TOPs
  const topTitle = doc.title ?? `TOP ${position}`;

  // Kürzen wenn zu lang (max. 300 Zeichen)
  const kurz = beschlussText.length > 300
    ? beschlussText.slice(0, 297) + "…"
    : beschlussText;

  let stmt = `${topTitle}: ${gremium} hat folgenden Beschluss gefasst: ${kurz}`;
  if (abstimmung) {
    stmt += ` (Abstimmung: ${abstimmung})`;
  }
  stmt += ".";

  return stmt;
}

/**
 * Baut eine Zusammenfassung aus einer Tagesordnung/Einladung.
 * Fallback wenn keine TOP-Beschlusstexte vorhanden.
 */
function buildAgendaSummary(
  doc: DocumentInput,
  gremium: string,
  dateStr: string
): string | null {
  const bodyText = doc.bodyText!;

  // Ersten Satz oder ersten 200 Zeichen
  const firstChunk = bodyText.slice(0, 200).replace(/\n+/g, " ").trim();
  if (!firstChunk) return null;

  return `${gremium} am ${dateStr}: ${firstChunk}…`;
}

// ---------------------------------------------------------------------------
// M4: cleanBoilerplate — Heuristik zum Überspringen von Briefkopf-Seiten
// ---------------------------------------------------------------------------

/**
 * Bereinigt PDF-Volltext von Briefkopf-Boilerplate.
 *
 * Strategie: Überspringe Zeilen am Anfang bis zum ersten Absatz mit
 * > 200 Zeichen zusammenhängendem Fließtext. Liefert den Rest.
 *
 * Erkannte Boilerplate-Muster:
 *   - Kurze Zeilen (< 80 Zeichen) wie "Drucksachen-Nr. XI/1524 Bad Schwalbach"
 *   - Metadaten-Labels: "Ersteller/in:", "Aktenzeichen:", "Beratungsfolge", etc.
 *   - Seitenangaben: "Seite 1 von 2"
 *   - Leere Zeilen
 */
export function cleanBoilerplate(text: string): string {
  const lines = text.split("\n");
  let contentStart = 0;
  let consecutiveLong = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Leere Zeile → Reset des consecutiveLong-Zählers
    if (!line) {
      if (consecutiveLong > 0) consecutiveLong--;
      continue;
    }

    // Typische Boilerplate-Patterns erkennen
    const isBoilerplateLine =
      line.length < 80 ||
      /^(seite\s+\d+|ersteller|aktenzeichen|beratungsfolge|gremium|sitzungsnummer|wahlperiode|datum|uhrzeit|ort|top|ds-nr|beschlussvorlage|tagesordnung|dienstag|montag|mittwoch|donnerstag|freitag)/i.test(line) ||
      /^\d+[./]\d+/.test(line) || // Kurze Zahlencodes
      /^[IVX]+\.\d*\.?\s/.test(line); // Römische Nummern (TOP-Nummern)

    if (!isBoilerplateLine && line.length >= 80) {
      consecutiveLong++;
      if (consecutiveLong >= 1) {
        // Ersten langen Fließtext-Absatz gefunden
        // Gehe zurück zum Beginn dieses Blocks
        contentStart = i - (consecutiveLong - 1);
        break;
      }
    } else {
      consecutiveLong = 0;
    }
  }

  return lines.slice(contentStart).join("\n").trim();
}

/**
 * Extrahiert den ersten sinnvollen Satz aus bereinigtem Text.
 * Satz: endet mit ., !, ? oder nach min. 80 Zeichen am Zeilenende.
 */
function extractFirstMeaningfulSentence(text: string): string | null {
  // Normalisieren
  const normalized = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  // Ersten Satz finden (endet mit . ! ?)
  const sentenceMatch = normalized.match(/^.{20,500}?[.!?](?:\s|$)/);
  if (sentenceMatch) {
    return sentenceMatch[0].trim();
  }

  // Fallback: erste 200 Zeichen
  return normalized.slice(0, 200).trim() || null;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  });
}

