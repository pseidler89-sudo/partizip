/**
 * html-entities.test.ts — Unit-Tests für decodeHtmlEntities
 */

import { describe, it, expect } from "vitest";
import { decodeHtmlEntities } from "../html-entities.js";

describe("decodeHtmlEntities", () => {
  // --- Hex-numerisch ---

  it("dekodiert &#xD6; zu Ö", () => {
    expect(decodeHtmlEntities("&#xD6;ffentliches Protokoll")).toBe("Öffentliches Protokoll");
  });

  it("dekodiert &#xF6; zu ö", () => {
    expect(decodeHtmlEntities("&#xF6;ffentlich")).toBe("öffentlich");
  });

  it("dekodiert &#xDC; zu Ü", () => {
    expect(decodeHtmlEntities("&#xDC;berblick")).toBe("Überblick");
  });

  it("dekodiert &#xFC; zu ü", () => {
    expect(decodeHtmlEntities("&#xFC;ber")).toBe("über");
  });

  it("dekodiert &#xC4; zu Ä", () => {
    expect(decodeHtmlEntities("&#xC4;nderung")).toBe("Änderung");
  });

  it("dekodiert &#xE4; zu ä", () => {
    expect(decodeHtmlEntities("&#xE4;ndern")).toBe("ändern");
  });

  it("dekodiert &#xDF; zu ß", () => {
    expect(decodeHtmlEntities("Stra&#xDF;e")).toBe("Straße");
  });

  it("dekodiert Kleinbuchstaben hex (&#xd6;)", () => {
    expect(decodeHtmlEntities("&#xd6;ffentlich")).toBe("Öffentlich");
  });

  // --- Dezimal-numerisch ---

  it("dekodiert &#214; zu Ö", () => {
    expect(decodeHtmlEntities("&#214;ffentlich")).toBe("Öffentlich");
  });

  it("dekodiert &#246; zu ö", () => {
    expect(decodeHtmlEntities("&#246;ffentlich")).toBe("öffentlich");
  });

  it("dekodiert &#252; zu ü", () => {
    expect(decodeHtmlEntities("&#252;ber")).toBe("über");
  });

  it("dekodiert &#196; zu Ä", () => {
    expect(decodeHtmlEntities("&#196;nderung")).toBe("Änderung");
  });

  it("dekodiert &#223; zu ß", () => {
    expect(decodeHtmlEntities("Stra&#223;e")).toBe("Straße");
  });

  // --- Benannte Entities ---

  it("dekodiert &amp; zu &", () => {
    expect(decodeHtmlEntities("Rat &amp; Verwaltung")).toBe("Rat & Verwaltung");
  });

  it("dekodiert &lt; zu <", () => {
    expect(decodeHtmlEntities("A &lt; B")).toBe("A < B");
  });

  it("dekodiert &gt; zu >", () => {
    expect(decodeHtmlEntities("A &gt; B")).toBe("A > B");
  });

  it("dekodiert &quot; zu \"", () => {
    expect(decodeHtmlEntities("Er sagte &quot;Hallo&quot;")).toBe('Er sagte "Hallo"');
  });

  it("dekodiert &apos; zu '", () => {
    expect(decodeHtmlEntities("It&apos;s")).toBe("It's");
  });

  it("dekodiert &ouml; zu ö", () => {
    expect(decodeHtmlEntities("&ouml;ffentlich")).toBe("öffentlich");
  });

  it("dekodiert &Ouml; zu Ö", () => {
    expect(decodeHtmlEntities("&Ouml;ffentlich")).toBe("Öffentlich");
  });

  it("dekodiert &auml; zu ä", () => {
    expect(decodeHtmlEntities("&auml;ndern")).toBe("ändern");
  });

  it("dekodiert &Auml; zu Ä", () => {
    expect(decodeHtmlEntities("&Auml;nderung")).toBe("Änderung");
  });

  it("dekodiert &uuml; zu ü", () => {
    expect(decodeHtmlEntities("&uuml;ber")).toBe("über");
  });

  it("dekodiert &Uuml; zu Ü", () => {
    expect(decodeHtmlEntities("&Uuml;berblick")).toBe("Überblick");
  });

  it("dekodiert &szlig; zu ß", () => {
    expect(decodeHtmlEntities("Stra&szlig;e")).toBe("Straße");
  });

  it("dekodiert &nbsp; zu normalem Leerzeichen", () => {
    expect(decodeHtmlEntities("A&nbsp;B")).toBe("A B");
  });

  // --- Kombiniert ---

  it("dekodiert mehrere Entities in einem String", () => {
    expect(decodeHtmlEntities("&#xD6;ffentliches Protokoll &amp; Niederschrift")).toBe(
      "Öffentliches Protokoll & Niederschrift"
    );
  });

  it("dekodiert gemischte hex und dezimal Entities", () => {
    expect(decodeHtmlEntities("&#xD6;ffentlich &#214;ffentlich")).toBe(
      "Öffentlich Öffentlich"
    );
  });

  // --- Kein Doppel-Dekodieren / kein XSS ---

  it("lässt String ohne Entities unverändert", () => {
    const plain = "Normaler Text ohne Entities";
    expect(decodeHtmlEntities(plain)).toBe(plain);
  });

  it("lässt unbekannte benannte Entities stehen (kein Auflösen)", () => {
    // &foobar; ist unbekannt → bleibt erhalten
    expect(decodeHtmlEntities("&foobar;")).toBe("&foobar;");
  });

  it("dekodiert doppelt enkodiertes &amp;ouml; nur einmal (Ausgabe: &ouml;, kein zweites Dekodieren)", () => {
    // &amp;ouml; → &ouml; (einmaliges Dekodieren — Ausgabe ist Plaintext, kein HTML)
    expect(decodeHtmlEntities("&amp;ouml;")).toBe("&ouml;");
  });

  it("enthält keinen XSS-Vektor (Plaintext-Ausgabe)", () => {
    // Ausgabe ist Plaintext für React-Text-Nodes, daher kein XSS-Risiko.
    // Der Test prüft, dass <script>-Tags NICHT als solche interpretiert werden.
    const input = "&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;";
    const result = decodeHtmlEntities(input);
    // Enthält den literalen Text <script>... aber ist kein HTML — React escapt das beim Rendern
    expect(result).toBe("<script>alert(1)</script>");
    // Kein weiteres Dekodieren von bereits dekodierten Strings
    expect(decodeHtmlEntities(result)).toBe("<script>alert(1)</script>");
  });

  it("leerer String bleibt leer", () => {
    expect(decodeHtmlEntities("")).toBe("");
  });
});
