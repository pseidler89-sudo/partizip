/**
 * select-generator.ts — Generator-Selektion und Fallback-Logik (M7, Feature A)
 *
 * Env DIGEST_GENERATOR: "extractive_v1" | "llm_v2" | "auto" (Default: "auto")
 *   auto      → llm_v2 wenn ANTHROPIC_API_KEY gesetzt, sonst extractive_v1
 *   llm_v2    → llm_v2 (Fehler wenn ANTHROPIC_API_KEY fehlt)
 *   extractive_v1 → immer extractive_v1 (kein LLM)
 *
 * generateWithFallback(): versucht selektierten Generator;
 *   wenn llm_v2 zur Laufzeit scheitert → Fallback auf extractive_v1 (console.warn ohne Secrets).
 *   Das generator-Feld im Ergebnis nennt IMMER den Generator, der das Ergebnis erzeugt hat.
 */

import type { DigestGenerator, DraftDigest, MeetingInput, DocumentInput } from "./types.js";
import { ExtractiveV1Generator, GENERATOR_NAME as EXTRACTIVE_NAME } from "./extractive_v1.js";
import { LlmV2Generator, GENERATOR_NAME as LLM_V2_NAME } from "./llm_v2.js";
import type { LlmV2GeneratorOptions } from "./llm_v2.js";

export type GeneratorMode = "extractive_v1" | "llm_v2" | "auto";

/**
 * Gibt den konfigurierten Generator zurück.
 * Bei "auto" wird llm_v2 gewählt wenn ANTHROPIC_API_KEY gesetzt ist.
 *
 * @throws wenn DIGEST_GENERATOR="llm_v2" aber ANTHROPIC_API_KEY nicht gesetzt
 */
export function selectGenerator(llmOpts?: LlmV2GeneratorOptions): DigestGenerator {
  const mode = (process.env.DIGEST_GENERATOR ?? "auto") as GeneratorMode;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  switch (mode) {
    case "extractive_v1":
      return new ExtractiveV1Generator();

    case "llm_v2":
      if (!apiKey) {
        throw new Error(
          "DIGEST_GENERATOR=llm_v2 erfordert ANTHROPIC_API_KEY. " +
          "Bitte Key setzen oder DIGEST_GENERATOR=extractive_v1 / DIGEST_GENERATOR=auto verwenden."
        );
      }
      return new LlmV2Generator(llmOpts);

    case "auto":
    default:
      if (apiKey) {
        return new LlmV2Generator(llmOpts);
      }
      return new ExtractiveV1Generator();
  }
}

/**
 * Generiert einen Digest mit dem konfigurierten Generator.
 * Wenn llm_v2 zur Laufzeit scheitert → Fallback auf extractive_v1.
 *
 * Das generator-Feld im DraftDigest nennt den Generator, der das Ergebnis erzeugt hat.
 * Secrets erscheinen NIE in console.warn-Ausgaben.
 */
export async function generateWithFallback(
  meeting: MeetingInput,
  documents: DocumentInput[],
  llmOpts?: LlmV2GeneratorOptions
): Promise<DraftDigest> {
  const generator = selectGenerator(llmOpts);

  // Wenn extractive_v1 selektiert → direkt ausführen, kein Fallback nötig
  if (!(generator instanceof LlmV2Generator)) {
    return generator.generate(meeting, documents);
  }

  // llm_v2 selektiert → versuchen, bei Fehler Fallback auf extractive_v1
  try {
    return await generator.generate(meeting, documents);
  } catch (err) {
    // Fehlermeldung bereinigen (API-Key aus Meldung entfernen)
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Keine Secrets in Logs — API-Key darf nicht auftauchen
    // Der rawMsg aus llm_v2.ts ist bereits redacted, aber zur Sicherheit nochmals filtern
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const safeMsg = apiKey ? rawMsg.replaceAll(apiKey, "***") : rawMsg;

    console.warn(
      `[DigestGenerator] llm_v2 gescheitert, Fallback auf ${EXTRACTIVE_NAME}. ` +
      `Fehler: ${safeMsg}`
    );

    const fallback = new ExtractiveV1Generator();
    return fallback.generate(meeting, documents);
  }
}

// Re-exportiere Generator-Namen für externe Verwendung
export { EXTRACTIVE_NAME, LLM_V2_NAME };
