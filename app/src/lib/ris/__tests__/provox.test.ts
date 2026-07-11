/**
 * provox.test.ts — Tests für den Provox-IIP-Adapter (M7)
 *
 * KEINE Live-HTTP-Requests — Fixtures aus __fixtures__/
 * Testet: parseMeetingList, parseMeetingDetail, fetchMeeting (mit Stub)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMeetingList, parseMeetingDetail } from "../provox.js";
import { ProvoxAdapter } from "../provox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../__fixtures__");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

// ---------------------------------------------------------------------------
// parseMeetingList
// ---------------------------------------------------------------------------

describe("parseMeetingList", () => {
  it("parst Meetings aus der Sitzungsliste-HTML", () => {
    const html = loadFixture("provox-meeting-list.html");
    const meetings = parseMeetingList(html, "https://www.rheingau-taunus.de");

    expect(meetings.length).toBeGreaterThanOrEqual(2);

    const kreistag = meetings.find((m) => m.externalId === "3452");
    expect(kreistag).toBeDefined();
    expect(kreistag!.gremium).toContain("Kreistag");
    expect(kreistag!.sourceUrl).toBe("https://www.rheingau-taunus.de/ris/rtk/meeting/details/3452");
  });

  it("parst das Datum korrekt", () => {
    const html = loadFixture("provox-meeting-list.html");
    const meetings = parseMeetingList(html, "https://www.rheingau-taunus.de");

    const kreistag = meetings.find((m) => m.externalId === "3452");
    expect(kreistag?.meetingDate).toBeInstanceOf(Date);
    expect(kreistag?.meetingDate?.getFullYear()).toBe(2026);
    expect(kreistag?.meetingDate?.getMonth()).toBe(4); // Mai = 4 (0-indexed)
    expect(kreistag?.meetingDate?.getDate()).toBe(12);
  });

  it("gibt leere Liste für leeres HTML zurück", () => {
    const meetings = parseMeetingList("<html></html>", "https://example.com");
    expect(meetings).toEqual([]);
  });

  it("ignoriert Zeilen ohne Details-Link", () => {
    const html = `<tr><td>Keine Links hier</td></tr>`;
    const meetings = parseMeetingList(html, "https://example.com");
    expect(meetings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseMeetingDetail
// ---------------------------------------------------------------------------

describe("parseMeetingDetail", () => {
  it("parst Gremium, Datum und Ort aus Detail-Seite", () => {
    const html = loadFixture("provox-meeting-detail.html");
    const { meta } = parseMeetingDetail(
      html,
      "https://www.rheingau-taunus.de",
      "3452"
    );

    expect(meta.gremium).toBe("Kreistag");
    expect(meta.location).toContain("Bad Schwalbach");
    expect(meta.meetingDate).toBeInstanceOf(Date);
    expect(meta.meetingDate?.getFullYear()).toBe(2026);
  });

  it("extrahiert Sitzungsdateien (Einladung, Protokoll)", () => {
    const html = loadFixture("provox-meeting-detail.html");
    const { documents } = parseMeetingDetail(
      html,
      "https://www.rheingau-taunus.de",
      "3452"
    );

    const einladung = documents.find((d) => d.docType === "einladung");
    const protokoll = documents.find((d) => d.docType === "protokoll");

    expect(einladung).toBeDefined();
    expect(einladung?.sourceUrl).toContain("/file/getfile/52402");

    expect(protokoll).toBeDefined();
    expect(protokoll?.sourceUrl).toContain("/file/getfile/52668");
  });

  it("extrahiert Vorlagen-Links aus Tagesordnung", () => {
    const html = loadFixture("provox-meeting-detail.html");
    const { documents } = parseMeetingDetail(
      html,
      "https://www.rheingau-taunus.de",
      "3452"
    );

    const vorlagen = documents.filter(
      (d) => d.docType === "vorlage" || d.externalId === "52204" || d.externalId === "52300"
    );
    expect(vorlagen.length).toBeGreaterThan(0);
  });

  it("alle sourceUrls sind absolute URLs", () => {
    const html = loadFixture("provox-meeting-detail.html");
    const { documents } = parseMeetingDetail(
      html,
      "https://www.rheingau-taunus.de",
      "3452"
    );

    for (const doc of documents) {
      expect(doc.sourceUrl).toMatch(/^https?:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// ProvoxAdapter mit Fetch-Stub
// ---------------------------------------------------------------------------

describe("ProvoxAdapter (Fetch-Stub)", () => {
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

  it("listRecentMeetings gibt Meetings aus Fixture zurück", async () => {
    const listHtml = loadFixture("provox-meeting-list.html");
    const fetchStub = makeFetchStub({
      "https://www.rheingau-taunus.de/ris/rtk/meeting/list": listHtml,
    });

    const adapter = new ProvoxAdapter({
      baseUrl: "https://www.rheingau-taunus.de",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: false,
    });

    const meetings = await adapter.listRecentMeetings();
    expect(meetings.length).toBeGreaterThanOrEqual(2);
    expect(meetings.some((m) => m.externalId === "3452")).toBe(true);
  });

  it("fetchMeeting gibt Meeting + Dokumente zurück", async () => {
    const detailHtml = loadFixture("provox-meeting-detail.html");
    const fetchStub = makeFetchStub({
      "https://www.rheingau-taunus.de/ris/rtk/meeting/details/3452": detailHtml,
    });

    const adapter = new ProvoxAdapter({
      baseUrl: "https://www.rheingau-taunus.de",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      downloadPdfs: false,
    });

    const ref = {
      externalId: "3452",
      sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/meeting/details/3452",
    };

    const result = await adapter.fetchMeeting(ref);
    expect(result.meeting.gremium).toBe("Kreistag");
    expect(result.documents.length).toBeGreaterThan(0);

    const einladung = result.documents.find((d) => d.docType === "einladung");
    expect(einladung).toBeDefined();
  });
});
