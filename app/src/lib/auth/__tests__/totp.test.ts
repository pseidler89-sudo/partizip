/**
 * Testvektoren aus RFC 4226 (HOTP, Appendix D) und RFC 6238 (TOTP, Appendix B).
 * Diese Tests SIND die Spezifikation der Implementierung — wer totp.ts ändert,
 * muss sie grün halten. Das gemeinsame Secret der RFCs ist der ASCII-String
 * "12345678901234567890" (20 Byte).
 */

import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  hotp,
  totpCode,
  verifyTotp,
  generateTotpSecret,
  otpauthUri,
  encryptTotpSecret,
  decryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  totpCounter,
  TOTP_STEP_SECONDS,
  RECOVERY_CODE_COUNT,
} from "../totp";

const RFC_SECRET = Buffer.from("12345678901234567890", "utf8");
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

describe("base32 (RFC 4648)", () => {
  it("kodiert das RFC-Secret wie erwartet", () => {
    expect(RFC_SECRET_B32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("ist umkehrbar", () => {
    expect(base32Decode(RFC_SECRET_B32).equals(RFC_SECRET)).toBe(true);
  });

  it("verträgt Kleinschreibung, Leerzeichen und Padding", () => {
    const mit = ` ${RFC_SECRET_B32.toLowerCase()} `.replace(/(.{8})/g, "$1 ") + "==";
    expect(base32Decode(mit).equals(RFC_SECRET)).toBe(true);
  });

  it("wirft bei ungültigen Zeichen", () => {
    expect(() => base32Decode("ABC!")).toThrow();
  });

  it("kodiert Längen, die nicht auf 5-Bit-Grenzen fallen, verlustfrei", () => {
    for (let len = 1; len <= 21; len++) {
      const buf = Buffer.alloc(len, len);
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });
});

describe("HOTP — RFC 4226 Appendix D", () => {
  // Zähler 0..9 mit dem RFC-Secret, 6 Stellen.
  const erwartet = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];

  it.each(erwartet.map((code, counter) => [counter, code]))(
    "Zähler %i ergibt %s",
    (counter, code) => {
      expect(hotp(RFC_SECRET, counter as number)).toBe(code);
    }
  );
});

describe("TOTP — RFC 6238 Appendix B (SHA-1)", () => {
  // Der RFC listet 8-stellige Codes; die letzten 6 Stellen sind der 6-stellige Code.
  const vektoren: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  it.each(vektoren)("t=%i ergibt %s", (sekunden, code) => {
    expect(totpCode(RFC_SECRET_B32, new Date(sekunden * 1000))).toBe(code);
  });

  it("zählt Zeitschritte in 30-Sekunden-Fenstern", () => {
    expect(totpCounter(new Date(59_000))).toBe(1);
    expect(totpCounter(new Date(60_000))).toBe(2);
    expect(TOTP_STEP_SECONDS).toBe(30);
  });
});

describe("verifyTotp", () => {
  const jetzt = new Date(1_700_000_000_000);

  it("akzeptiert den aktuellen Code", () => {
    const code = totpCode(RFC_SECRET_B32, jetzt);
    expect(verifyTotp(RFC_SECRET_B32, code, { at: jetzt })).toEqual({
      ok: true,
      step: totpCounter(jetzt),
    });
  });

  it("akzeptiert den vorherigen und den nächsten Zeitschritt (Uhrendrift)", () => {
    for (const versatz of [-TOTP_STEP_SECONDS, TOTP_STEP_SECONDS]) {
      const code = totpCode(RFC_SECRET_B32, new Date(jetzt.getTime() + versatz * 1000));
      const res = verifyTotp(RFC_SECRET_B32, code, { at: jetzt });
      expect(res.ok).toBe(true);
    }
  });

  it("lehnt zwei Zeitschritte entfernte Codes ab", () => {
    for (const versatz of [-2 * TOTP_STEP_SECONDS, 2 * TOTP_STEP_SECONDS]) {
      const code = totpCode(RFC_SECRET_B32, new Date(jetzt.getTime() + versatz * 1000));
      expect(verifyTotp(RFC_SECRET_B32, code, { at: jetzt })).toEqual({ ok: false, grund: "falsch" });
    }
  });

  it("lehnt falsche Codes ab", () => {
    expect(verifyTotp(RFC_SECRET_B32, "000000", { at: jetzt }).ok).toBe(false);
  });

  it("lehnt Codes mit falschem Format ab, ohne das Secret zu prüfen", () => {
    for (const eingabe of ["", "12345", "1234567", "abcdef", "12 34 5"]) {
      expect(verifyTotp(RFC_SECRET_B32, eingabe, { at: jetzt })).toEqual({ ok: false, grund: "format" });
    }
  });

  it("ignoriert Leerzeichen in der Eingabe", () => {
    const code = totpCode(RFC_SECRET_B32, jetzt);
    const mitLuecke = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(RFC_SECRET_B32, mitLuecke, { at: jetzt }).ok).toBe(true);
  });

  // Kern der Wiederverwendungssperre: ohne sie bliebe ein abgefangener Code bis
  // zu drei Zeitschritte lang gültig.
  it("lehnt einen bereits verwendeten Zeitschritt ab", () => {
    const step = totpCounter(jetzt);
    const code = totpCode(RFC_SECRET_B32, jetzt);
    expect(verifyTotp(RFC_SECRET_B32, code, { at: jetzt, letzterVerwendeterStep: step })).toEqual({
      ok: false,
      grund: "wiederverwendet",
    });
  });

  it("lehnt auch ältere Zeitschritte als den zuletzt verwendeten ab", () => {
    const vorher = new Date(jetzt.getTime() - TOTP_STEP_SECONDS * 1000);
    const code = totpCode(RFC_SECRET_B32, vorher);
    expect(
      verifyTotp(RFC_SECRET_B32, code, { at: jetzt, letzterVerwendeterStep: totpCounter(jetzt) })
    ).toEqual({ ok: false, grund: "wiederverwendet" });
  });

  it("akzeptiert den nächsten Zeitschritt nach einer Verwendung", () => {
    const spaeter = new Date(jetzt.getTime() + TOTP_STEP_SECONDS * 1000);
    const code = totpCode(RFC_SECRET_B32, spaeter);
    const res = verifyTotp(RFC_SECRET_B32, code, {
      at: spaeter,
      letzterVerwendeterStep: totpCounter(jetzt),
    });
    expect(res).toEqual({ ok: true, step: totpCounter(spaeter) });
  });
});

describe("generateTotpSecret", () => {
  it("liefert 32 Base32-Zeichen (20 Byte Entropie)", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s).length).toBe(20);
  });

  it("liefert bei jedem Aufruf ein anderes Secret", () => {
    const menge = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(menge.size).toBe(50);
  });
});

describe("otpauthUri", () => {
  it("enthält Secret, Herausgeber und die RFC-Defaults", () => {
    const uri = otpauthUri({
      secretBase32: RFC_SECRET_B32,
      konto: "admin@example.org",
      herausgeber: "Partizip Musterstadt",
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET_B32}`);
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    // Label und issuer müssen kodiert sein, sonst zerlegt die App den URI falsch.
    expect(uri).toContain(encodeURIComponent("Partizip Musterstadt:admin@example.org"));
  });
});

describe("Verschlüsselung des Secrets", () => {
  it("ist umkehrbar", () => {
    const s = generateTotpSecret();
    expect(decryptTotpSecret(encryptTotpSecret(s))).toBe(s);
  });

  it("erzeugt bei gleichem Klartext unterschiedliche Chiffrate (zufälliger IV)", () => {
    const s = generateTotpSecret();
    expect(encryptTotpSecret(s)).not.toBe(encryptTotpSecret(s));
  });

  it("enthält das Secret nicht im Klartext", () => {
    const s = generateTotpSecret();
    expect(encryptTotpSecret(s)).not.toContain(s);
  });

  it("wirft bei manipuliertem Chiffrat (GCM-Authentizität)", () => {
    const gespeichert = encryptTotpSecret(generateTotpSecret());
    const teile = gespeichert.split(".");
    const letztesZeichen = teile[3].slice(-1) === "0" ? "1" : "0";
    teile[3] = teile[3].slice(0, -1) + letztesZeichen;
    expect(() => decryptTotpSecret(teile.join("."))).toThrow();
  });

  it("wirft bei unbekanntem Format", () => {
    expect(() => decryptTotpSecret("nur-müll")).toThrow();
  });
});

describe("Wiederherstellungscodes", () => {
  it("erzeugt die vereinbarte Anzahl im Format XXXXX-XXXXX", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  it("erzeugt keine Dubletten", () => {
    const codes = generateRecoveryCodes(100);
    expect(new Set(codes).size).toBe(100);
  });

  it("hasht unabhängig von Schreibweise, Bindestrich und Leerzeichen", () => {
    const [code] = generateRecoveryCodes(1);
    const roh = code.replace("-", "");
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(` ${roh} `)).toBe(hashRecoveryCode(code));
  });

  it("liefert verschiedene Hashes für verschiedene Codes", () => {
    const codes = generateRecoveryCodes(20);
    expect(new Set(codes.map(hashRecoveryCode)).size).toBe(20);
  });

  it("gibt den Code nicht im Hash preis", () => {
    const [code] = generateRecoveryCodes(1);
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code)).not.toContain(code.replace("-", ""));
  });
});
