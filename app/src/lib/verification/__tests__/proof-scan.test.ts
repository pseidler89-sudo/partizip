import { describe, it, expect } from "vitest";
import { extrahiereProofToken } from "../proof-scan";

// Ein realistischer base64url-Token (43 Zeichen, wie generateRawToken ihn liefert).
const TOKEN = "aB3-_xY7zQ9kLmNoPqRsTuVwXyZ012345678AbCdEfG";

describe("extrahiereProofToken", () => {
  it("zieht proof aus absoluter URL", () => {
    expect(
      extrahiereProofToken(`https://taunusstein.partizip.online/taunusstein/verifizieren/bestaetigen?proof=${TOKEN}`),
    ).toBe(TOKEN);
  });

  it("zieht proof aus absoluter URL mit weiteren Query-Parametern", () => {
    expect(
      extrahiereProofToken(`https://host.example/slug/verifizieren/bestaetigen?foo=1&proof=${TOKEN}&bar=2`),
    ).toBe(TOKEN);
  });

  it("zieht proof aus relativem Pfad", () => {
    expect(extrahiereProofToken(`/taunusstein/verifizieren/bestaetigen?proof=${TOKEN}`)).toBe(TOKEN);
  });

  it("akzeptiert einen nackten Klartext-Code", () => {
    expect(extrahiereProofToken(TOKEN)).toBe(TOKEN);
  });

  it("trimmt umgebenden Whitespace beim nackten Code", () => {
    expect(extrahiereProofToken(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  it("trimmt Whitespace um eine URL", () => {
    expect(
      extrahiereProofToken(`  https://host.example/s/verifizieren/bestaetigen?proof=${TOKEN}  `),
    ).toBe(TOKEN);
  });

  it("gibt null für eine URL ohne proof-Parameter", () => {
    expect(extrahiereProofToken("https://host.example/slug/verifizieren/bestaetigen")).toBeNull();
    expect(extrahiereProofToken("https://host.example/slug/verifizieren/bestaetigen?foo=bar")).toBeNull();
  });

  it("gibt null für einen leeren proof-Parameter", () => {
    expect(extrahiereProofToken("https://host.example/x?proof=")).toBeNull();
    expect(extrahiereProofToken("https://host.example/x?proof=%20%20")).toBeNull();
  });

  it("gibt null für leeren oder reinen Whitespace-Input", () => {
    expect(extrahiereProofToken("")).toBeNull();
    expect(extrahiereProofToken("   ")).toBeNull();
    expect(extrahiereProofToken("\n\t")).toBeNull();
  });

  it("gibt null für Müll mit Sonderzeichen (nackter Code)", () => {
    expect(extrahiereProofToken("hallo welt")).toBeNull();
    expect(extrahiereProofToken("kein token!!! ###")).toBeNull();
    expect(extrahiereProofToken("https://boese.example/phish")).toBeNull();
  });

  it("gibt null für einen zu kurzen nackten Code", () => {
    expect(extrahiereProofToken("kurz")).toBeNull();
    expect(extrahiereProofToken("abc123")).toBeNull();
  });

  it("gibt null für einen kaputten URL-artigen String", () => {
    // beginnt mit http, ist aber keine parsebare URL
    expect(extrahiereProofToken("http://")).toBeNull();
  });

  it("verwirft einen URL-proof-Wert mit Sonderzeichen", () => {
    expect(extrahiereProofToken("https://host.example/x?proof=nicht%20gut!")).toBeNull();
  });

  // --- Angriffs-Anker: die gescannte Herkunft (Host/Schema) wird bewusst NIE
  //     zur Navigation genutzt; nur der proof-Token wird gezogen. Diese Fälle
  //     dokumentieren, dass ein feindlicher QR keinen Off-Site-/XSS-Vektor liefert.
  it("ignoriert den Host einer fremden URL und zieht nur den Token", () => {
    // evil.com wird verworfen — nur der Token bleibt (Navigation baut den Pfad lokal)
    expect(extrahiereProofToken(`https://evil.com/phish?proof=${TOKEN}`)).toBe(TOKEN);
  });

  it("liefert keinen Token aus einem javascript:-Schema", () => {
    expect(extrahiereProofToken(`javascript:alert(1)?proof=${TOKEN}`)).toBeNull();
    expect(extrahiereProofToken("javascript:alert(1)")).toBeNull();
  });

  it("liefert keinen Token aus einem data:-Schema", () => {
    expect(extrahiereProofToken(`data:text/html,x?proof=${TOKEN}`)).toBeNull();
  });

  it("verwirft einen überlangen Pseudo-Token (Obergrenze)", () => {
    expect(extrahiereProofToken("A".repeat(5000))).toBeNull();
    expect(extrahiereProofToken(`https://host.example/x?proof=${"A".repeat(5000)}`)).toBeNull();
  });

  it("ist tolerant gegenüber nicht-String-Eingaben", () => {
    // @ts-expect-error absichtlich falscher Typ zur Laufzeit-Härtung
    expect(extrahiereProofToken(null)).toBeNull();
    // @ts-expect-error absichtlich falscher Typ zur Laufzeit-Härtung
    expect(extrahiereProofToken(undefined)).toBeNull();
  });
});
