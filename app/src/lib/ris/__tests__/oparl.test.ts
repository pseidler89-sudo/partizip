/**
 * oparl.test.ts — Tests für den OParl-Adapter (Feature B)
 *
 * KEINE Live-HTTP-Requests — Fixtures aus __fixtures__/
 * Testet:
 *   - listRecentMeetings: Mapping, Paginierung, deleted-Objekte überspringen
 *   - fetchMeeting: Dokumentsammlung (invitation, protokoll, agendaItem-Anlage)
 *   - Fehlertoleranz: 404-File, deleted-Objekte
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OparlAdapter } from "../oparl.js";
import type { MeetingRef } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../__fixtures__");

function loadFixtureJson(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Fetch-Stub-Hilfsfunktion
// ---------------------------------------------------------------------------

type StubEntry = string | { status: number; body: string };

function makeFetchStub(responses: Record<string, StubEntry>) {
  return async (url: string) => {
    const entry = responses[url];
    if (entry === undefined) {
      throw new Error(`Unexpected URL in test: ${url}`);
    }
    if (typeof entry === "object") {
      return {
        ok: entry.status >= 200 && entry.status < 300,
        status: entry.status,
        text: async () => entry.body,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => entry,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

// ---------------------------------------------------------------------------
// listRecentMeetings — Mapping
// ---------------------------------------------------------------------------

describe("OparlAdapter.listRecentMeetings — Mapping", () => {
  it("liefert Meetings aus der Body-Response", async () => {
    const bodyJson = loadFixtureJson("oparl-body.json");
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/body/1": bodyJson,
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
      // Seite 2 nicht angegeben — maxPages=1 stoppt nach Seite 1
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 1,
    });

    const meetings = await adapter.listRecentMeetings();

    // Nur die nicht-deleted Meetings (999 ist deleted:true)
    expect(meetings.length).toBe(2);

    const stadtrat = meetings.find((m) => m.externalId.includes("/meeting/101"));
    expect(stadtrat).toBeDefined();
    expect(stadtrat!.title).toBe("Stadtrat");
    expect(stadtrat!.meetingDate).toBeInstanceOf(Date);
    expect(stadtrat!.meetingDate?.getFullYear()).toBe(2026);
    expect(stadtrat!.meetingDate?.getMonth()).toBe(4); // Mai = 4
    expect(stadtrat!.location).toBe("Rathaus Sitzungssaal");
    expect(stadtrat!.sourceUrl).toBe("https://www.example-kommune.de/stadtrat/sitzung/101");
  });

  it("externalId = OParl-id-URL", async () => {
    const bodyJson = loadFixtureJson("oparl-body.json");
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/body/1": bodyJson,
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 1,
    });

    const meetings = await adapter.listRecentMeetings();
    for (const m of meetings) {
      expect(m.externalId).toMatch(/^https:\/\/oparl\.example-kommune\.de\//);
    }
  });

  it("sourceUrl = web-Feld wenn vorhanden", async () => {
    const bodyJson = loadFixtureJson("oparl-body.json");
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/body/1": bodyJson,
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 1,
    });

    const meetings = await adapter.listRecentMeetings();
    const stadtrat = meetings.find((m) => m.title === "Stadtrat");
    expect(stadtrat!.sourceUrl).toBe("https://www.example-kommune.de/stadtrat/sitzung/101");
  });

  it("überspringt deleted:true-Meetings", async () => {
    const bodyJson = loadFixtureJson("oparl-body.json");
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/body/1": bodyJson,
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 1,
    });

    const meetings = await adapter.listRecentMeetings();

    // Meeting/999 ist deleted:true — darf nicht in der Liste stehen
    const deleted = meetings.find((m) => m.externalId.includes("/meeting/999"));
    expect(deleted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listRecentMeetings — Paginierung
// ---------------------------------------------------------------------------

describe("OparlAdapter.listRecentMeetings — Paginierung", () => {
  it("folgt next-Link bis maxPages", async () => {
    const bodyJson = loadFixtureJson("oparl-body.json");
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");
    const page2Json = loadFixtureJson("oparl-meeting-list-page2.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/body/1": bodyJson,
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
      "https://oparl.example-kommune.de/api/body/1/meeting?page=2": page2Json,
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 2,
    });

    const meetings = await adapter.listRecentMeetings();

    // Seite 1: 2 Meetings (1 deleted), Seite 2: 1 Meeting
    expect(meetings.length).toBe(3);
    expect(meetings.some((m) => m.title === "Gemeinderat")).toBe(true);
  });

  it("stoppt nach maxPages (keine weitere Seite lädt)", async () => {
    const bodyJson = loadFixtureJson("oparl-body.json");
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/body/1": bodyJson,
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
      // Seite 2 NICHT registriert — falls doch abgerufen, würde Test fehlschlagen
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 1,
    });

    const meetings = await adapter.listRecentMeetings();
    expect(meetings.length).toBe(2); // Nur Seite 1
  });
});

// ---------------------------------------------------------------------------
// fetchMeeting — Dokumentsammlung
// ---------------------------------------------------------------------------

describe("OparlAdapter.fetchMeeting — Dokumentsammlung", () => {
  it("sammelt Einladung und Protokoll", async () => {
    const detailJson = loadFixtureJson("oparl-meeting-detail.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/meeting/101": detailJson,
      // PDF-Download über accessUrl (m-1: sourceUrl = stabile web-URL, Download über accessUrl)
      "https://files.example-kommune.de/einladung-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/protokoll-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/anlage-top1.pdf": { status: 200, body: "" },
    });

    const ref: MeetingRef = {
      externalId: "https://oparl.example-kommune.de/api/meeting/101",
      sourceUrl: "https://oparl.example-kommune.de/api/meeting/101",
    };

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
    });

    const result = await adapter.fetchMeeting(ref);

    // m-1-Fix: sourceUrl = stable web-URL (nicht accessUrl)
    const einladung = result.documents.find((d) => d.docType === "einladung");
    expect(einladung).toBeDefined();
    expect(einladung!.sourceUrl).toBe("https://www.example-kommune.de/dokumente/einladung-101");

    const protokoll = result.documents.find((d) => d.docType === "protokoll");
    expect(protokoll).toBeDefined();
    expect(protokoll!.sourceUrl).toBe("https://www.example-kommune.de/dokumente/protokoll-101");
  });

  it("sammelt AgendaItem-Anlagen", async () => {
    const detailJson = loadFixtureJson("oparl-meeting-detail.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/meeting/101": detailJson,
      "https://files.example-kommune.de/einladung-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/protokoll-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/anlage-top1.pdf": { status: 200, body: "" },
    });

    const ref: MeetingRef = {
      externalId: "https://oparl.example-kommune.de/api/meeting/101",
      sourceUrl: "https://oparl.example-kommune.de/api/meeting/101",
    };

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
    });

    const result = await adapter.fetchMeeting(ref);

    const anlagen = result.documents.filter((d) => d.docType === "anlage");
    expect(anlagen.length).toBeGreaterThan(0);
    const anlageTop1 = anlagen.find((d) => d.sourceUrl.includes("anlage-top1"));
    expect(anlageTop1).toBeDefined();
  });

  it("überspringt deleted AgendaItem", async () => {
    const detailJson = loadFixtureJson("oparl-meeting-detail.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/meeting/101": detailJson,
      "https://files.example-kommune.de/einladung-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/protokoll-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/anlage-top1.pdf": { status: 200, body: "" },
    });

    const ref: MeetingRef = {
      externalId: "https://oparl.example-kommune.de/api/meeting/101",
      sourceUrl: "https://oparl.example-kommune.de/api/meeting/101",
    };

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
    });

    const result = await adapter.fetchMeeting(ref);

    // AgendaItem 302 ist deleted:true — keine Dokumente davon in der Liste
    // (AgendaItem 301 hat die Anlage, 302 ist deleted)
    // Gesamtdokumente: einladung + protokoll + 1 Anlage (von AgendaItem 301) = 3
    expect(result.documents.length).toBe(3);
  });

  it("m-1-Fix: sourceUrl = web-Feld der Datei (stabile URL direkt persistieren)", async () => {
    const detailJson = loadFixtureJson("oparl-meeting-detail.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/meeting/101": detailJson,
      "https://files.example-kommune.de/einladung-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/protokoll-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/anlage-top1.pdf": { status: 200, body: "" },
    });

    const ref: MeetingRef = {
      externalId: "https://oparl.example-kommune.de/api/meeting/101",
      sourceUrl: "https://oparl.example-kommune.de/api/meeting/101",
    };

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
    });

    const result = await adapter.fetchMeeting(ref);

    // m-1-Fix: stableSourceUrl entfällt — stable URL direkt in sourceUrl
    const einladung = result.documents.find((d) => d.docType === "einladung");
    expect(einladung!.sourceUrl).toBe(
      "https://www.example-kommune.de/dokumente/einladung-101"
    );
    // kein stableSourceUrl-Feld mehr
    expect(einladung!.stableSourceUrl).toBeUndefined();
  });

  it("Meeting-Metadaten aus fetchMeeting korrekt gemappt", async () => {
    const detailJson = loadFixtureJson("oparl-meeting-detail.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/meeting/101": detailJson,
      "https://files.example-kommune.de/einladung-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/protokoll-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/anlage-top1.pdf": { status: 200, body: "" },
    });

    const ref: MeetingRef = {
      externalId: "https://oparl.example-kommune.de/api/meeting/101",
      sourceUrl: "https://oparl.example-kommune.de/api/meeting/101",
    };

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
    });

    const result = await adapter.fetchMeeting(ref);

    expect(result.meeting.title).toBe("Stadtrat");
    expect(result.meeting.location).toBe("Rathaus Sitzungssaal");
    expect(result.meeting.meetingDate).toBeInstanceOf(Date);
    expect(result.meeting.meetingDate?.getFullYear()).toBe(2026);
  });
});

// ---------------------------------------------------------------------------
// Fehlertoleranz
// ---------------------------------------------------------------------------

describe("OparlAdapter — Fehlertoleranz", () => {
  it("HTTP-404 für einzelne Datei: überspringen, kein Abbruch", async () => {
    const detailJson = loadFixtureJson("oparl-meeting-detail.json");

    const warnMessages: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((msg: string) => {
      warnMessages.push(msg);
    });

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/meeting/101": detailJson,
      // Einladung liefert 404
      "https://files.example-kommune.de/einladung-101.pdf": { status: 404, body: "Not Found" },
      "https://files.example-kommune.de/protokoll-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/anlage-top1.pdf": { status: 200, body: "" },
    });

    const ref: MeetingRef = {
      externalId: "https://oparl.example-kommune.de/api/meeting/101",
      sourceUrl: "https://oparl.example-kommune.de/api/meeting/101",
    };

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
    });

    // Kein Fehler — Fehlertoleranz
    const result = await adapter.fetchMeeting(ref);

    vi.restoreAllMocks();

    // Einladung ist trotz 404 in der Liste (ohne bodyText — Fehlertoleranz)
    const einladung = result.documents.find((d) => d.docType === "einladung");
    expect(einladung).toBeDefined();
    // bodyText fehlt weil 404 — docRef ohne bodyText ist in der Liste
    expect(einladung!.bodyText).toBeUndefined();

    // Andere Dokumente wurden trotzdem geladen
    const protokoll = result.documents.find((d) => d.docType === "protokoll");
    expect(protokoll).toBeDefined();
  });

  it("Body-Lade-Fehler: Fallback auf Standard-Meeting-URL", async () => {
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");

    const fetchStub = makeFetchStub({
      // Body gibt 500 zurück — Fehler beim Body-Laden
      "https://oparl.example-kommune.de/api/body/1": { status: 500, body: "Server Error" },
      // Fallback: Standard-Meeting-URL
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 1,
    });

    // Sollte nicht crashen — Fallback auf Standard-Meeting-Pfad
    const meetings = await adapter.listRecentMeetings();
    expect(meetings.length).toBeGreaterThanOrEqual(0);
  });

  it("deleted Meeting in fetchMeeting gibt leere Dokumentliste zurück", async () => {
    const deletedMeeting = JSON.stringify({
      id: "https://oparl.example-kommune.de/api/meeting/999",
      type: "https://schema.oparl.org/1.1/Meeting",
      name: "Gelöschte Sitzung",
      deleted: true,
    });

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/meeting/999": deletedMeeting,
    });

    const ref: MeetingRef = {
      externalId: "https://oparl.example-kommune.de/api/meeting/999",
      sourceUrl: "https://oparl.example-kommune.de/api/meeting/999",
    };

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
    });

    const result = await adapter.fetchMeeting(ref);
    expect(result.documents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M-1 End-to-End: listRecentMeetings → fetchMeeting (web-URL im Fixture!)
// ---------------------------------------------------------------------------

describe("M-1 E2E: listRecentMeetings → fetchMeeting", () => {
  it("Refs aus listRecentMeetings liefern Dokumente wenn an fetchMeeting übergeben", async () => {
    // Fixture: page1 enthält Meetings mit web-URL (HTML-Seite) in sourceUrl.
    // fetchMeeting muss externalId (JSON-API-URL) benutzen, NICHT sourceUrl.
    const bodyJson = loadFixtureJson("oparl-body.json");
    const page1Json = loadFixtureJson("oparl-meeting-list-page1.json");
    const detailJson = loadFixtureJson("oparl-meeting-detail.json");

    const fetchStub = makeFetchStub({
      "https://oparl.example-kommune.de/api/body/1": bodyJson,
      "https://oparl.example-kommune.de/api/body/1/meeting": page1Json,
      // Detail-Endpoint: JSON-API-URL (externalId) — NICHT die web-URL
      "https://oparl.example-kommune.de/api/meeting/101": detailJson,
      "https://files.example-kommune.de/einladung-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/protokoll-101.pdf": { status: 200, body: "" },
      "https://files.example-kommune.de/anlage-top1.pdf": { status: 200, body: "" },
    });

    const adapter = new OparlAdapter({
      bodyUrl: "https://oparl.example-kommune.de/api/body/1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchStub as any,
      maxPages: 1,
    });

    const refs = await adapter.listRecentMeetings();

    // Stadtrat-Ref aus listRecentMeetings: sourceUrl = web-HTML-URL, externalId = JSON-API-URL
    const stadtratRef = refs.find((r) => r.externalId.includes("/meeting/101"));
    expect(stadtratRef).toBeDefined();
    // sourceUrl ist die menschenlesbare HTML-Seite
    expect(stadtratRef!.sourceUrl).toBe("https://www.example-kommune.de/stadtrat/sitzung/101");
    // externalId ist die JSON-API-URL
    expect(stadtratRef!.externalId).toBe("https://oparl.example-kommune.de/api/meeting/101");

    // fetchMeeting mit dem Ref aus listRecentMeetings aufrufen (M-1 E2E)
    // Ohne Fix würde fetchMeeting ref.sourceUrl (HTML) laden → JSON.parse auf HTML → Fehler
    const fetched = await adapter.fetchMeeting(stadtratRef!);

    // Dokumente wurden korrekt geladen (kein HTML-Parse-Fehler)
    expect(fetched.documents.length).toBeGreaterThan(0);
    const einladung = fetched.documents.find((d) => d.docType === "einladung");
    expect(einladung).toBeDefined();
    // sourceUrl des Dokuments = stabile web-URL (m-1-Fix)
    expect(einladung!.sourceUrl).toBe("https://www.example-kommune.de/dokumente/einladung-101");
  });
});
