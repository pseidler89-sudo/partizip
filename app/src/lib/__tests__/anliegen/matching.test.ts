/**
 * matching.test.ts — Tests für semantisches Matching (M8)
 *
 * Prüft: deterministische Scores, Fixture-Texte, Schwellwert-Filterung
 */

import { describe, it, expect } from "vitest";
import {
  tokenize,
  computeSimilarity,
  computeMatches,
} from "@/lib/anliegen/matching";

describe("tokenize", () => {
  it("entfernt Stoppwörter", () => {
    const tokens = tokenize("Das ist ein Test und auch noch was");
    expect(tokens).not.toContain("das");
    expect(tokens).not.toContain("ist");
    expect(tokens).not.toContain("ein");
    expect(tokens).not.toContain("und");
    expect(tokens).not.toContain("auch");
  });

  it("konvertiert zu Kleinschreibung", () => {
    const tokens = tokenize("Straßenlaterne Reparatur DEFEKT");
    expect(tokens).toContain("straßenlaterne");
    expect(tokens).toContain("reparatur");
    expect(tokens).toContain("defekt");
  });

  it("filtert Tokens < 3 Zeichen", () => {
    const tokens = tokenize("ab cd ef ghi");
    expect(tokens).not.toContain("ab");
    expect(tokens).not.toContain("cd");
    expect(tokens).not.toContain("ef");
    expect(tokens).toContain("ghi");
  });

  it("gibt leeres Array für leeren Text zurück", () => {
    expect(tokenize("")).toHaveLength(0);
    expect(tokenize("   ")).toHaveLength(0);
  });

  it("ist deterministisch", () => {
    const text = "Defekte Straßenlaterne in der Aarstraße seit zwei Wochen";
    expect(tokenize(text)).toEqual(tokenize(text));
  });
});

describe("computeSimilarity", () => {
  it("gibt 0 bei leeren Token-Listen zurück", () => {
    expect(computeSimilarity([], ["straße", "laterne"])).toBe(0);
    expect(computeSimilarity(["straße"], [])).toBe(0);
  });

  it("gibt 0 bei keiner Überschneidung zurück", () => {
    const sim = computeSimilarity(
      ["straßenlaterne", "defekt", "aarstraße"],
      ["spielplatz", "schaukel", "wehen"]
    );
    expect(sim).toBe(0);
  });

  it("gibt höhere Werte bei mehr Überschneidung", () => {
    const low = computeSimilarity(
      ["straßenlaterne", "defekt"],
      ["straßenlaterne", "spielplatz", "schaukel", "radweg", "fahrrad"]
    );
    const high = computeSimilarity(
      ["straßenlaterne", "defekt"],
      ["straßenlaterne", "defekt", "reparatur"]
    );
    expect(high).toBeGreaterThan(low);
  });

  it("Ergebnis liegt immer in [0, 1]", () => {
    const cases = [
      { a: ["straße"], b: ["straße"] },
      { a: ["a", "b", "c"], b: ["d", "e", "f"] },
      { a: ["test", "text"], b: ["test", "text", "token"] },
    ];
    for (const { a, b } of cases) {
      const sim = computeSimilarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(0);
      expect(sim).toBeLessThanOrEqual(1);
    }
  });

  it("ist deterministisch (gleiche Eingabe → gleicher Score)", () => {
    const a = ["straßenlaterne", "defekt", "aarstraße"];
    const b = ["stadtbeleuchtung", "straßenlaterne", "prüfung"];
    expect(computeSimilarity(a, b)).toBe(computeSimilarity(a, b));
  });
});

describe("computeMatches", () => {
  const docs = [
    {
      id: "doc-1",
      bodyText: "Die Straßenlaterne in der Aarstraße ist defekt. Stadtbeleuchtung muss geprüft werden.",
      title: "Protokoll Straßenbeleuchtung",
      sourceUrl: "https://example.com/doc1",
    },
    {
      id: "doc-2",
      bodyText: "Der Spielplatz in Wehen wurde renoviert. Schaukel und Klettergerüst sind neu.",
      title: "Spielplatz Wehen Renovierung",
      sourceUrl: "https://example.com/doc2",
    },
    {
      id: "doc-3",
      bodyText: "Radwegmarkierungen auf der Verbindungsstraße werden erneuert. Fahrradverkehr verbessert.",
      title: "Radwege Verbesserung",
      sourceUrl: "https://example.com/doc3",
    },
    {
      id: "doc-4",
      bodyText: null, // Kein body_text → wird ignoriert
      title: "Leeres Dokument",
      sourceUrl: "https://example.com/doc4",
    },
  ];

  it("findet relevante Dokumente für Straßenlaterne-Anliegen", () => {
    const candidates = computeMatches(
      {
        anliegenId: "anl-1",
        titel: "Defekte Straßenlaterne in der Aarstraße",
        beschreibung: "Die Laterne fällt seit zwei Wochen aus.",
      },
      docs
    );

    expect(candidates.length).toBeGreaterThan(0);
    // doc-1 sollte am relevantesten sein
    expect(candidates[0].risDocumentId).toBe("doc-1");
    expect(candidates[0].confidence).toBeGreaterThan(0.15);
  });

  it("ignoriert Dokumente ohne body_text", () => {
    const candidates = computeMatches(
      { anliegenId: "anl-1", titel: "Test", beschreibung: null },
      docs
    );
    const docIds = candidates.map(c => c.risDocumentId);
    expect(docIds).not.toContain("doc-4");
  });

  it("hält den Schwellwert ein (minConfidence = 0.15)", () => {
    const candidates = computeMatches(
      { anliegenId: "anl-1", titel: "Test", beschreibung: null },
      docs,
      0.15
    );
    for (const c of candidates) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.15);
    }
  });

  it("gibt maximal maxCandidates Ergebnisse zurück", () => {
    // Anliegen mit allgemeinem Text, der viele Docs treffen könnte
    const candidates = computeMatches(
      {
        anliegenId: "anl-1",
        titel: "Straße Weg Laterne Spielplatz Radweg",
        beschreibung: "Allgemeines Anliegen mit vielen Begriffen.",
      },
      docs,
      0.0, // sehr niedriger Schwellwert
      2    // maximal 2
    );
    expect(candidates.length).toBeLessThanOrEqual(2);
  });

  it("ist deterministisch (gleiche Eingabe → gleiche Reihenfolge)", () => {
    const query = {
      anliegenId: "anl-1",
      titel: "Defekte Straßenlaterne in der Aarstraße",
      beschreibung: "Die Laterne fällt aus.",
    };
    const result1 = computeMatches(query, docs);
    const result2 = computeMatches(query, docs);
    expect(result1.map(c => c.risDocumentId)).toEqual(result2.map(c => c.risDocumentId));
    expect(result1.map(c => c.confidence)).toEqual(result2.map(c => c.confidence));
  });

  it("confidence-Werte sind in [0, 1]", () => {
    const candidates = computeMatches(
      { anliegenId: "anl-1", titel: "Straßenlaterne defekt", beschreibung: null },
      docs,
      0.0
    );
    for (const c of candidates) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("gibt anliegenId korrekt mit", () => {
    const candidates = computeMatches(
      { anliegenId: "test-anliegen-id", titel: "Straßenlaterne defekt", beschreibung: null },
      docs,
      0.0
    );
    for (const c of candidates) {
      expect(c.anliegenId).toBe("test-anliegen-id");
    }
  });

  it("gibt leeres Array für leeres Anliegen zurück", () => {
    const candidates = computeMatches(
      { anliegenId: "anl-1", titel: "", beschreibung: null },
      docs
    );
    expect(candidates).toHaveLength(0);
  });
});
