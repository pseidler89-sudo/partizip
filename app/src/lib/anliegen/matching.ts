/**
 * matching.ts — Semantisches Matching v1 (deterministisch, KEIN LLM) (M8)
 *
 * Lexikalische Ähnlichkeit: Anliegen-Text vs. ris_documents.body_text
 * Methode: TF-IDF-ähnliche Gewichtung + Jaccard-Overlap über signifikante Terme
 *
 * Design-Entscheidungen:
 *   - Deterministisch + testbar (kein Zufallselement, keine externe API)
 *   - LLM/Embedding = spätere Eskalation (Mini-ADR-010)
 *   - confidence 0..1 (Schwellwert >= 0.15 für Kandidaten, max. 5 je Anliegen)
 *   - Mensch bestätigt immer — kein automatischer Statuswechsel
 *
 * Algorithmus:
 *   1. Tokenisierung (Kleinschreibung, nur Buchstaben/Ziffern, min. 3 Zeichen)
 *   2. Stoppwort-Filterung (eingebettete deutsche Liste)
 *   3. Termfrequenz (TF) für Anliegen-Dokument
 *   4. Jaccard-Koeffizient zwischen Anliegen-Termen und Dokument-Termen
 *   5. Gewichtung: Jaccard × (1 + log1p(gemeinsame Terme))
 *   6. Normierung auf 0..1
 */

// ---------------------------------------------------------------------------
// Stoppwörter (eingebettete deutsche Liste — keine externe Abhängigkeit)
// ---------------------------------------------------------------------------

const GERMAN_STOPWORDS = new Set([
  "aber", "alle", "allem", "allen", "aller", "alles", "als", "also", "am",
  "an", "ander", "andere", "anderem", "anderen", "anderer", "anderes",
  "anderm", "andern", "anderr", "anders", "auch", "auf", "aus", "bei",
  "bin", "bis", "bist", "da", "damit", "dann", "das", "dass", "daß",
  "dein", "deine", "deinem", "deinen", "deiner", "deines", "dem", "den",
  "denn", "der", "des", "dessen", "die", "dies", "diese", "diesem",
  "diesen", "dieser", "dieses", "dir", "doch", "dort", "du", "durch",
  "ein", "eine", "einem", "einen", "einer", "eines", "einige", "einigem",
  "einigen", "einiger", "einiges", "einmal", "er", "es", "etwas", "euch",
  "euer", "eure", "eurem", "euren", "eurer", "eures", "für", "gegen",
  "hatte", "hatten", "hat", "haben", "habe", "hier", "hin", "hinter",
  "ich", "ihm", "ihn", "ihnen", "ihr", "ihre", "ihrem", "ihren", "ihrer",
  "ihres", "im", "in", "indem", "ins", "ist", "jede", "jedem", "jeden",
  "jeder", "jedes", "jetzt", "kann", "kein", "keine", "keinem", "keinen",
  "keiner", "keines", "können", "könnte", "machen", "man", "manche",
  "manchem", "manchen", "mancher", "manches", "mein", "meine", "meinem",
  "meinen", "meiner", "meines", "mit", "muss", "musste", "nach", "nicht",
  "nichts", "noch", "nun", "nur", "ob", "oder", "ohne", "sehr", "sein",
  "seine", "seinem", "seinen", "seiner", "seines", "selbst", "sich",
  "sie", "sind", "so", "solche", "solchem", "solchen", "solcher", "solches",
  "soll", "sollte", "sondern", "sonst", "soweit", "sowie", "um", "und",
  "uns", "unse", "unser", "unsere", "unserem", "unseren", "unserer",
  "unseres", "unter", "viel", "vom", "von", "vor", "war", "waren",
  "warst", "was", "weg", "weil", "weiter", "welche", "welchem", "welchen",
  "welcher", "welches", "wenn", "wer", "werden", "wie", "wieder", "will",
  "wir", "wird", "wirst", "wo", "wollen", "wollte", "wurde", "wurden",
  "würde", "würden", "zu", "zum", "zur", "zwar", "zwischen",
  // Häufige Verwaltungs-Füllwörter
  "werden", "sowie", "dabei", "hierfür", "aufgrund", "bezüglich", "gemäß",
  "entsprechend", "wurde", "wird", "werden", "können", "sollen", "müssen",
]);

// ---------------------------------------------------------------------------
// Tokenisierung
// ---------------------------------------------------------------------------

/**
 * Tokenisiert einen Text: Kleinschreibung, nur Buchstaben und Ziffern,
 * mindestens 3 Zeichen, Stoppwörter entfernt.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/)
    .filter(tok => tok.length >= 3 && !GERMAN_STOPWORDS.has(tok));
}

/**
 * Erstellt eine Termfrequenz-Map aus Token-Liste.
 */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const tok of tokens) {
    tf.set(tok, (tf.get(tok) ?? 0) + 1);
  }
  return tf;
}

// ---------------------------------------------------------------------------
// Similarity-Berechnung
// ---------------------------------------------------------------------------

/**
 * Berechnet die Ähnlichkeit zwischen zwei Token-Sets.
 * Kombiniert Jaccard-Koeffizient mit Häufigkeitsinformation.
 *
 * @returns confidence in [0..1]
 */
export function computeSimilarity(
  queryTokens: string[],
  docTokens: string[]
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;

  const queryTF = termFrequency(queryTokens);
  const docTF = termFrequency(docTokens);

  const querySet = new Set(queryTF.keys());
  const docSet = new Set(docTF.keys());

  // Schnittmenge der Terme
  const intersection = new Set([...querySet].filter(t => docSet.has(t)));
  if (intersection.size === 0) return 0;

  // Jaccard-Koeffizient (Set-Ebene)
  const union = new Set([...querySet, ...docSet]);
  const jaccard = intersection.size / union.size;

  // Gewichtung: Häufigkeit gemeinsamer Terme berücksichtigen
  // Summe min(tf_query, tf_doc) für gemeinsame Terme
  let sharedFrequency = 0;
  for (const term of intersection) {
    sharedFrequency += Math.min(queryTF.get(term)!, docTF.get(term)!);
  }

  // Logarithmische Gewichtung der Frequenz (verhindert Übergewichtung langer Dokumente)
  const freqBoost = Math.log1p(sharedFrequency) / Math.log1p(Math.max(queryTokens.length, 10));

  // Kombination: 60% Jaccard + 40% frequenz-gewichtet
  const raw = 0.6 * jaccard + 0.4 * Math.min(freqBoost, 1.0);

  // Auf 0..1 begrenzen (sollte ohnehin so sein)
  return Math.min(1.0, Math.max(0.0, raw));
}

// ---------------------------------------------------------------------------
// Match-Berechnung für ein Anliegen gegen Dokument-Korpus
// ---------------------------------------------------------------------------

export interface AnliegenMatchInput {
  anliegenId: string;
  titel: string;
  beschreibung: string | null;
}

export interface DocumentInput {
  id: string;
  bodyText: string | null;
  title: string | null;
  sourceUrl: string;
}

export interface MatchCandidate {
  anliegenId: string;
  risDocumentId: string;
  confidence: number;
}

/**
 * Berechnet Match-Kandidaten für ein Anliegen gegen einen Dokument-Korpus.
 *
 * @param anliegen - Das Anliegen (Titel + Beschreibung als Query)
 * @param documents - Alle verfügbaren Dokumente
 * @param minConfidence - Schwellwert (default: 0.15)
 * @param maxCandidates - Maximale Kandidaten (default: 5)
 * @returns Sortierte Kandidaten (confidence absteigend)
 */
export function computeMatches(
  anliegen: AnliegenMatchInput,
  documents: DocumentInput[],
  minConfidence = 0.15,
  maxCandidates = 5
): MatchCandidate[] {
  // Query-Text: Titel (3×) + Beschreibung (Boosting durch Wiederholung des Titels)
  const queryText = [
    anliegen.titel, anliegen.titel, anliegen.titel,
    anliegen.beschreibung ?? "",
  ].join(" ");
  const queryTokens = tokenize(queryText);

  if (queryTokens.length === 0) return [];

  const candidates: MatchCandidate[] = [];

  for (const doc of documents) {
    const docText = [doc.title ?? "", doc.bodyText ?? ""].join(" ");
    if (!docText.trim()) continue;

    const docTokens = tokenize(docText);
    const confidence = computeSimilarity(queryTokens, docTokens);

    if (confidence >= minConfidence) {
      candidates.push({
        anliegenId: anliegen.anliegenId,
        risDocumentId: doc.id,
        confidence,
      });
    }
  }

  // Sortierung: confidence absteigend, bei Gleichstand doc-id als Tiebreaker (deterministisch)
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.risDocumentId.localeCompare(b.risDocumentId);
  });

  return candidates.slice(0, maxCandidates);
}
