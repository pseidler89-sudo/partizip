/**
 * allris.test.ts — Tests für den ALLRIS-4-Adapter (M7)
 *
 * KEINE Live-HTTP-Requests — Fixtures aus __fixtures__/
 *
 * WICHTIG: Die Fixtures sind UNVERÄNDERTE, live gezogene Seiten von
 * www.taunusstein.de (to010 = Ortsbeirat Bleidenstadt SILFDNR 4021,
 * to020 = Haushaltssatzung TOLFDNR 1026743). Die Vorgänger-Fixtures waren
 * handgeschriebenes Wunsch-HTML — die Tests waren grün, der Import in der
 * Realität aber ohne Datum und ohne Dokumente (Issue #61). Fixtures deshalb
 * nie „aufräumen" und nie von Hand schreiben.
 *
 * Die Tests sichern konkrete Werte aus dem echten HTML zu, nicht „nicht leer".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTo010,
  parseTo020,
  AllrisAdapter,
  isAllowedRisUrl,
  MAX_DOCS,
  MAX_HTML_BYTES,
  MAX_PARSE_MS,
} from "../allris.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../__fixtures__");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

const TO010 = loadFixture("allris-to010-real.html");
const TO020 = loadFixture("allris-to020-real.html");
const TO010_HOSTILE = loadFixture("allris-to010-hostile.html");

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = "https://www.taunusstein.de";
const SILFDNR = "4021";

function parseMeeting() {
  return parseTo010(TO010, BASE, SILFDNR);
}

// ---------------------------------------------------------------------------
// parseTo010 — Grunddaten
// ---------------------------------------------------------------------------

describe("parseTo010 (echte ALLRIS-4-Seite, SILFDNR 4021)", () => {
  it("liest Gremium label-basiert — nicht aus dem ersten <h1> (Seitenkopf)", () => {
    const { meta } = parseMeeting();
    expect(meta.gremium).toBe("Ortsbeirat Bleidenstadt");
    // Das erste <h1> der Seite ist "Stadt Taunusstein" und darf nicht durchschlagen.
    expect(meta.gremium).not.toContain("Stadt Taunusstein");
  });

  it("liest den Betreff als Titel", () => {
    const { meta } = parseMeeting();
    expect(meta.title).toBe("2. öffentliche Sitzung des Ortsbeirates Bleidenstadt");
  });

  it("liest Sitzungsdatum 05.04.2017 und Uhrzeit 19:30 (Ortszeit Europe/Berlin)", () => {
    const { meta } = parseMeeting();
    expect(meta.meetingDate).toBeInstanceOf(Date);
    // 05.04.2017 19:30 MESZ (+02:00) → 17:30 UTC. Zeitzonenunabhängig geprüft.
    expect(meta.meetingDate?.toISOString()).toBe("2017-04-05T17:30:00.000Z");
  });

  it("REGRESSION: die ALLRIS-Versionszeile im <head> ist NICHT das Sitzungsdatum", () => {
    // <meta name="description" content="ALLRIS net Version 4.1.7 (4170039) - 04.06.2026" />
    // steht auf JEDER Seite und war der erste dd.mm.yyyy-Treffer im Dokument.
    expect(TO010).toContain("ALLRIS net Version 4.1.7 (4170039) - 04.06.2026");

    const { meta } = parseMeeting();
    expect(meta.meetingDate?.getUTCFullYear()).toBe(2017);
    expect(meta.meetingDate?.getUTCMonth()).toBe(3); // April
    expect(meta.meetingDate?.getUTCDate()).toBe(5);
  });

  it("REGRESSION: ohne Grunddaten-Block liefert die Versionszeile kein Datum", () => {
    const nurMeta =
      '<html><head><meta name="description" content="ALLRIS net Version 4.1.7 (4170039) - 04.06.2026" />' +
      "</head><body><h1>Stadt Taunusstein</h1></body></html>";
    const { meta } = parseTo010(nurMeta, BASE, SILFDNR);
    expect(meta.meetingDate).toBeUndefined();
  });

  it("lässt location undefined — die Seite hat kein Ort-/Raum-/Saal-Feld", () => {
    const { meta } = parseMeeting();
    expect(meta.location).toBeUndefined();
    expect(TO010).not.toContain("Sitzungsort");
  });

  it("setzt die stabile Sitzungs-URL", () => {
    const { meta } = parseMeeting();
    expect(meta.sourceUrl).toBe("https://www.taunusstein.de/allris/to010?SILFDNR=4021");
  });
});

// ---------------------------------------------------------------------------
// parseTo010 — Links (absolut im echten HTML!)
// ---------------------------------------------------------------------------

describe("parseTo010 — Dokumente und Links", () => {
  it("findet alle 9 TOP-Links (to020?TOLFDNR=…) trotz absoluter hrefs", () => {
    const { documents } = parseMeeting();
    const tops = documents.filter((d) => d.docType === "top");
    expect(tops).toHaveLength(9);
    expect(tops.map((d) => d.externalId)).toEqual([
      "48521", "48522", "48528", "48529", "48526", "48525", "48524", "48530", "48534",
    ]);
  });

  it("dekodiert &amp; in den TOP-URLs (sonst gehen Folge-Fetches kaputt)", () => {
    const { documents } = parseMeeting();
    const top = documents.find((d) => d.externalId === "48521");
    expect(top?.sourceUrl).toBe(
      "https://www.taunusstein.de/allris/to020?TOLFDNR=48521&SILFDNR=4021"
    );
    for (const doc of documents) {
      expect(doc.sourceUrl).not.toContain("&amp;");
    }
  });

  it("übernimmt TOP-Nummer und Betreff in den Titel (verschachtelte Tags im Anker)", () => {
    const { documents } = parseMeeting();
    const top1 = documents.find((d) => d.externalId === "48521");
    // Der Ankertext enthält <span class="zusatzinfo"></span> — darf nicht abschneiden.
    expect(top1?.title).toBe(
      "TOP Ö 1 – Feststellung der frist- und ordnungsgemäßen Einladung, " +
        "der Beschlussfähigkeit und der Tagesordnung"
    );
    const top311 = documents.find((d) => d.externalId === "48526");
    expect(top311?.title).toContain("TOP Ö 3.1.1 – ");
    expect(top311?.title).toContain("Aufstellen von Hinweisschildern");
  });

  it("findet alle 3 Vorlagen-Links (vo020?VOLFDNR=…)", () => {
    const { documents } = parseMeeting();
    const vorlagen = documents.filter((d) => d.docType === "vorlage");
    expect(vorlagen).toHaveLength(3);
    expect(vorlagen.map((d) => d.externalId)).toEqual(["9918", "9933", "9919"]);
    expect(vorlagen.map((d) => d.title)).toEqual([
      "RS. 16/218-02", // so steht es tatsächlich im RIS
      "DRS. 17/051",
      "DRS. 17/044",
    ]);
    expect(vorlagen[0].sourceUrl).toBe(
      "https://www.taunusstein.de/allris/vo020?VOLFDNR=9918&refresh=false&TOLFDNR=48526"
    );
  });

  it("findet alle 5 PDF-Dokumente mit Titel und Typ", () => {
    const { documents } = parseMeeting();
    const pdfs = documents.filter((d) =>
      ["einladung", "protokoll", "anlage"].includes(d.docType)
    );
    expect(pdfs.map((d) => [d.docType, d.title])).toEqual([
      ["einladung", "Einladung"],
      ["anlage", "Bekanntmachung"],
      ["protokoll", "Niederschrift gesamt"],
      ["protokoll", "Niederschrift öffentlich"],
      ["protokoll", "Niederschrift nichtöffentlich"],
    ]);
    expect(pdfs[0].sourceUrl).toBe(
      "https://www.taunusstein.de/allris/wicket/resource/org.apache.wicket.Application/doc243270.pdf"
    );
    // M1(b): externalId ist stabil (docType + normalisiertes Label), nicht die doc-ID
    expect(pdfs.map((d) => d.externalId)).toEqual([
      "einladung:einladung",
      "anlage:bekanntmachung",
      "protokoll:niederschrift_gesamt",
      "protokoll:niederschrift_oeffentlich",
      "protokoll:niederschrift_nichtoeffentlich",
    ]);
    // stableSourceUrl entfällt (wie in oparl.ts): `ris_documents` hat keine
    // Spalte dafür. Der Digest ersetzt instabile Wicket-URLs selbst über
    // resolveStableUrl(doc, meeting.sourceUrl).
    for (const pdf of pdfs) {
      expect(pdf.stableSourceUrl).toBeUndefined();
    }
    const { meta } = parseMeeting();
    expect(meta.sourceUrl).toBe("https://www.taunusstein.de/allris/to010?SILFDNR=4021");
  });

  it("ignoriert Navigations-, Anker- und mailto-Links", () => {
    const { documents } = parseMeeting();
    // Der "Aktenmappe"-Eintrag in der Dokumente-Spalte ist ein <a href="#">.
    expect(TO010).toContain('id="sammeldoc"');
    for (const doc of documents) {
      expect(doc.sourceUrl).toMatch(/^https:\/\/www\.taunusstein\.de\/allris\//);
    }
    expect(documents).toHaveLength(9 + 3 + 5);
  });

  it("löst auch relative hrefs gegen die Basis-URL auf", () => {
    const relativ =
      '<html><body><a href="/allris/to020?TOLFDNR=99&amp;SILFDNR=1">A</a>' +
      '<a href="vo020?VOLFDNR=77">B</a></body></html>';
    const { documents } = parseTo010(relativ, BASE, "1");
    expect(documents.find((d) => d.docType === "top")?.sourceUrl).toBe(
      "https://www.taunusstein.de/allris/to020?TOLFDNR=99&SILFDNR=1"
    );
    expect(documents.find((d) => d.docType === "vorlage")?.sourceUrl).toBe(
      "https://www.taunusstein.de/allris/vo020?VOLFDNR=77"
    );
  });
});

// ---------------------------------------------------------------------------
// SSRF: Ziel-URLs stammen aus Fremd-HTML
// ---------------------------------------------------------------------------

describe("parseTo010 — SSRF-Schranke (Origin + Pfad + Scheme-Positivliste)", () => {
  it("verwirft ALLE Links außerhalb der eigenen ALLRIS-Installation", () => {
    const { documents } = parseTo010(TO010_HOSTILE, BASE, "4021");

    // Es bleibt genau der eine legitime relative Link übrig.
    expect(documents).toHaveLength(1);
    expect(documents[0].sourceUrl).toBe(
      "https://www.taunusstein.de/allris/to020?TOLFDNR=48521&SILFDNR=4021"
    );

    // Zusicherung als Negativliste über das Ergebnis: nichts Fremdes darf durch.
    for (const doc of documents) {
      expect(doc.sourceUrl.startsWith("https://www.taunusstein.de/allris/")).toBe(true);
    }
    const urls = documents.map((d) => d.sourceUrl).join(" ");
    expect(urls).not.toContain("169.254.169.254");
    expect(urls).not.toContain("attacker.example");
    expect(urls).not.toContain("javascript:");
    expect(urls).not.toContain("data:");
    expect(urls).not.toContain("file:");
    expect(urls).not.toContain("/intern/");
  });

  it("ignoriert ein <base href> auf fremder Origin (Fallback <baseUrl>/allris/)", () => {
    expect(TO010_HOSTILE).toContain('<base href="https://attacker.example/allris/" />');

    const { meta, documents } = parseTo010(TO010_HOSTILE, BASE, "4021");
    // Der relative href löst gegen die eigene Installation auf, nicht gegen das <base>.
    expect(documents[0].sourceUrl).toContain("https://www.taunusstein.de/allris/");
    // Auch die Sitzungs-URL selbst bleibt auf der eigenen Origin.
    expect(meta.sourceUrl).toBe("https://www.taunusstein.de/allris/to010?SILFDNR=4021");
  });

  it("isAllowedRisUrl: Positivliste beim Scheme, harte Origin- und Pfadprüfung", () => {
    const erlaubt = [
      "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
      "https://www.taunusstein.de/allris/wicket/resource/org.apache.wicket.Application/doc1.pdf",
    ];
    for (const url of erlaubt) expect(isAllowedRisUrl(url, BASE)).toBe(true);

    const verboten = [
      "http://169.254.169.254/allris/to020?TOLFDNR=1",
      "https://attacker.example/allris/to020?TOLFDNR=1",
      "https://www.taunusstein.de.attacker.example/allris/to020",
      "https://www.taunusstein.de:8443/allris/to020", // anderer Port = andere Origin
      "http://www.taunusstein.de/allris/to020", // anderes Schema = andere Origin
      "https://www.taunusstein.de/intern/to020", // außerhalb /allris/
      "https://www.taunusstein.de/allrisx/to020", // Präfix ohne Trennstrich
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "file:///etc/passwd",
      "gopher://www.taunusstein.de/allris/",
      "kein-url",
    ];
    for (const url of verboten) expect(isAllowedRisUrl(url, BASE)).toBe(false);
  });

  it("fetchMeeting ruft keine URL außerhalb der Installation ab (zweite Schranke)", async () => {
    const angefragt: string[] = [];
    const fetchStub = async (url: string) => {
      angefragt.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => TO010_HOSTILE,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: true,
    });

    await adapter.fetchMeeting({
      externalId: "4021",
      sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
    });

    for (const url of angefragt) {
      expect(url.startsWith("https://www.taunusstein.de/allris/")).toBe(true);
    }
    expect(angefragt.join(" ")).not.toContain("attacker.example");
  });

  it("fetchMeeting weist auch eine manipulierte Einstiegs-URL ab", async () => {
    const angefragt: string[] = [];
    const fetchStub = async (url: string) => {
      angefragt.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => TO010,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: false,
    });

    // sourceUrl kommt aus der DB und kann aus einem früheren Import stammen.
    await expect(
      adapter.fetchMeeting({
        externalId: "4021",
        sourceUrl: "http://169.254.169.254/allris/to010?SILFDNR=4021",
      })
    ).rejects.toThrow(/außerhalb der erlaubten ALLRIS-Installation/);
    expect(angefragt).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ReDoS und Obergrenzen
// ---------------------------------------------------------------------------

describe("parseTo010 — Robustheit gegen feindlich großes HTML", () => {
  it("REGRESSION (ReDoS): echte Fixture + 1200 angehängte <a href=\"x\" bleibt < 1 s", () => {
    // Das Vorgängermuster hatte zwei freie [^>]* um eine Gruppe:
    // /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
    // Gemessen: Fixture allein 16 ms, mit diesem Payload 10 643 ms (kubisch).
    const payload = TO010 + '<a href="x"'.repeat(1200);
    const start = performance.now();
    const { documents } = parseTo010(payload, BASE, SILFDNR);
    const dauer = performance.now() - start;

    expect(dauer).toBeLessThan(1000);
    // Und das Parsen bleibt korrekt: die echten Dokumente sind weiterhin da.
    expect(documents.filter((d) => d.docType === "top")).toHaveLength(9);
  });

  it("schneidet HTML jenseits der Hartgrenze ab und warnt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseTo010(TO010 + " ".repeat(2_000_000), BASE, SILFDNR);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("abgeschnitten"));
  });

  // -------------------------------------------------------------------------
  // Rahmen statt Regex-Chirurgie: Größengrenze + Wall-Clock-Budget
  // -------------------------------------------------------------------------
  //
  // matchLinks (indexOf/slice bis Dateiende je <a>) und extractHeadline
  // (globales [\s\S]*?) sind in der Eingabegröße quadratisch. Die Muster werden
  // bewusst NICHT weiter umgebaut; abgesichert wird der Rahmen: 512 KB Grenze
  // und 5 s Budget, beides mit lautem Abbruch.

  it("MAX_HTML_BYTES liegt bei 512 KB — echte Seiten (~115 KB) haben Faktor 4 Luft", () => {
    expect(MAX_HTML_BYTES).toBe(512_000);
    // Gemessen: 468 KB = 77 s. Mit der alten 2-MB-Grenze wären es ~1300 s.
    expect(TO010.length).toBeLessThan(MAX_HTML_BYTES / 4);
  });

  it("echte Fixture parst korrekt und weit unter dem Zeitbudget", () => {
    const start = performance.now();
    const { meta, documents } = parseTo010(TO010, BASE, SILFDNR);
    const dauer = performance.now() - start;

    // Korrektheit: dieselben Zusicherungen wie im Normalfall.
    expect(meta.gremium).toBe("Ortsbeirat Bleidenstadt");
    expect(meta.meetingDate?.toISOString()).toBe("2017-04-05T17:30:00.000Z");
    expect(documents).toHaveLength(17);
    // „Deutlich unter Budget": eine Größenordnung Abstand zu MAX_PARSE_MS.
    // Real gemessen liegt die Seite im zweistelligen Millisekundenbereich; die
    // Schwelle ist bewusst großzügig, damit langsame CI-Runner nicht flackern.
    expect(dauer).toBeLessThan(MAX_PARSE_MS / 10);
  });

  it("Zeitbudget: bricht LAUT ab, mit Sitzungs-ID, statt unbegrenzt zu parsen", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Budget 0 ms = sofort aufgebraucht. Testet den Abbruchpfad deterministisch,
    // ohne auf die echten 5 s warten zu müssen.
    const { meta, documents } = parseTo010(TO010, BASE, SILFDNR, BASE, 0);

    // Kein stiller Abbruch: Warnung nennt Budget UND Sitzung.
    const gemeldet = warn.mock.calls.flat().join(" ");
    expect(gemeldet).toContain("Zeitbudget");
    expect(gemeldet).toContain("abgebrochen");
    expect(gemeldet).toContain(`to010?SILFDNR=${SILFDNR}`);
    expect(gemeldet).toContain("unvollständig");

    // Rückgabe ist das bis dahin Ermittelte: keine Link-Dokumente mehr, die
    // label-basierten Grunddaten (ohne quadratischen Pfad) bleiben.
    expect(documents).toEqual([]);
    expect(meta.externalId).toBe(SILFDNR);
    expect(meta.gremium).toBe("Ortsbeirat Bleidenstadt");
  });

  it("Zeitbudget warnt genau einmal je Parse-Vorgang, nicht je Schleifendurchlauf", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseTo010(TO010, BASE, SILFDNR, BASE, 0);
    const budgetWarnungen = warn.mock.calls
      .flat()
      .filter((arg) => typeof arg === "string" && arg.includes("Zeitbudget"));
    expect(budgetWarnungen).toHaveLength(1);
  });

  it("Zeitbudget greift auch in parseTo020 (Panel-Suche über matchLinks)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseTo020(TO020, 0);

    expect(warn.mock.calls.flat().join(" ")).toContain("Zeitbudget");
    expect(result.beschluss).toBeUndefined();
  });

  it("deckelt die Dokumentzahl bei MAX_DOCS und warnt laut", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let html = "<html><body>";
    for (let i = 1; i <= 500; i++) {
      html += `<a href="/allris/to020?TOLFDNR=${i}">TOP ${i}</a>`;
    }
    html += "</body></html>";

    const { documents } = parseTo010(html, BASE, SILFDNR);

    expect(documents).toHaveLength(MAX_DOCS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Obergrenze von ${MAX_DOCS} Dokumenten erreicht`)
    );
    expect(warn.mock.calls.flat().join(" ")).toContain("470 weitere");
  });
});

// ---------------------------------------------------------------------------
// parseTo020 (TOP-Details mit Beschluss und Abstimmung)
// ---------------------------------------------------------------------------

// HINWEIS: parseTo020 ist STILLGELEGT (kein Aufrufer im Produktivpfad, siehe
// Kommentarblock in allris.ts). Die folgenden Tests dokumentieren weiterhin das
// Parsing — sie sind die Grundlage einer späteren, eindeutigen Extraktion. Dass
// der Adapter das Ergebnis NICHT ausliefert, sichert der Test
// „liefert für TOPs keinen bodyText" weiter unten zu.
describe("parseTo020 (echte ALLRIS-4-Seite, TOLFDNR 1026743) — stillgelegt", () => {
  it("parst den Beschlusstext aus dem Word-Export-Panel", () => {
    const { beschluss } = parseTo020(TO020);
    expect(beschluss).toBeDefined();
    expect(beschluss).toContain("Haushaltssatzung der Stadt Taunusstein");
    expect(beschluss).toContain("Investitionsprogramm");
    // Es gibt weder <h3>Beschlusstext</h3> noch "Ja-Stimmen:" auf der echten Seite.
    expect(TO020).not.toContain("Beschlusstext</h3>");
    expect(TO020).not.toContain("Ja-Stimmen:");
  });

  it("parst die Abstimmung 25 / 8 / 0 (Dafür / Dagegen / Enthaltungen)", () => {
    const { votes, abstimmung } = parseTo020(TO020);
    expect(votes).toEqual({ dafuer: 25, dagegen: 8, enthaltungen: 0 });
    expect(abstimmung).toBe(
      "Dafür: 25, Dagegen: 8, Enthaltungen: 0, Ergebnis: ungeändert beschlossen"
    );
  });

  it("liest die Beschlussart aus den Grunddaten", () => {
    const { beschlussart } = parseTo020(TO020);
    expect(beschlussart).toBe("ungeändert beschlossen");
  });

  it("hält die Stimmen-Tabelle in einer Zeile (Digest liest sonst nur das Label)", () => {
    const { beschluss } = parseTo020(TO020);
    expect(beschluss).toContain("Abstimmung: Dafür: 25 Dagegen: 8 Enthaltungen: 0");
  });

  it("gibt undefined zurück für fehlende Felder", () => {
    const result = parseTo020("<html></html>");
    expect(result.beschluss).toBeUndefined();
    expect(result.abstimmung).toBeUndefined();
    expect(result.beschlussart).toBeUndefined();
    expect(result.votes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AllrisAdapter mit Fetch-Stub
// ---------------------------------------------------------------------------

describe("AllrisAdapter (Fetch-Stub)", () => {
  function makeFetchStub(responses: Record<string, string>) {
    return async (url: string) => {
      const body = responses[url] ?? (url.includes("/to020?") ? TO020 : undefined);
      if (body === undefined) throw new Error(`Unexpected URL in test: ${url}`);
      return {
        ok: true,
        status: 200,
        text: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
  }

  it("listRecentMeetings gibt bekannte SILFDNRs zurück", async () => {
    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021", "1026743"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: makeFetchStub({}) as any,
      downloadPdfs: false,
    });

    const meetings = await adapter.listRecentMeetings();
    expect(meetings.length).toBe(2);
    expect(meetings[0].externalId).toBe("4021");
    expect(meetings[0].sourceUrl).toContain("SILFDNR=4021");
  });

  it("listRecentMeetings warnt bei leerer SILFDNR-Liste", async () => {
    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: makeFetchStub({}) as any,
      downloadPdfs: false,
    });

    const meetings = await adapter.listRecentMeetings();
    expect(meetings).toEqual([]);
  });

  it("fetchMeeting liefert Datum, Gremium und angereicherte TOPs", async () => {
    const fetchStub = makeFetchStub({
      "https://www.taunusstein.de/allris/to010?SILFDNR=4021": TO010,
    });

    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: false,
    });

    const result = await adapter.fetchMeeting({
      externalId: "4021",
      sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
    });

    expect(result.meeting.gremium).toBe("Ortsbeirat Bleidenstadt");
    expect(result.meeting.meetingDate?.toISOString()).toBe("2017-04-05T17:30:00.000Z");
    expect(result.meeting.location).toBeUndefined();
    expect(result.documents).toHaveLength(17);

    const topDocs = result.documents.filter((d) => d.docType === "top");
    expect(topDocs).toHaveLength(9);
    for (const top of topDocs) {
      expect(top.title).toMatch(/^TOP /);
      expect(top.sourceUrl).toContain("/allris/to020?TOLFDNR=");
    }
  });

  it("lädt vo020-Seiten nicht als PDF herunter (sie sind HTML)", async () => {
    // Die PDF-Stubs sind leer → „PDF ohne lesbaren Text"-Warnungen; hier nur Rauschen.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const angefragt: string[] = [];
    const fetchStub = async (url: string) => {
      angefragt.push(url);
      const body = url.includes("/to010?") ? TO010 : TO020;
      return {
        ok: true,
        status: 200,
        text: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: true,
    });

    await adapter.fetchMeeting({
      externalId: "4021",
      sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
    });

    expect(angefragt.filter((u) => u.includes("/vo020?"))).toHaveLength(0);
    expect(angefragt.filter((u) => u.endsWith(".pdf"))).toHaveLength(5);
  });

  it("STILLLEGUNG: liefert für TOPs keinen bodyText und ruft to020 nicht ab", async () => {
    const angefragt: string[] = [];
    const fetchStub = async (url: string) => {
      angefragt.push(url);
      const body = url.includes("/to010?") ? TO010 : TO020;
      return {
        ok: true,
        status: 200,
        text: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: false,
    });

    const result = await adapter.fetchMeeting({
      externalId: "4021",
      sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
    });

    const topDocs = result.documents.filter((d) => d.docType === "top");
    expect(topDocs).toHaveLength(9);
    for (const top of topDocs) {
      // Kein Beschlusstext, kein Abstimmungsergebnis, kein Hash — solange die
      // Extraktion nicht beweisbar eindeutig ist, wird nichts veröffentlicht.
      expect(top.bodyText).toBeUndefined();
      expect(top.contentHash).toBeUndefined();
    }

    // Kein einziger to020-Abruf: der Beschlusstext wird gar nicht erst geholt.
    expect(angefragt.filter((u) => u.includes("/to020?"))).toHaveLength(0);
    expect(angefragt).toEqual(["https://www.taunusstein.de/allris/to010?SILFDNR=4021"]);
  });

  it("PDF ohne lesbaren Text zählt als Fehler und warnt (extractPdfText wirft nicht)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Der Download GELINGT, das PDF ist nur unlesbar: extractPdfText gibt null
    // zurück, ohne zu werfen — der catch greift also nie. Vor dem Fix blieb
    // errorCount 0 und der Import meldete Erfolg mit Exit 0.
    const fetchStub = async () => ({
      ok: true,
      status: 200,
      text: async () => TO010,
      // Kein gültiges PDF → pdf-parse scheitert → extractPdfText liefert null.
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: true,
    });

    const result = await adapter.fetchMeeting({
      externalId: "4021",
      sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
    });

    // 5 PDFs geladen, 5-mal kein Text → 5 Fehler, nicht 0.
    expect(adapter.errorCount).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PDF ohne lesbaren Text"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(".pdf"));
    const pdfs = result.documents.filter((d) => d.sourceUrl.endsWith(".pdf"));
    expect(pdfs).toHaveLength(5);
    for (const pdf of pdfs) expect(pdf.bodyText ?? null).toBeNull();
  });

  it("verschluckt fehlgeschlagene Dokument-Downloads nicht: warnt und zählt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = async (url: string) => {
      if (url.endsWith(".pdf")) throw new Error("HTTP 500");
      return {
        ok: true,
        status: 200,
        text: async () => TO010,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const adapter = new AllrisAdapter({
      baseUrl: BASE,
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: true,
    });

    const result = await adapter.fetchMeeting({
      externalId: "4021",
      sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
    });

    // 5 PDFs, alle fehlgeschlagen → 5 Warnungen, errorCount 5.
    expect(adapter.errorCount).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(".pdf"));
    // Die Dokumente bleiben als Metadaten erhalten, aber OHNE bodyText —
    // ris-import darf einen früher importierten Text damit nicht überschreiben.
    const pdfs = result.documents.filter((d) => d.sourceUrl.endsWith(".pdf"));
    expect(pdfs).toHaveLength(5);
    for (const pdf of pdfs) expect(pdf.bodyText).toBeUndefined();
  });
});
