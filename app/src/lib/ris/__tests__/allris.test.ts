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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTo010, parseTo020, AllrisAdapter } from "../allris.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../__fixtures__");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

const TO010 = loadFixture("allris-to010-real.html");
const TO020 = loadFixture("allris-to020-real.html");

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
    // M1(c): stabile Seiten-URL für Digest-Statements
    for (const pdf of pdfs) {
      expect(pdf.stableSourceUrl).toBe(
        "https://www.taunusstein.de/allris/to010?SILFDNR=4021"
      );
    }
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
// parseTo020 (TOP-Details mit Beschluss und Abstimmung)
// ---------------------------------------------------------------------------

describe("parseTo020 (echte ALLRIS-4-Seite, TOLFDNR 1026743)", () => {
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
      expect(top.bodyText).toContain("Haushaltssatzung");
      expect(top.bodyText).toContain("Abstimmung: Dafür: 25, Dagegen: 8, Enthaltungen: 0");
      expect(top.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("lädt vo020-Seiten nicht als PDF herunter (sie sind HTML)", async () => {
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
});
