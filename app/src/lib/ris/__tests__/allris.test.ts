/**
 * allris.test.ts — Tests für den ALLRIS-4-Adapter (M7)
 *
 * KEINE Live-HTTP-Requests — Fixtures aus __fixtures__/
 * Testet: parseTo010, parseTo020, AllrisAdapter mit Stub
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTo010, parseTo020 } from "../allris.js";
import { AllrisAdapter } from "../allris.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../__fixtures__");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

// ---------------------------------------------------------------------------
// parseTo010 (Sitzung/Tagesordnung)
// ---------------------------------------------------------------------------

describe("parseTo010", () => {
  it("parst Gremium und Datum aus to010-Seite", () => {
    const html = loadFixture("allris-to010.html");
    const { meta } = parseTo010(html, "https://www.taunusstein.de", "4021");

    expect(meta.gremium).toContain("Stadtverordnetenversammlung");
    expect(meta.meetingDate).toBeInstanceOf(Date);
    expect(meta.meetingDate?.getFullYear()).toBe(2025);
    expect(meta.meetingDate?.getMonth()).toBe(11); // Dezember = 11
    expect(meta.meetingDate?.getDate()).toBe(11);
  });

  it("extrahiert TOP-Links (to020?TOLFDNR=...)", () => {
    const html = loadFixture("allris-to010.html");
    const { documents } = parseTo010(html, "https://www.taunusstein.de", "4021");

    const tops = documents.filter((d) => d.docType === "top");
    expect(tops.length).toBeGreaterThan(0);
    expect(tops[0].sourceUrl).toContain("/allris/to020?TOLFDNR=");
  });

  it("extrahiert Vorlagen-Links (vo020?VOLFDNR=...)", () => {
    const html = loadFixture("allris-to010.html");
    const { documents } = parseTo010(html, "https://www.taunusstein.de", "4021");

    const vorlagen = documents.filter((d) => d.docType === "vorlage");
    expect(vorlagen.length).toBeGreaterThan(0);
  });

  it("extrahiert PDF-Links (wicket/resource)", () => {
    const html = loadFixture("allris-to010.html");
    const { documents } = parseTo010(html, "https://www.taunusstein.de", "4021");

    const pdfs = documents.filter((d) => d.docType === "einladung" || d.docType === "protokoll");
    expect(pdfs.length).toBeGreaterThan(0);
    expect(pdfs[0].sourceUrl).toContain("/allris/wicket/resource/");
  });

  it("alle sourceUrls sind absolute URLs", () => {
    const html = loadFixture("allris-to010.html");
    const { documents } = parseTo010(html, "https://www.taunusstein.de", "4021");

    for (const doc of documents) {
      expect(doc.sourceUrl).toMatch(/^https?:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// parseTo020 (TOP-Details mit Beschluss)
// ---------------------------------------------------------------------------

describe("parseTo020", () => {
  it("parst Beschlusstext aus to020-Seite", () => {
    const html = loadFixture("allris-to020.html");
    const { beschluss } = parseTo020(html);

    expect(beschluss).toBeDefined();
    expect(beschluss).toContain("Stadtverordnetenversammlung");
    expect(beschluss).toContain("Haushaltssatzung");
  });

  it("parst Abstimmungsergebnis", () => {
    const html = loadFixture("allris-to020.html");
    const { abstimmung } = parseTo020(html);

    expect(abstimmung).toBeDefined();
    expect(abstimmung).toContain("Ja: 28");
    expect(abstimmung).toContain("Nein: 7");
    expect(abstimmung).toContain("angenommen");
  });

  it("gibt undefined zurück für fehlende Felder", () => {
    const { beschluss, abstimmung } = parseTo020("<html></html>");
    expect(beschluss).toBeUndefined();
    expect(abstimmung).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AllrisAdapter mit Fetch-Stub
// ---------------------------------------------------------------------------

describe("AllrisAdapter (Fetch-Stub)", () => {
  function makeFetchStub(responses: Record<string, string>) {
    return async (url: string) => {
      const body = responses[url];
      if (!body) throw new Error(`Unexpected URL in test: ${url}`);
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
      baseUrl: "https://www.taunusstein.de",
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
      baseUrl: "https://www.taunusstein.de",
      knownSilfdnrs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: makeFetchStub({}) as any,
      downloadPdfs: false,
    });

    const meetings = await adapter.listRecentMeetings();
    expect(meetings).toEqual([]);
  });

  it("fetchMeeting lädt to010 und enrichiert mit TOP-Details", async () => {
    const to010Html = loadFixture("allris-to010.html");
    const to020Html = loadFixture("allris-to020.html");

    const to020Url1 = "https://www.taunusstein.de/allris/to020?TOLFDNR=1026743";
    const to020Url2 = "https://www.taunusstein.de/allris/to020?TOLFDNR=1026750";

    const fetchStub = makeFetchStub({
      "https://www.taunusstein.de/allris/to010?SILFDNR=4021": to010Html,
      [to020Url1]: to020Html,
      [to020Url2]: to020Html,
    });

    const adapter = new AllrisAdapter({
      baseUrl: "https://www.taunusstein.de",
      knownSilfdnrs: ["4021"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: false,
    });

    const ref = {
      externalId: "4021",
      sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
    };

    const result = await adapter.fetchMeeting(ref);
    expect(result.meeting.gremium).toContain("Stadtverordnetenversammlung");
    expect(result.documents.length).toBeGreaterThan(0);

    // TOP-Dokumente sollten bodyText haben
    const topDocs = result.documents.filter(
      (d) => d.docType === "top" && d.bodyText
    );
    expect(topDocs.length).toBeGreaterThan(0);
    expect(topDocs[0].bodyText).toContain("Haushaltssatzung");
  });
});
