/**
 * Typen für den pdf-parse-Subpath-Import (M7)
 *
 * pdf-parse@1.1.1 lädt beim Import von "pdf-parse" Testdaten,
 * deshalb importieren wir direkt "pdf-parse/lib/pdf-parse.js".
 * @types/pdf-parse deklariert nur das Haupt-Modul; diese Datei
 * ergänzt den Subpath.
 */
declare module "pdf-parse/lib/pdf-parse.js" {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import PdfParse = require("pdf-parse");
  export = PdfParse;
}
