/**
 * channels.test.ts — Kanal-Schicht (ADR-021).
 *
 * KEIN echter HTTP-Call: fetch wird injiziert. Prüft die Eigenschaften, auf die
 * es ankommt — Permalink immer enthalten, Längenbudget eingehalten, Geheimnisse
 * nie in Fehlertexten, no-op ohne Konfiguration, Byte-Offsets der Bluesky-Facets.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildPostText, digestPermalink, type DigestSummary } from "@/lib/channels/types";
import { sendDigestToMastodon } from "@/lib/channels/mastodon";
import { sendDigestToBluesky } from "@/lib/channels/bluesky";

const digest: DigestSummary = {
  id: "abc-123",
  title: "Kreistag am 15. Juni 2026: Wohnen für Azubis, Verkauf der Rettungswache",
  statements: [
    { text: "Der Kreistag beschloss einstimmig ein Modellprojekt für das Wohnen von Auszubildenden." },
    { text: "Zweite Aussage, die nicht in den Beitrag gehört." },
  ],
  tenantSlug: "taunusstein",
};

const ENV_KEYS = [
  "MASTODON_INSTANCE_URL",
  "MASTODON_ACCESS_TOKEN",
  "BLUESKY_IDENTIFIER",
  "BLUESKY_APP_PASSWORD",
  "BLUESKY_SERVICE",
  "NEXT_PUBLIC_BASE_URL",
  "APP_BASE_URL",
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NEXT_PUBLIC_BASE_URL = "https://partizip.online";
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("buildPostText", () => {
  it("enthält immer den Permalink auf die eigene Seite", () => {
    const { text, url } = buildPostText(digest, 300);
    expect(url).toBe("https://partizip.online/taunusstein/digest/abc-123");
    expect(text).toContain(url);
  });

  it("hält das Zeichenbudget ein und kürzt mit Ellipse", () => {
    const lang: DigestSummary = { ...digest, title: "T".repeat(400) };
    const { text } = buildPostText(lang, 300);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain("…");
  });

  it("postet nur die erste Aussage (Anreißer, kein Volltext)", () => {
    const { text } = buildPostText(digest, 500);
    expect(text).toContain("Modellprojekt für das Wohnen");
    expect(text).not.toContain("Zweite Aussage");
  });

  it("lässt den Anreißer weg, wenn er nicht ins Budget passt", () => {
    const { text, url } = buildPostText(digest, url_len(digest) + 40);
    expect(text).toContain(url);
    expect(text).not.toContain("Modellprojekt");
  });

  it("baut mit mitUrl:false einen Text OHNE Roh-URL (volles Budget für Karten-Posts)", () => {
    const { text, url } = buildPostText(digest, 300, { mitUrl: false });
    expect(text).not.toContain(url);
    expect(text).not.toContain("https://");
    // Ohne URL-Reserve passt der Anreißer wieder rein.
    expect(text).toContain("Modellprojekt für das Wohnen");
    expect(text.length).toBeLessThanOrEqual(300);
    // Die URL wird trotzdem zurückgegeben (Embed-uri braucht sie).
    expect(url).toBe("https://partizip.online/taunusstein/digest/abc-123");
  });

  it("zerschneidet beim Kürzen kein Surrogat-Paar (Emoji/Astralzeichen)", () => {
    // Budget so wählen, dass der Schnitt mitten in einem Emoji (2 Code-Units) läge.
    const emojiTitel: DigestSummary = { ...digest, title: "🏛️📋".repeat(120), statements: [] };
    for (let max = url_len(digest) + 5; max < url_len(digest) + 40; max++) {
      const { text } = buildPostText(emojiTitel, max);
      // TextEncoder ersetzt Lone Surrogates durch U+FFFD — das darf nie passieren.
      const roundtrip = new TextDecoder().decode(new TextEncoder().encode(text));
      expect(roundtrip).not.toContain("�");
      expect(text.length).toBeLessThanOrEqual(max);
    }
  });
});

function url_len(d: DigestSummary): number {
  return digestPermalink(d.tenantSlug, d.id).length;
}

describe("Mastodon", () => {
  it("ist no-op ohne Konfiguration", async () => {
    const r = await sendDigestToMastodon(digest, {
      fetchFn: (() => {
        throw new Error("darf nicht aufgerufen werden");
      }) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(false);
    expect(r.channel).toBe("mastodon");
    expect(r.error).toBeUndefined();
  });

  it("postet öffentlich mit Idempotency-Key und deutschem Sprach-Tag", async () => {
    process.env.MASTODON_INSTANCE_URL = "https://norden.social/";
    process.env.MASTODON_ACCESS_TOKEN = "tok";
    let calledUrl = "";
    let init: RequestInit | undefined;
    const r = await sendDigestToMastodon(digest, {
      fetchFn: (async (u: string, i?: RequestInit) => {
        calledUrl = u;
        init = i;
        return { ok: true, json: async () => ({ url: "https://norden.social/@p/9" }) };
      }) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(true);
    expect(r.url).toBe("https://norden.social/@p/9");
    // Trailing Slash der Instanz wird normalisiert.
    expect(calledUrl).toBe("https://norden.social/api/v1/statuses");
    const headers = init!.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("digest-abc-123");
    const body = JSON.parse(init!.body as string);
    expect(body.visibility).toBe("public");
    expect(body.language).toBe("de");
  });

  it("redigiert den Token aus Fehlermeldungen", async () => {
    process.env.MASTODON_INSTANCE_URL = "https://x.test";
    process.env.MASTODON_ACCESS_TOKEN = "GEHEIM";
    const r = await sendDigestToMastodon(digest, {
      fetchFn: (async () => {
        throw new Error("Verbindung zu GEHEIM fehlgeschlagen");
      }) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(false);
    expect(r.error).not.toContain("GEHEIM");
    expect(r.error).toContain("***");
  });

  it("redigiert auch, wenn der Token die Kürzungsgrenze überlappt", async () => {
    process.env.MASTODON_INSTANCE_URL = "https://x.test";
    process.env.MASTODON_ACCESS_TOKEN = "GEHEIMTOKEN123";
    // Token so platzieren, dass der 200-Zeichen-Schnitt mitten im Token läge —
    // bei Kürzung VOR Redaktion bliebe ein Token-Präfix im Fehlertext stehen.
    const body = "x".repeat(195) + "GEHEIMTOKEN123 und mehr";
    const r = await sendDigestToMastodon(digest, {
      fetchFn: (async () => ({
        ok: false,
        status: 500,
        text: async () => body,
      })) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(false);
    expect(r.error).not.toContain("GEHEIMT");
    expect(r.error).toContain("***");
  });
});

/** Form des createRecord-Records, soweit die Tests sie prüfen. */
interface BskyRecord {
  text: string;
  facets?: Array<{ index: { byteStart: number; byteEnd: number } }>;
  embed?: {
    $type: string;
    external: { uri: string; title: string; description: string; thumb?: { ref: { $link: string } } };
  };
}

/** Mock-Antwort des OG-Bild-Endpoints (Content-Type + Bytes wie echtes fetch). */
function ogImageResponse(byteLength: number) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => new ArrayBuffer(byteLength),
  };
}

/**
 * Digest, dessen statements-Zugriff ab dem ZWEITEN Mal wirft: Der erste Zugriff
 * ist der Fallback-Text (buildPostText), der zweite passiert im Embed-Bau —
 * simuliert einen unerwarteten Fehler, der den KOMPLETTEN Karten-Bau scheitern
 * lässt (nicht nur den Thumb).
 */
function digestMitKaputtemEmbedBau(): DigestSummary {
  let zugriffe = 0;
  return {
    id: digest.id,
    title: digest.title,
    tenantSlug: digest.tenantSlug,
    get statements() {
      zugriffe += 1;
      if (zugriffe > 1) throw new Error("boom im Embed-Bau");
      return digest.statements;
    },
  };
}

describe("Bluesky", () => {
  it("ist no-op ohne Konfiguration", async () => {
    const r = await sendDigestToBluesky(digest, {
      fetchFn: (() => {
        throw new Error("darf nicht aufgerufen werden");
      }) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(false);
    expect(r.channel).toBe("bluesky");
  });

  it("sendet die Vorschaukarte (embed.external mit uri/title/description+thumb), Text OHNE Roh-URL", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    let record: BskyRecord | undefined;
    let uploadContentType: string | undefined;

    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async (u: string, i?: RequestInit) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        if (u.endsWith("/opengraph-image")) {
          // Muss der Digest-Permalink + /opengraph-image sein.
          expect(u).toBe(`${digestPermalink(digest.tenantSlug, digest.id)}/opengraph-image`);
          return ogImageResponse(1234);
        }
        if (u.includes("uploadBlob")) {
          uploadContentType = (i!.headers as Record<string, string>)["Content-Type"];
          return {
            ok: true,
            json: async () => ({
              blob: { $type: "blob", ref: { $link: "bafycid" }, mimeType: "image/png", size: 1234 },
            }),
          };
        }
        record = JSON.parse(i!.body as string).record;
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });

    expect(r.sent).toBe(true);
    const url = digestPermalink(digest.tenantSlug, digest.id);
    expect(record!.embed!.$type).toBe("app.bsky.embed.external");
    expect(record!.embed!.external.uri).toBe(url);
    // Titel/Anreißer sind kurz genug → ungekürzt in der Karte.
    expect(record!.embed!.external.title).toBe(digest.title);
    expect(record!.embed!.external.description).toContain("Modellprojekt für das Wohnen");
    expect(record!.embed!.external.thumb).toMatchObject({ ref: { $link: "bafycid" } });
    // Content-Type des OG-Bilds wird an uploadBlob durchgereicht.
    expect(uploadContentType).toBe("image/png");
    // Die Karte trägt den Link — KEINE Roh-URL im Text, kein Facet nötig.
    expect(record!.text).not.toContain(url);
    expect(record!.text).not.toContain("https://");
    expect(record!.facets).toBeUndefined();
  });

  it("sendet die Karte OHNE thumb, wenn der OG-Bild-Fetch fehlschlägt", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    // Ohne Aussagen greift zusätzlich die neutrale Fallback-Beschreibung.
    const ohneAussagen: DigestSummary = { ...digest, statements: [] };
    let record: BskyRecord | undefined;
    let uploadAufgerufen = false;

    const r = await sendDigestToBluesky(ohneAussagen, {
      fetchFn: (async (u: string, i?: RequestInit) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        if (u.endsWith("/opengraph-image")) {
          throw new Error("Netzwerkfehler beim OG-Bild");
        }
        if (u.includes("uploadBlob")) {
          uploadAufgerufen = true;
        }
        record = JSON.parse(i!.body as string).record;
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });

    expect(r.sent).toBe(true);
    expect(uploadAufgerufen).toBe(false);
    expect(record!.embed!.external.uri).toBe(digestPermalink(digest.tenantSlug, digest.id));
    expect(record!.embed!.external.thumb).toBeUndefined();
    expect(record!.embed!.external.description).toBe(
      "Quellengeprüfte Kurzfassung auf Partizip — jede Aussage mit Quellenlink.",
    );
    expect(record!.text).not.toContain("https://");
  });

  it("sendet die Karte OHNE thumb, wenn uploadBlob fehlschlägt", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    let record: BskyRecord | undefined;

    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async (u: string, i?: RequestInit) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        if (u.endsWith("/opengraph-image")) {
          return ogImageResponse(1234);
        }
        if (u.includes("uploadBlob")) {
          return { ok: false, status: 500, text: async () => "kaputt" };
        }
        record = JSON.parse(i!.body as string).record;
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });

    expect(r.sent).toBe(true);
    expect(record!.embed!.external.thumb).toBeUndefined();
    expect(record!.embed!.external.title).toBe(digest.title);
    expect(record!.text).not.toContain("https://");
  });

  it("verwendet zu große OG-Bilder nicht als thumb (Blob-Limit)", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    let record: BskyRecord | undefined;
    let uploadAufgerufen = false;

    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async (u: string, i?: RequestInit) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        if (u.endsWith("/opengraph-image")) {
          return ogImageResponse(900_001); // 1 Byte über dem Limit
        }
        if (u.includes("uploadBlob")) {
          uploadAufgerufen = true;
        }
        record = JSON.parse(i!.body as string).record;
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });

    expect(r.sent).toBe(true);
    expect(uploadAufgerufen).toBe(false);
    expect(record!.embed!.external.thumb).toBeUndefined();
  });

  it("fällt bei Fehler im kompletten Embed-Bau auf Text mit URL + Link-Facet zurück (sent:true, korrekte UTF-8-Byte-Offsets)", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    let record: BskyRecord | undefined;

    const r = await sendDigestToBluesky(digestMitKaputtemEmbedBau(), {
      fetchFn: (async (u: string, i?: RequestInit) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        record = JSON.parse(i!.body as string).record;
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });

    // Der Fehler im Embed-Bau bricht den Versand NICHT ab — bisheriges Verhalten.
    expect(r.sent).toBe(true);
    const url = digestPermalink(digest.tenantSlug, digest.id);
    expect(record!.text).toContain(url);
    expect(record!.embed).toBeUndefined();
    const facet = record!.facets![0];
    // Der durch die Byte-Offsets adressierte Ausschnitt MUSS exakt die URL sein.
    const bytes = new TextEncoder().encode(record!.text);
    const slice = new TextDecoder().decode(bytes.slice(facet.index.byteStart, facet.index.byteEnd));
    expect(slice).toBe(url);
  });

  it("baut die Post-URL aus der DID der AT-URI (nie aus BLUESKY_IDENTIFIER — kann E-Mail sein)", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async (u: string) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        return {
          ok: true,
          json: async () => ({ uri: "at://did:plc:x/app.bsky.feed.post/3kabc123" }),
        };
      }) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(true);
    expect(r.url).toBe("https://bsky.app/profile/did:plc:x/post/3kabc123");
  });

  it("meldet Erfolg ohne url, wenn die Antwort keine uri enthält", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async (u: string) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(true);
    expect(r.url).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("übergibt JEDEM Call ein Timeout-Signal (hängender Kanal blockiert nie)", async () => {
    process.env.BLUESKY_IDENTIFIER = "partizip.online";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    const signals: Array<unknown> = [];
    await sendDigestToBluesky(digest, {
      fetchFn: (async (u: string, i?: RequestInit) => {
        signals.push(i?.signal);
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "jwt", did: "did:plc:x" }) };
        }
        if (u.endsWith("/opengraph-image")) return ogImageResponse(1234);
        return { ok: true, json: async () => ({ blob: { $type: "blob" } }) };
      }) as unknown as typeof fetch,
    });
    // createSession + OG-Bild + uploadBlob + createRecord — ausnahmslos mit Timeout.
    expect(signals).toHaveLength(4);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("redigiert das App-Passwort aus Fehlermeldungen", async () => {
    process.env.BLUESKY_IDENTIFIER = "x.test";
    process.env.BLUESKY_APP_PASSWORD = "SUPERGEHEIM";
    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async () => ({
        ok: false,
        status: 401,
        text: async () => "invalid password SUPERGEHEIM",
      })) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(false);
    expect(r.error).not.toContain("SUPERGEHEIM");
    expect(r.error).toContain("***");
  });

  it("redigiert auch, wenn das Passwort die Kürzungsgrenze überlappt", async () => {
    process.env.BLUESKY_IDENTIFIER = "x.test";
    process.env.BLUESKY_APP_PASSWORD = "SUPERGEHEIM";
    // Passwort so platzieren, dass der 160-Zeichen-Schnitt mitten im Secret läge —
    // bei Kürzung VOR Redaktion bliebe ein Passwort-Präfix im Fehlertext stehen.
    const body = "x".repeat(155) + "SUPERGEHEIM und mehr";
    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async () => ({
        ok: false,
        status: 401,
        text: async () => body,
      })) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(false);
    expect(r.error).not.toContain("SUPERG");
    expect(r.error).toContain("***");
  });

  it("redigiert das Session-JWT aus createRecord-Fehlern", async () => {
    process.env.BLUESKY_IDENTIFIER = "x.test";
    process.env.BLUESKY_APP_PASSWORD = "app-pw";
    const r = await sendDigestToBluesky(digest, {
      fetchFn: (async (u: string) => {
        if (u.includes("createSession")) {
          return { ok: true, json: async () => ({ accessJwt: "JWT-GANZ-GEHEIM", did: "did:plc:x" }) };
        }
        // Fehlkonfigurierter Proxy/Debug-Endpoint echot den Authorization-Header.
        return {
          ok: false,
          status: 400,
          text: async () => "debug: Authorization: Bearer JWT-GANZ-GEHEIM",
        };
      }) as unknown as typeof fetch,
    });
    expect(r.sent).toBe(false);
    expect(r.error).not.toContain("JWT-GANZ-GEHEIM");
    expect(r.error).toContain("***");
  });
});
