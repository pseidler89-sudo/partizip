/**
 * validate-draft.test.ts — Tests für das gemeinsame Validierungsmodul
 *
 * Testet:
 *   - Happy Path (valid input → ValidatedDraft)
 *   - Jede Regelverletzung (title, statements, text, sourceDocumentId)
 *   - sourceUrl wird NIEMALS aus dem Input übernommen
 *   - position wird serverseitig nummeriert
 *   - parseAndValidateDraftJson (Markdown-Cleanup + JSON-Fehler)
 */

import { describe, it, expect } from "vitest";
import {
  validateDraft,
  parseAndValidateDraftJson,
  MAX_TITLE_CHARS,
  MAX_STATEMENTS,
  MAX_STATEMENT_CHARS,
} from "../validate-draft.js";
import type { DocumentInput } from "../types.js";

// ---------------------------------------------------------------------------
// Test-Fixtures
// ---------------------------------------------------------------------------

const testDocs: DocumentInput[] = [
  {
    id: "doc-vorlage-001",
    docType: "vorlage",
    title: "Haushaltssatzung 2026",
    bodyText: "Die Haushaltssatzung 2026 sieht Ausgaben vor.",
    sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/file/getfile/52300",
    externalId: "52300",
  },
  {
    id: "doc-protokoll-001",
    docType: "protokoll",
    title: "Öffentliches Protokoll",
    bodyText: "Das Protokoll liegt vor.",
    sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/file/getfile/52668",
    externalId: "52668",
  },
];

const meetingSourceUrl = "https://www.rheingau-taunus.de/ris/rtk/meeting/details/3452";

const validInput = {
  title: "Kreistag – Sitzung vom 12.05.2026",
  statements: [
    { text: "Die Haushaltssatzung wurde beschlossen.", sourceDocumentId: "doc-vorlage-001" },
    { text: "Das Protokoll liegt vor.", sourceDocumentId: "doc-protokoll-001" },
  ],
};

// ---------------------------------------------------------------------------
// Happy Path
// ---------------------------------------------------------------------------

describe("validateDraft — Happy Path", () => {
  it("gibt ValidatedDraft mit korrekten Feldern zurück", () => {
    const result = validateDraft(validInput, testDocs, meetingSourceUrl);

    expect(result.title).toBe("Kreistag – Sitzung vom 12.05.2026");
    expect(result.statements.length).toBe(2);
  });

  it("position wird serverseitig 1-basiert nummeriert", () => {
    const result = validateDraft(validInput, testDocs, meetingSourceUrl);

    expect(result.statements[0].position).toBe(1);
    expect(result.statements[1].position).toBe(2);
  });

  it("sourceUrl wird serverseitig aus Dokument abgeleitet, nicht aus Input", () => {
    const inputWithFakeUrl = {
      title: "Test",
      statements: [
        {
          text: "Eine Aussage.",
          sourceDocumentId: "doc-vorlage-001",
          sourceUrl: "https://boese-url.example.com/halluziniert",
        },
      ],
    };

    const result = validateDraft(inputWithFakeUrl, testDocs, meetingSourceUrl);

    // Fake-URL darf NICHT übernommen werden
    expect(result.statements[0].sourceUrl).not.toContain("boese-url.example.com");
    // Echte URL aus dem Dokument
    expect(result.statements[0].sourceUrl).toContain("rheingau-taunus.de");
  });

  it("Wicket-URL wird durch meetingSourceUrl ersetzt", () => {
    const wicketDocs: DocumentInput[] = [
      {
        id: "doc-wicket-001",
        docType: "protokoll",
        title: "Protokoll",
        bodyText: "Text.",
        sourceUrl: "https://allris.example.de/wicket/resource/org.apache.wicket.Application/doc.pdf",
        externalId: null,
      },
    ];

    const result = validateDraft(
      {
        title: "Test",
        statements: [{ text: "Aussage.", sourceDocumentId: "doc-wicket-001" }],
      },
      wicketDocs,
      meetingSourceUrl
    );

    expect(result.statements[0].sourceUrl).not.toContain("/wicket/resource/");
    expect(result.statements[0].sourceUrl).toBe(meetingSourceUrl);
  });

  it("title mit genau 160 Zeichen ist gültig", () => {
    const input = {
      title: "K".repeat(MAX_TITLE_CHARS),
      statements: [{ text: "Aussage.", sourceDocumentId: "doc-vorlage-001" }],
    };

    const result = validateDraft(input, testDocs, meetingSourceUrl);
    expect(result.title.length).toBe(160);
  });

  it("1 Statement ist gültig (Mindestanzahl)", () => {
    const input = {
      title: "Test",
      statements: [{ text: "Einzige Aussage.", sourceDocumentId: "doc-vorlage-001" }],
    };

    const result = validateDraft(input, testDocs, meetingSourceUrl);
    expect(result.statements.length).toBe(1);
  });

  it("30 Statements sind gültig (Maximalanzahl)", () => {
    const stmts = Array.from({ length: MAX_STATEMENTS }, () => ({
      text: "Eine Aussage.",
      sourceDocumentId: "doc-vorlage-001",
    }));

    const result = validateDraft({ title: "Test", statements: stmts }, testDocs, meetingSourceUrl);
    expect(result.statements.length).toBe(30);
  });

  it("text mit führenden/abschließenden Leerzeichen wird getrimmt", () => {
    const input = {
      title: "  Test  ",
      statements: [{ text: "  Aussage mit Leerzeichen.  ", sourceDocumentId: "doc-vorlage-001" }],
    };

    const result = validateDraft(input, testDocs, meetingSourceUrl);
    expect(result.title).toBe("Test");
    expect(result.statements[0].text).toBe("Aussage mit Leerzeichen.");
  });

  it("sourceDocumentId mit führenden Leerzeichen wird nach trim() akzeptiert", () => {
    const input = {
      title: "Test",
      statements: [{ text: "Aussage.", sourceDocumentId: " doc-vorlage-001 " }],
    };

    const result = validateDraft(input, testDocs, meetingSourceUrl);
    expect(result.statements[0].sourceDocumentId).toBe("doc-vorlage-001");
  });
});

// ---------------------------------------------------------------------------
// title-Verletzungen
// ---------------------------------------------------------------------------

describe("validateDraft — title-Verletzungen", () => {
  it("fehlendes title → Fehler", () => {
    expect(() =>
      validateDraft({ statements: validInput.statements }, testDocs, meetingSourceUrl)
    ).toThrow(/'title'/);
  });

  it("leerer title → Fehler", () => {
    expect(() =>
      validateDraft({ title: "   ", statements: validInput.statements }, testDocs, meetingSourceUrl)
    ).toThrow(/'title'/);
  });

  it("title mit 161 Zeichen → Fehler", () => {
    expect(() =>
      validateDraft(
        { title: "K".repeat(161), statements: validInput.statements },
        testDocs,
        meetingSourceUrl
      )
    ).toThrow(/zu lang/);
  });

  it("title ist kein String → Fehler", () => {
    expect(() =>
      validateDraft({ title: 42, statements: validInput.statements }, testDocs, meetingSourceUrl)
    ).toThrow(/'title'/);
  });
});

// ---------------------------------------------------------------------------
// statements-Verletzungen
// ---------------------------------------------------------------------------

describe("validateDraft — statements-Verletzungen", () => {
  it("fehlendes statements → Fehler", () => {
    expect(() =>
      validateDraft({ title: "Test" }, testDocs, meetingSourceUrl)
    ).toThrow(/'statements'/);
  });

  it("statements ist kein Array → Fehler", () => {
    expect(() =>
      validateDraft({ title: "Test", statements: "keine liste" }, testDocs, meetingSourceUrl)
    ).toThrow(/'statements'/);
  });

  it("leeres statements-Array → Fehler", () => {
    expect(() =>
      validateDraft({ title: "Test", statements: [] }, testDocs, meetingSourceUrl)
    ).toThrow(/leer/);
  });

  it("31 Statements → Fehler (über Maximalanzahl)", () => {
    const stmts = Array.from({ length: 31 }, () => ({
      text: "Aussage.",
      sourceDocumentId: "doc-vorlage-001",
    }));

    expect(() =>
      validateDraft({ title: "Test", statements: stmts }, testDocs, meetingSourceUrl)
    ).toThrow(/31.*maximal 30/);
  });
});

// ---------------------------------------------------------------------------
// Statement-Text-Verletzungen
// ---------------------------------------------------------------------------

describe("validateDraft — Statement-Text-Verletzungen", () => {
  it("text ist kein String → Fehler", () => {
    expect(() =>
      validateDraft(
        { title: "Test", statements: [{ text: 42, sourceDocumentId: "doc-vorlage-001" }] },
        testDocs,
        meetingSourceUrl
      )
    ).toThrow(/text.*kein String/);
  });

  it("leerer text → Fehler", () => {
    expect(() =>
      validateDraft(
        { title: "Test", statements: [{ text: "   ", sourceDocumentId: "doc-vorlage-001" }] },
        testDocs,
        meetingSourceUrl
      )
    ).toThrow(/leer/);
  });

  it(`text mit ${MAX_STATEMENT_CHARS + 1} Zeichen → Fehler`, () => {
    expect(() =>
      validateDraft(
        {
          title: "Test",
          statements: [{ text: "x".repeat(MAX_STATEMENT_CHARS + 1), sourceDocumentId: "doc-vorlage-001" }],
        },
        testDocs,
        meetingSourceUrl
      )
    ).toThrow(/zu lang/);
  });

  it(`text mit genau ${MAX_STATEMENT_CHARS} Zeichen ist gültig`, () => {
    const result = validateDraft(
      {
        title: "Test",
        statements: [{ text: "x".repeat(MAX_STATEMENT_CHARS), sourceDocumentId: "doc-vorlage-001" }],
      },
      testDocs,
      meetingSourceUrl
    );
    expect(result.statements[0].text.length).toBe(MAX_STATEMENT_CHARS);
  });
});

// ---------------------------------------------------------------------------
// sourceDocumentId-Verletzungen
// ---------------------------------------------------------------------------

describe("validateDraft — sourceDocumentId-Verletzungen", () => {
  it("unbekannte sourceDocumentId → Fehler", () => {
    expect(() =>
      validateDraft(
        {
          title: "Test",
          statements: [{ text: "Aussage.", sourceDocumentId: "nicht-existent-id" }],
        },
        testDocs,
        meetingSourceUrl
      )
    ).toThrow(/nicht-existent-id.*keine gültige Dokument-ID/);
  });

  it("sourceDocumentId ist kein String → Fehler", () => {
    expect(() =>
      validateDraft(
        {
          title: "Test",
          statements: [{ text: "Aussage.", sourceDocumentId: 123 }],
        },
        testDocs,
        meetingSourceUrl
      )
    ).toThrow(/sourceDocumentId.*kein String/);
  });

  it("leere erlaubte Dokumente → jede sourceDocumentId schlägt fehl", () => {
    expect(() =>
      validateDraft(
        { title: "Test", statements: [{ text: "Aussage.", sourceDocumentId: "doc-vorlage-001" }] },
        [], // keine erlaubten Dokumente
        meetingSourceUrl
      )
    ).toThrow(/keine gültige Dokument-ID/);
  });
});

// ---------------------------------------------------------------------------
// Eingabe-Typ-Verletzungen
// ---------------------------------------------------------------------------

describe("validateDraft — Eingabe-Typ-Verletzungen", () => {
  it("null → Fehler", () => {
    expect(() => validateDraft(null, testDocs, meetingSourceUrl)).toThrow(/kein JSON-Objekt/);
  });

  it("Array → Fehler", () => {
    expect(() => validateDraft([], testDocs, meetingSourceUrl)).toThrow(/kein JSON-Objekt/);
  });

  it("String → Fehler", () => {
    expect(() => validateDraft("text", testDocs, meetingSourceUrl)).toThrow(/kein JSON-Objekt/);
  });
});

// ---------------------------------------------------------------------------
// parseAndValidateDraftJson
// ---------------------------------------------------------------------------

describe("parseAndValidateDraftJson", () => {
  it("valid JSON-String → ValidatedDraft", () => {
    const json = JSON.stringify(validInput);
    const result = parseAndValidateDraftJson(json, testDocs, meetingSourceUrl);
    expect(result.title).toBe(validInput.title);
    expect(result.statements.length).toBe(2);
  });

  it("Markdown-Code-Block wird entfernt (```json ... ```)", () => {
    const json = "```json\n" + JSON.stringify(validInput) + "\n```";
    const result = parseAndValidateDraftJson(json, testDocs, meetingSourceUrl);
    expect(result.title).toBe(validInput.title);
  });

  it("ungültiges JSON → Fehler mit Hinweis auf Rohantwort", () => {
    expect(() =>
      parseAndValidateDraftJson("das ist kein json {{{", testDocs, meetingSourceUrl)
    ).toThrow(/kein gültiges JSON/);
  });

  it("gültiges JSON, aber Regelverletzung → Fehler", () => {
    const json = JSON.stringify({ title: "Test", statements: [] });
    expect(() =>
      parseAndValidateDraftJson(json, testDocs, meetingSourceUrl)
    ).toThrow(/leer/);
  });
});
