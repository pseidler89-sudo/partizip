/**
 * safe-redirect.test.ts — Open-Redirect-Schutz (Unit)
 *
 * Angriffs-Tabelle: alles, was auf einen fremden Host, ein Schema oder eine
 * Backslash-Normalisierung hinauslaufen könnte, muss auf den Fallback fallen.
 * Nur same-origin-relative Pfade passieren unverändert.
 */

import { describe, it, expect } from "vitest";
import { safeRedirectPath, DEFAULT_LOGIN_REDIRECT } from "@/lib/auth/safe-redirect";

describe("safeRedirectPath", () => {
  it("Angriffs-Tabelle: unsichere Ziele fallen auf den Fallback", () => {
    const angriffe: unknown[] = [
      "//evil.tld",
      "//evil.tld/pfad",
      "https://evil.tld",
      "http://evil.tld/konto",
      "/\\evil.tld",
      "\\evil.tld",
      "/pfad\\..\\evil",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "mailto:a@b.tld",
      "evil.tld",
      "konto", // relativ ohne führenden Slash
      "",
      "/pfad\r\nSet-Cookie:x=1", // Header-Injection
      "/pfad\u0000x", // eingebettetes NUL-Steuerzeichen
      " /konto", // führendes Leerzeichen → kein "/"-Prefix
      null,
      undefined,
      42,
      { toString: () => "/konto" },
    ];

    for (const angriff of angriffe) {
      expect(safeRedirectPath(angriff), `Eingabe: ${JSON.stringify(angriff)}`).toBe(
        DEFAULT_LOGIN_REDIRECT
      );
    }
  });

  it("erlaubte relative Pfade passieren unverändert", () => {
    const erlaubt = [
      "/pfad?x=1",
      "/konto",
      "/",
      "/umfrage/abc-123",
      "/umfragen?filter=offen&seite=2",
      "/konto#einstellungen",
    ];

    for (const pfad of erlaubt) {
      expect(safeRedirectPath(pfad), `Eingabe: ${pfad}`).toBe(pfad);
    }
  });

  it("Default-Fallback ist /konto, eigener Fallback wird respektiert", () => {
    expect(DEFAULT_LOGIN_REDIRECT).toBe("/konto");
    expect(safeRedirectPath("https://evil.tld", "/start")).toBe("/start");
    expect(safeRedirectPath("/ziel", "/start")).toBe("/ziel");
  });
});
