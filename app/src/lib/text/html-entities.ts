/**
 * html-entities.ts — Utility zum Dekodieren von HTML-Entities (Aufgabe 6)
 *
 * Für Plaintext-Ausgabe in React-Text-Nodes (KEIN dangerouslySetInnerHTML).
 * Unterstützt: numerisch hex (&#xNN;), numerisch dezimal (&#NN;),
 * sowie gängige benannte Entities.
 *
 * Doppelt enkodierte Entities (z. B. &amp;ouml;) werden nur EINMAL dekodiert —
 * das Ergebnis ist normaler Text, kein HTML.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Deutsche Umlaute
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  // Geschütztes Leerzeichen
  nbsp: " ",
};

/**
 * Dekodiert HTML-Entities in einem String.
 * Die Ausgabe ist sicherer Plaintext — geeignet für React-Text-Nodes.
 * Keine XSS-Gefahr, da das Ergebnis nicht als HTML geparst wird.
 */
export function decodeHtmlEntities(str: string): string {
  return str
    // Hex-numerisch: &#xD6; → Ö
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    // Dezimal-numerisch: &#214; → Ö
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // Benannte Entities: &ouml; → ö
    .replace(/&([a-zA-Z]+);/g, (match, name) => NAMED_ENTITIES[name] ?? match);
}
