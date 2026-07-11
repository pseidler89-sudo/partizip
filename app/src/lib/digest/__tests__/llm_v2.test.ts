/**
 * llm_v2.test.ts — Tests für LlmV2Generator und select-generator (M7, Feature A)
 *
 * KEIN Live-HTTP — fetch ist immer injiziert.
 * Testet:
 *   - Happy Path mit gestubbtem fetch
 *   - Ungültige sourceDocumentId → Fehler
 *   - Kaputtes JSON → Fehler
 *   - LLM-gelieferte URLs werden ignoriert (sourceUrl aus Dokument)
 *   - API-Key-Redaction
 *   - select-generator-Matrix (auto ± Key, explizit, llm_v2 ohne Key)
 *   - Fallback-Pfad (llm_v2 wirft → extractive_v1-Ergebnis mit generator="extractive_v1")
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { LlmV2Generator, GENERATOR_NAME as LLM_V2_NAME, sortDocumentsByPriority } from "../llm_v2.js";
import { selectGenerator, generateWithFallback } from "../select-generator.js";
import { ExtractiveV1Generator, GENERATOR_NAME as EXTRACTIVE_NAME } from "../extractive_v1.js";
import type { MeetingInput, DocumentInput } from "../types.js";

// ---------------------------------------------------------------------------
// Test-Fixtures
// ---------------------------------------------------------------------------

const testMeeting: MeetingInput = {
  id: "meet-001",
  gremium: "Kreistag",
  title: "Kreistag",
  meetingDate: new Date("2026-05-12T15:00:00+01:00"),
  location: "Bad Schwalbach",
  sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/meeting/details/3452",
};

const testDocs: DocumentInput[] = [
  {
    id: "doc-vorlage-001",
    docType: "vorlage",
    title: "Haushaltssatzung 2026",
    bodyText: "Die Haushaltssatzung 2026 sieht Ausgaben von 250 Millionen Euro vor.",
    sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/file/getfile/52300",
    externalId: "52300",
  },
  {
    id: "doc-protokoll-001",
    docType: "protokoll",
    title: "Öffentliches Protokoll",
    bodyText: "Das Protokoll der Sitzung liegt vor.",
    sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/file/getfile/52668",
    externalId: "52668",
  },
];

const testDocsWicket: DocumentInput[] = [
  {
    id: "doc-prot-wicket",
    docType: "protokoll",
    title: "Protokoll",
    bodyText: "Protokolltext hier.",
    // Instabile Wicket-URL — darf NICHT in Statements landen
    sourceUrl: "https://www.taunusstein.de/allris/wicket/resource/org.apache.wicket.Application/doc42.pdf",
    externalId: "protokoll:oeffentlich",
  },
];

const testMeetingAllris: MeetingInput = {
  id: "meet-002",
  gremium: "Stadtverordnetenversammlung",
  title: "Stadtverordnetenversammlung",
  meetingDate: new Date("2025-12-11T18:00:00+01:00"),
  location: "Taunusstein",
  sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
};

// ---------------------------------------------------------------------------
// Fetch-Stub-Hilfsfunktion
// ---------------------------------------------------------------------------

function makeAnthropicStub(llmJsonResponse: string) {
  const anthropicEnvelope = JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: llmJsonResponse,
      },
    ],
    model: "claude-haiku-4-5-20251001",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  return async (_url: string, _init: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => anthropicEnvelope,
  });
}

function makeErrorStub(status: number, body: string) {
  return async (_url: string, _init: RequestInit) => ({
    ok: false,
    status,
    text: async () => body,
  });
}

// ---------------------------------------------------------------------------
// Happy Path
// ---------------------------------------------------------------------------

describe("LlmV2Generator — Happy Path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generiert Digest mit gestubbtem fetch", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({
      title: "Kreistag – Sitzung vom 12.05.2026",
      statements: [
        {
          text: "Die Haushaltssatzung 2026 sieht Ausgaben von 250 Millionen Euro vor.",
          sourceDocumentId: "doc-vorlage-001",
        },
        {
          text: "Das öffentliche Protokoll der Sitzung liegt vor.",
          sourceDocumentId: "doc-protokoll-001",
        },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeeting, testDocs);

    expect(draft.generator).toBe(LLM_V2_NAME);
    expect(draft.title).toContain("Kreistag");
    expect(draft.statements.length).toBe(2);
    expect(draft.statements[0].position).toBe(1);
    expect(draft.statements[1].position).toBe(2);
  });

  it("position wird server-seitig nummeriert (1-basiert, sequenziell)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({
      title: "Kreistag – Test",
      statements: [
        { text: "Erste Aussage.", sourceDocumentId: "doc-vorlage-001" },
        { text: "Zweite Aussage.", sourceDocumentId: "doc-protokoll-001" },
        { text: "Dritte Aussage.", sourceDocumentId: "doc-vorlage-001" },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeeting, testDocs);

    expect(draft.statements.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it("jede Aussage hat sourceDocumentId und sourceUrl", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({
      title: "Kreistag – Test",
      statements: [
        { text: "Aussage zur Vorlage.", sourceDocumentId: "doc-vorlage-001" },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeeting, testDocs);

    for (const stmt of draft.statements) {
      expect(stmt.sourceDocumentId).toBeTruthy();
      expect(stmt.sourceUrl).toBeTruthy();
      expect(stmt.sourceUrl).toMatch(/^https?:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// Validierung: sourceDocumentId
// ---------------------------------------------------------------------------

describe("LlmV2Generator — sourceDocumentId-Validierung", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ungültige sourceDocumentId → Fehler (Halluzination abgefangen)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({
      title: "Test",
      statements: [
        {
          text: "Aussage mit halluzinierter Dokument-ID.",
          sourceDocumentId: "halluzinierte-id-die-nicht-existiert",
        },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });

    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /sourceDocumentId.*halluzinierte-id-die-nicht-existiert/
    );
  });

  it("sourceDocumentId muss exakt aus der Eingabeliste stammen", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    // LLM gibt eine fast-richtige ID (mit Leerzeichen) zurück
    const llmResponse = JSON.stringify({
      title: "Test",
      statements: [
        {
          text: "Aussage.",
          sourceDocumentId: " doc-vorlage-001 ", // Leerzeichen vorne/hinten
        },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });

    // Nach trim() wird " doc-vorlage-001 " zu "doc-vorlage-001" — das ist gültig
    const draft = await gen.generate(testMeeting, testDocs);
    expect(draft.statements[0].sourceDocumentId).toBe("doc-vorlage-001");
  });
});

// ---------------------------------------------------------------------------
// Validierung: Kaputtes JSON
// ---------------------------------------------------------------------------

describe("LlmV2Generator — JSON-Validierung", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kaputtes JSON → Fehler", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const anthropicEnvelope = JSON.stringify({
      content: [{ type: "text", text: "Das ist kein JSON {{{" }],
    });

    const stub = async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => anthropicEnvelope,
    });

    const gen = new LlmV2Generator({ fetchFn: stub });

    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /kein gültiges JSON/
    );
  });

  it("fehlendes 'statements'-Feld → Fehler", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({ title: "Test" }); // kein statements
    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });

    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /statements/
    );
  });

  it("leeres statements-Array → Fehler", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({ title: "Test", statements: [] });
    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });

    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /statements.*leer/
    );
  });

  it("zu langer Statement-Text → Fehler", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({
      title: "Test",
      statements: [
        {
          text: "x".repeat(501), // 501 Zeichen — über dem Limit
          sourceDocumentId: "doc-vorlage-001",
        },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });

    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /zu lang/
    );
  });
});

// ---------------------------------------------------------------------------
// sourceUrl — NIEMALS vom LLM übernommen
// ---------------------------------------------------------------------------

describe("LlmV2Generator — sourceUrl aus Dokument (nicht vom LLM)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("LLM-gelieferte URL wird ignoriert — sourceUrl kommt aus Dokument", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    // LLM gibt eine URL-ähnliche Antwort (sollte ignoriert werden — kein sourceUrl-Feld im Schema)
    const llmResponse = JSON.stringify({
      title: "Kreistag – Test",
      statements: [
        {
          text: "Die Haushaltssatzung 2026 wurde beschlossen.",
          sourceDocumentId: "doc-vorlage-001",
          // sourceUrl wird vom LLM mitgeschickt (darf nicht übernommen werden)
          sourceUrl: "https://boes-url-vom-llm.example.com/halluziniert",
        },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeeting, testDocs);

    // sourceUrl muss aus dem Dokument kommen, nicht vom LLM
    const stmt = draft.statements[0];
    expect(stmt.sourceUrl).not.toContain("boes-url-vom-llm.example.com");
    expect(stmt.sourceUrl).toContain("rheingau-taunus.de");
  });

  it("M1(c): Wicket-URL wird durch Meeting-sourceUrl ersetzt", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const llmResponse = JSON.stringify({
      title: "Stadtverordnetenversammlung – Test",
      statements: [
        {
          text: "Das Protokoll liegt vor.",
          sourceDocumentId: "doc-prot-wicket",
        },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeetingAllris, testDocsWicket);

    // Wicket-URL darf NICHT in Statements
    const stmt = draft.statements[0];
    expect(stmt.sourceUrl).not.toContain("/wicket/resource/");
    // Muss die Meeting-sourceUrl (to010-Seite) sein
    expect(stmt.sourceUrl).toBe(testMeetingAllris.sourceUrl);
  });
});

// ---------------------------------------------------------------------------
// API-Key-Redaction
// ---------------------------------------------------------------------------

describe("LlmV2Generator — API-Key-Redaction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("API-Key erscheint nicht in Fehlermeldungen bei HTTP-Fehler", async () => {
    const secretKey = "sk-secret-12345-geheim";
    vi.stubEnv("ANTHROPIC_API_KEY", secretKey);

    const errorStub = makeErrorStub(401, `Unauthorized: invalid key ${secretKey}`);
    const gen = new LlmV2Generator({ fetchFn: errorStub });

    let errorMessage = "";
    try {
      await gen.generate(testMeeting, testDocs);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage).not.toContain(secretKey);
    expect(errorMessage).toContain("***");
  });

  it("Fehler ohne Key ist sicher (kein Crash)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    const stub = async (_url: string, _init: RequestInit) => {
      throw new Error("Netzwerkfehler ohne Key-Erwähnung");
    };

    const gen = new LlmV2Generator({ fetchFn: stub });

    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      "Netzwerkfehler ohne Key-Erwähnung"
    );
  });

  it("wirft Fehler wenn ANTHROPIC_API_KEY fehlt", async () => {
    // Sicherstellen dass der Key nicht gesetzt ist
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub("{}") });

    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /ANTHROPIC_API_KEY/
    );
  });
});

// ---------------------------------------------------------------------------
// Dokument-Priorisierung
// ---------------------------------------------------------------------------

describe("sortDocumentsByPriority", () => {
  it("sortiert nach ADR-009-Priorität (vorlage > protokoll > top > ...)", () => {
    const docs: DocumentInput[] = [
      { id: "a1", docType: "anlage", title: null, bodyText: "x", sourceUrl: "https://ex.com/a", externalId: null },
      { id: "t1", docType: "top", title: null, bodyText: "x", sourceUrl: "https://ex.com/t", externalId: null },
      { id: "v1", docType: "vorlage", title: null, bodyText: "x", sourceUrl: "https://ex.com/v", externalId: null },
      { id: "p1", docType: "protokoll", title: null, bodyText: "x", sourceUrl: "https://ex.com/p", externalId: null },
      { id: "e1", docType: "einladung", title: null, bodyText: "x", sourceUrl: "https://ex.com/e", externalId: null },
    ];

    const sorted = sortDocumentsByPriority(docs);
    expect(sorted[0].docType).toBe("vorlage");
    expect(sorted[1].docType).toBe("protokoll");
    expect(sorted[2].docType).toBe("top");
    expect(sorted[3].docType).toBe("einladung");
    expect(sorted[4].docType).toBe("anlage");
  });
});

// ---------------------------------------------------------------------------
// selectGenerator — Matrix
// ---------------------------------------------------------------------------

describe("selectGenerator", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("auto ohne Key → ExtractiveV1Generator", () => {
    vi.stubEnv("DIGEST_GENERATOR", "auto");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const gen = selectGenerator();
    expect(gen).toBeInstanceOf(ExtractiveV1Generator);
  });

  it("auto mit Key → LlmV2Generator", () => {
    vi.stubEnv("DIGEST_GENERATOR", "auto");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");

    const gen = selectGenerator();
    expect(gen).toBeInstanceOf(LlmV2Generator);
  });

  it("explizit extractive_v1 → immer ExtractiveV1Generator", () => {
    vi.stubEnv("DIGEST_GENERATOR", "extractive_v1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key"); // Key gesetzt, aber ignoriert

    const gen = selectGenerator();
    expect(gen).toBeInstanceOf(ExtractiveV1Generator);
  });

  it("explizit llm_v2 mit Key → LlmV2Generator", () => {
    vi.stubEnv("DIGEST_GENERATOR", "llm_v2");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");

    const gen = selectGenerator();
    expect(gen).toBeInstanceOf(LlmV2Generator);
  });

  it("explizit llm_v2 ohne Key → verständlicher Fehler", () => {
    vi.stubEnv("DIGEST_GENERATOR", "llm_v2");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    expect(() => selectGenerator()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("DIGEST_GENERATOR nicht gesetzt → default 'auto'", () => {
    vi.unstubAllEnvs(); // Reset
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    // DIGEST_GENERATOR nicht gesetzt → auto → ohne Key → extractive_v1
    const gen = selectGenerator();
    expect(gen).toBeInstanceOf(ExtractiveV1Generator);
  });
});

// ---------------------------------------------------------------------------
// generateWithFallback — Fallback-Pfad
// ---------------------------------------------------------------------------

describe("generateWithFallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("llm_v2 erfolgreich → Ergebnis mit generator='llm_v2'", async () => {
    vi.stubEnv("DIGEST_GENERATOR", "llm_v2");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");

    const llmResponse = JSON.stringify({
      title: "Kreistag – Sitzung",
      statements: [
        { text: "Haushaltssatzung beschlossen.", sourceDocumentId: "doc-vorlage-001" },
      ],
    });

    const draft = await generateWithFallback(testMeeting, testDocs, {
      fetchFn: makeAnthropicStub(llmResponse),
    });

    expect(draft.generator).toBe(LLM_V2_NAME);
    expect(draft.statements.length).toBe(1);
  });

  it("llm_v2 wirft → Fallback auf extractive_v1 mit generator='extractive_v1'", async () => {
    vi.stubEnv("DIGEST_GENERATOR", "llm_v2");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");

    const throwingFetch = async () => {
      throw new Error("API nicht erreichbar");
    };

    const draft = await generateWithFallback(testMeeting, testDocs, {
      fetchFn: throwingFetch,
    });

    // Fallback muss extractive_v1 gewählt haben
    expect(draft.generator).toBe(EXTRACTIVE_NAME);
  });

  it("extractive_v1 selektiert → kein Fallback-Pfad, direkt ausgeführt", async () => {
    vi.stubEnv("DIGEST_GENERATOR", "extractive_v1");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const draft = await generateWithFallback(testMeeting, testDocs);

    expect(draft.generator).toBe(EXTRACTIVE_NAME);
    expect(draft.statements.length).toBeGreaterThan(0);
  });

  it("Fallback: generator-Feld nennt wirklich den ausführenden Generator", async () => {
    vi.stubEnv("DIGEST_GENERATOR", "auto");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");

    // LLM wirft validierungsfehler (ungültige sourceDocumentId)
    const badLlmResponse = JSON.stringify({
      title: "Test",
      statements: [
        { text: "Aussage.", sourceDocumentId: "nicht-existente-id" },
      ],
    });

    const draft = await generateWithFallback(testMeeting, testDocs, {
      fetchFn: makeAnthropicStub(badLlmResponse),
    });

    // Fallback hat extractive_v1 verwendet
    expect(draft.generator).toBe(EXTRACTIVE_NAME);
  });

  it("Fallback: kein Secret in console.warn (Key-Redaction)", async () => {
    const secretKey = "sk-super-geheim-1234";
    vi.stubEnv("DIGEST_GENERATOR", "llm_v2");
    vi.stubEnv("ANTHROPIC_API_KEY", secretKey);

    const warnMessages: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg: string) => {
      warnMessages.push(msg);
    });

    const throwingFetch = async (_url: string, _init: RequestInit) => {
      throw new Error(`Verbindung fehlgeschlagen: ${secretKey}`);
    };

    await generateWithFallback(testMeeting, testDocs, { fetchFn: throwingFetch });

    warnSpy.mockRestore();

    // Der Key darf NICHT in der Warn-Meldung stehen
    for (const msg of warnMessages) {
      expect(msg).not.toContain(secretKey);
    }
  });
});

// ---------------------------------------------------------------------------
// M-2(a): Titel-Längenvalidierung (max 160 Zeichen)
// ---------------------------------------------------------------------------

describe("LlmV2Generator — Titel-Validierung (M-2a)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Titel mit 160 Zeichen ist gültig", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const title160 = "K".repeat(160);
    const llmResponse = JSON.stringify({
      title: title160,
      statements: [
        { text: "Aussage.", sourceDocumentId: "doc-vorlage-001" },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeeting, testDocs);
    expect(draft.title.length).toBe(160);
  });

  it("Titel mit 161 Zeichen → Fehler (zu lang)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const title161 = "K".repeat(161);
    const llmResponse = JSON.stringify({
      title: title161,
      statements: [
        { text: "Aussage.", sourceDocumentId: "doc-vorlage-001" },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /title.*zu lang/i
    );
  });

  it("Kampagnen-Titel (398 Zeichen) wird abgelehnt", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const longTitle = "Kreistag – ".repeat(36).trim(); // >160 Zeichen
    const llmResponse = JSON.stringify({
      title: longTitle,
      statements: [
        { text: "Aussage.", sourceDocumentId: "doc-vorlage-001" },
      ],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    await expect(gen.generate(testMeeting, testDocs)).rejects.toThrow(
      /title.*zu lang/i
    );
  });
});

// ---------------------------------------------------------------------------
// H-1: Dokument-Cap (max 30 Dokumente im Prompt)
// ---------------------------------------------------------------------------

describe("LlmV2Generator — Dokument-Cap H-1", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("console.warn wenn mehr als 30 Dokumente vorliegen", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const warnMessages: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((msg: string) => {
      warnMessages.push(msg);
    });

    // 35 Dokumente erstellen
    const manyDocs: DocumentInput[] = Array.from({ length: 35 }, (_, i) => ({
      id: `doc-${i}`,
      docType: "anlage" as const,
      title: `Anlage ${i}`,
      bodyText: `Text Dokument ${i}`,
      sourceUrl: `https://example.de/doc${i}`,
      externalId: `ext-${i}`,
    }));

    const validId = "doc-0";
    const llmResponse = JSON.stringify({
      title: "Test",
      statements: [{ text: "Aussage.", sourceDocumentId: validId }],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    await gen.generate(testMeeting, manyDocs);

    expect(warnMessages.some((m) => m.includes("Dokument-Cap"))).toBe(true);
  });

  it("kein console.warn bei exakt 30 Dokumenten", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");

    const warnMessages: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((msg: string) => {
      warnMessages.push(msg);
    });

    const docs30: DocumentInput[] = Array.from({ length: 30 }, (_, i) => ({
      id: `doc-${i}`,
      docType: "anlage" as const,
      title: `Anlage ${i}`,
      bodyText: `Text Dokument ${i}`,
      sourceUrl: `https://example.de/doc${i}`,
      externalId: `ext-${i}`,
    }));

    const validId = "doc-0";
    const llmResponse = JSON.stringify({
      title: "Test",
      statements: [{ text: "Aussage.", sourceDocumentId: validId }],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    await gen.generate(testMeeting, docs30);

    expect(warnMessages.some((m) => m.includes("Dokument-Cap"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H-2: NaN-Guard für DIGEST_LLM_MAX_TOKENS
// ---------------------------------------------------------------------------

describe("LlmV2Generator — NaN-Guard DIGEST_LLM_MAX_TOKENS (H-2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ungültige DIGEST_LLM_MAX_TOKENS → kein Absturz, Default 2000 greift", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");
    vi.stubEnv("DIGEST_LLM_MAX_TOKENS", "keine-zahl");

    const llmResponse = JSON.stringify({
      title: "Kreistag – Test",
      statements: [{ text: "Aussage.", sourceDocumentId: "doc-vorlage-001" }],
    });

    // Darf nicht crashen
    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeeting, testDocs);
    expect(draft.title).toBeTruthy();
  });

  it("leere DIGEST_LLM_MAX_TOKENS → kein Absturz", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-12345");
    vi.stubEnv("DIGEST_LLM_MAX_TOKENS", "");

    const llmResponse = JSON.stringify({
      title: "Kreistag – Test",
      statements: [{ text: "Aussage.", sourceDocumentId: "doc-vorlage-001" }],
    });

    const gen = new LlmV2Generator({ fetchFn: makeAnthropicStub(llmResponse) });
    const draft = await gen.generate(testMeeting, testDocs);
    expect(draft.title).toBeTruthy();
  });
});
