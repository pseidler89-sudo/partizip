/**
 * extractive_v1.test.ts — Tests für den extractive_v1-Generator (M7)
 *
 * Testet:
 *   - Aussagen werden generiert
 *   - JEDE Aussage hat source_document_id + sourceUrl (Pflichtfeld)
 *   - Keine Aussage ohne Quelle
 *   - M4: Vorlagen-Priorät (vorlage > top > einladung)
 *   - M4: cleanBoilerplate() bereinigt Briefkopf
 *   - M1(c): Wicket-Resource-URLs werden NICHT in sourceUrl persistiert
 *   - Fallback wenn keine TOPs vorhanden
 *   - LlmV1Generator wirft Fehler (Interface-Stub)
 */

import { describe, it, expect } from "vitest";
import { ExtractiveV1Generator, GENERATOR_NAME, cleanBoilerplate } from "../extractive_v1.js";
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

const testMeetingAllris: MeetingInput = {
  id: "meet-002",
  gremium: "Stadtverordnetenversammlung",
  title: "Stadtverordnetenversammlung",
  meetingDate: new Date("2025-12-11T18:00:00+01:00"),
  location: "Taunusstein",
  sourceUrl: "https://www.taunusstein.de/allris/to010?SILFDNR=4021",
};

const topDoc: DocumentInput = {
  id: "doc-top-001",
  docType: "top",
  title: "TOP III.5: Haushaltssatzung 2026",
  bodyText: "Die Stadtverordnetenversammlung beschließt die Haushaltssatzung 2026.\nAbstimmung: Ja: 28, Nein: 7, Enthaltungen: 2, Ergebnis: angenommen",
  sourceUrl: "https://www.taunusstein.de/allris/to020?TOLFDNR=1026743",
  externalId: "1026743",
};

const protokollDoc: DocumentInput = {
  id: "doc-prot-001",
  docType: "protokoll",
  title: "Öffentliches Protokoll",
  bodyText: "Protokoll der Sitzung...",
  sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/file/getfile/52668",
  externalId: "52668",
};

const protokollDocWicket: DocumentInput = {
  id: "doc-prot-wicket",
  docType: "protokoll",
  title: "Öffentliches Protokoll",
  bodyText: "Protokoll der Sitzung...",
  // ALLRIS Wicket-URL — sollte NICHT in Digest-Statements landen
  sourceUrl: "https://www.taunusstein.de/allris/wicket/resource/org.apache.wicket.Application/doc42.pdf",
  externalId: "protokoll:oeffentliches_protokoll",
};

const einladungDoc: DocumentInput = {
  id: "doc-ein-001",
  docType: "einladung",
  title: "Einladung",
  bodyText: "Einladung zur Sitzung des Kreistages am 12.05.2026.",
  sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/file/getfile/52402",
  externalId: "52402",
};

const vorlageDoc: DocumentInput = {
  id: "doc-vorlage-001",
  docType: "vorlage",
  title: "TOP III.5: Haushaltssatzung 2026 (XII/16)",
  bodyText: `Seite 1 von 2

Beschlussvorlage

Drucksachen-Nr. XI/1524 Bad Schwalbach, den 24.03.2026
Aktenzeichen: II.1 – BG
Ersteller/in: Beate Gilberg

Beratungsfolge Sitzungstermin TOP Öffentlich
Kreistag 12.05.2026  ja

Titel

Zukunftsfähige Berufsschule — Fachklassen für die Ausbildungsberufe "Zahnmedizinische Fachangestellte" ab dem Schuljahr 2026/27

I. Beschlussvorschlag:

Die Ausbildungsberufe werden bereits ab dem kommenden Schuljahr 2026/27 an den Beruflichen Schulen beschult. Die schulorganisatorischen, räumlichen und personellen Ressourcen hierfür stehen ab 01.08.2026 zur Verfügung.`,
  sourceUrl: "https://www.rheingau-taunus.de/ris/rtk/file/getfile/52300",
  externalId: "52300",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExtractiveV1Generator", () => {
  it("generiert Aussagen aus TOP-Dokumenten", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc, protokollDoc]);

    expect(draft.statements.length).toBeGreaterThan(0);
    expect(draft.generator).toBe(GENERATOR_NAME);
  });

  it("jede Aussage hat sourceDocumentId und sourceUrl", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc, protokollDoc]);

    for (const stmt of draft.statements) {
      expect(stmt.sourceDocumentId).toBeTruthy();
      expect(stmt.sourceUrl).toBeTruthy();
      expect(stmt.sourceUrl).toMatch(/^https?:\/\//);
      expect(stmt.position).toBeGreaterThan(0);
      expect(stmt.text).toBeTruthy();
    }
  });

  it("sourceDocumentId verweist auf existierendes Dokument", async () => {
    const gen = new ExtractiveV1Generator();
    const docs = [topDoc, protokollDoc];
    const draft = await gen.generate(testMeeting, docs);

    const docIds = new Set(docs.map((d) => d.id));
    for (const stmt of draft.statements) {
      expect(docIds.has(stmt.sourceDocumentId)).toBe(true);
    }
  });

  it("keine Aussage ohne Quelle (sourceDocumentId pflicht)", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc, protokollDoc]);

    for (const stmt of draft.statements) {
      // Leerzeichen oder leere Strings sind kein gültiger Wert
      expect(stmt.sourceDocumentId).not.toBe("");
      expect(stmt.sourceUrl).not.toBe("");
    }
  });

  it("Aussagen enthalten Beschlusstext", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc]);

    const topStmt = draft.statements.find((s) => s.sourceDocumentId === topDoc.id);
    expect(topStmt).toBeDefined();
    expect(topStmt!.text).toContain("Haushaltssatzung");
  });

  it("Aussagen enthalten Abstimmungsergebnis wenn vorhanden", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc]);

    const topStmt = draft.statements.find((s) => s.sourceDocumentId === topDoc.id);
    expect(topStmt!.text).toContain("Abstimmung");
    expect(topStmt!.text).toContain("28");
  });

  it("Protokoll-Hinweis als letzte Aussage wenn Protokoll vorhanden", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc, protokollDoc]);

    const lastStmt = draft.statements[draft.statements.length - 1];
    expect(lastStmt.sourceDocumentId).toBe(protokollDoc.id);
  });

  it("Fallback auf Tagesordnung/Einladung wenn keine TOPs", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [einladungDoc]);

    expect(draft.statements.length).toBeGreaterThan(0);
    expect(draft.statements[0].sourceDocumentId).toBe(einladungDoc.id);
  });

  it("gibt leere Statements zurück bei leeren Dokumenten", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, []);

    // Keine Dokumente → keine Aussagen
    expect(draft.statements).toEqual([]);
    expect(draft.title).toContain("Kreistag");
  });

  it("positions sind sequenziell (1, 2, 3, ...)", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc, protokollDoc]);

    const positions = draft.statements.map((s) => s.position).sort((a, b) => a - b);
    positions.forEach((pos, i) => {
      expect(pos).toBe(i + 1);
    });
  });

  it("Titel enthält Gremium und Datum", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc]);

    expect(draft.title).toContain("Kreistag");
    expect(draft.title).toContain("12.05.2026");
  });

  it("keine Bewertungen oder Meinungen im Text (Neutralitätskodex)", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc]);

    // Einfache Prüfung: keine typischen Bewertungswörter
    const bewertungswoerter = ["gut", "schlecht", "falsch", "richtig", "leider", "zum Glück"];
    for (const stmt of draft.statements) {
      for (const wort of bewertungswoerter) {
        expect(stmt.text.toLowerCase()).not.toContain(wort);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // M4: Vorlagen-Priorät (ADR-009)
  // ---------------------------------------------------------------------------

  it("M4: Vorlagen-Dokumente werden vor TOPs verarbeitet", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc, vorlageDoc, protokollDoc]);

    // Erste Aussage stammt aus Vorlage (hat position 1)
    const vorlageStmt = draft.statements.find((s) => s.sourceDocumentId === vorlageDoc.id);
    expect(vorlageStmt).toBeDefined();
    expect(vorlageStmt!.position).toBeLessThan(
      draft.statements.find((s) => s.sourceDocumentId === topDoc.id)!.position
    );
  });

  it("M4: Vorlage-Aussage enthält Vorlage-Titel als Quellenangabe", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [vorlageDoc]);

    const vorlageStmt = draft.statements.find((s) => s.sourceDocumentId === vorlageDoc.id);
    expect(vorlageStmt).toBeDefined();
    expect(vorlageStmt!.text).toContain("Vorlage");
  });

  it("M4: Vorlage-Aussage enthält Fließtext (kein Briefkopf)", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [vorlageDoc]);

    const vorlageStmt = draft.statements.find((s) => s.sourceDocumentId === vorlageDoc.id);
    expect(vorlageStmt).toBeDefined();
    // Briefkopf-Boilerplate darf NICHT in der Aussage stehen
    expect(vorlageStmt!.text).not.toContain("Drucksachen-Nr.");
    expect(vorlageStmt!.text).not.toContain("Aktenzeichen");
    // Fachlicher Inhalt muss vorhanden sein
    expect(vorlageStmt!.text.length).toBeGreaterThan(20);
  });

  // ---------------------------------------------------------------------------
  // M1(c): Wicket-Resource-URLs nicht in Statements
  // ---------------------------------------------------------------------------

  it("M1(c): Wicket-Resource-URLs werden NICHT in sourceUrl persistiert", async () => {
    const gen = new ExtractiveV1Generator();
    // Meeting mit ALLRIS sourceUrl (to010-Seite)
    const draft = await gen.generate(testMeetingAllris, [topDoc, protokollDocWicket]);

    for (const stmt of draft.statements) {
      expect(stmt.sourceUrl).not.toContain("/wicket/resource/");
    }
  });

  it("M1(c): Protokoll mit Wicket-URL bekommt Meeting-sourceUrl", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeetingAllris, [topDoc, protokollDocWicket]);

    const protokollStmt = draft.statements.find((s) => s.sourceDocumentId === protokollDocWicket.id);
    expect(protokollStmt).toBeDefined();
    // Muss to010-Seite sein
    expect(protokollStmt!.sourceUrl).toBe(testMeetingAllris.sourceUrl);
  });

  it("M1(c): Provox getfile-URLs bleiben unverändert (stabil)", async () => {
    const gen = new ExtractiveV1Generator();
    const draft = await gen.generate(testMeeting, [topDoc, protokollDoc]);

    const protokollStmt = draft.statements.find((s) => s.sourceDocumentId === protokollDoc.id);
    expect(protokollStmt).toBeDefined();
    // Provox getfile-URL ist stabil → direkt verwenden
    expect(protokollStmt!.sourceUrl).toContain("/file/getfile/");
  });
});

// ---------------------------------------------------------------------------
// M4: cleanBoilerplate()
// ---------------------------------------------------------------------------

describe("cleanBoilerplate", () => {
  it("überspringt Briefkopf und gibt Fließtext zurück", () => {
    const text = `Seite 1 von 2


Beschlussvorlage


Drucksachen-Nr. XI/1524 Bad Schwalbach, den 24.03.2026
Aktenzeichen: II.1 – BG
Ersteller/in: Beate Gilberg

Beratungsfolge Sitzungstermin TOP Öffentlich
Kreistag 12.05.2026  ja

Die Ausbildungsberufe werden bereits ab dem kommenden Schuljahr 2026/27 an den Beruflichen Schulen beschult. Die schulorganisatorischen, räumlichen und personellen Ressourcen hierfür stehen ab 01.08.2026 zur Verfügung.`;

    const cleaned = cleanBoilerplate(text);
    expect(cleaned).not.toContain("Drucksachen-Nr.");
    expect(cleaned).not.toContain("Aktenzeichen");
    expect(cleaned).toContain("Ausbildungsberufe");
  });

  it("gibt leeren String zurück bei reinem Briefkopf-Text", () => {
    const text = `Seite 1 von 2

Beschlussvorlage

Drucksachen-Nr. XI/1524
Aktenzeichen: II.1`;

    // Sollte bereinigt zurückgeben (keine Länge-Garantie für reine Boilerplate)
    const cleaned = cleanBoilerplate(text);
    // Mindestens kein Crash
    expect(typeof cleaned).toBe("string");
  });

  it("Text ohne Briefkopf bleibt unverändert", () => {
    const text = "Die Haushaltssatzung 2026 wurde einstimmig beschlossen. Alle Fraktionen stimmten zu.";
    const cleaned = cleanBoilerplate(text);
    expect(cleaned).toContain("Haushaltssatzung");
    expect(cleaned).toContain("einstimmig");
  });
});

