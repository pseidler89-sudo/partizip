/**
 * client-ip.test.ts — Tests für die gemeinsame Client-IP-Ermittlung (P1-2).
 *
 * Kernanforderung: Es zählt das LETZTE x-forwarded-for-Element (vom eigenen
 * Proxy angehängt). Ein Client, der den Header selbst mitschickt, darf die
 * ermittelte IP NICHT kontrollieren (sonst Rate-Limits per Header rotierbar).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { clientIpFromForwardedFor } from "@/lib/client-ip";

describe("clientIpFromForwardedFor", () => {
  it("liefert das letzte Element (Proxy-Anhang), nicht das erste", () => {
    expect(clientIpFromForwardedFor("203.0.113.7, 198.51.100.23")).toBe(
      "198.51.100.23"
    );
  });

  it("Spoofing-Szenario: gefälschte Client-Angabe vorne wird ignoriert", () => {
    // Client sendet x-forwarded-for: 10.0.0.1 — Traefik hängt die echte IP an.
    expect(
      clientIpFromForwardedFor("10.0.0.1, 10.0.0.2, 198.51.100.23")
    ).toBe("198.51.100.23");
  });

  it("einzelner Wert wird getrimmt zurückgegeben", () => {
    expect(clientIpFromForwardedFor("  198.51.100.23  ")).toBe("198.51.100.23");
  });

  it("null/leer/nur Kommata → null", () => {
    expect(clientIpFromForwardedFor(null)).toBeNull();
    expect(clientIpFromForwardedFor("")).toBeNull();
    expect(clientIpFromForwardedFor(" , ,")).toBeNull();
  });

  it("leere Segmente (doppelte/abschließende Kommata) werden übersprungen", () => {
    expect(clientIpFromForwardedFor("10.0.0.1,, 198.51.100.23, ")).toBe(
      "198.51.100.23"
    );
  });
});

describe("getClientIp (Server-Action-Variante, echte Funktion)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("next/headers");
  });

  async function withHeaders(headerMap: Record<string, string>) {
    vi.doMock("next/headers", () => ({
      headers: async () => ({
        get: (name: string) => headerMap[name.toLowerCase()] ?? null,
      }),
      cookies: async () => ({ get: () => undefined }),
    }));
    const mod = await import("@/lib/auth/action-context");
    return mod.getClientIp();
  }

  it("nimmt das LETZTE x-forwarded-for-Element", async () => {
    const ip = await withHeaders({
      "x-forwarded-for": "10.0.0.1, 198.51.100.23",
    });
    expect(ip).toBe("198.51.100.23");
  });

  it("KEIN x-real-ip-Fallback (client-kontrollierbar bei Direktzugriff)", async () => {
    const ip = await withHeaders({ "x-real-ip": "10.9.9.9" });
    expect(ip).toBeNull();
  });

  it("ohne Header → null (Rate-Limit-Dimension entfällt)", async () => {
    const ip = await withHeaders({});
    expect(ip).toBeNull();
  });
});
