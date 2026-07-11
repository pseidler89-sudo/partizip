/**
 * bluesky.ts — AT-Protocol/Bluesky-Kanal (ADR-021).
 *
 * Offenes Protokoll (AT), aber Bluesky Social ist ein US-Unternehmen — deshalb
 * bewusst ZWEITRANGIG hinter Mastodon: Reichweite (Journalismus/Politik) zum
 * Preis geringerer Souveränität. Auch hier gilt: der Beitrag ist nur Anreißer +
 * Permalink; der Inhalt lebt auf dem eigenen Server.
 *
 * No-op ohne Konfiguration. Fehler brechen die Veröffentlichung nie ab.
 *
 * Env:
 *   BLUESKY_IDENTIFIER  — Handle, z. B. "partizip.online" (per DNS verifiziert)
 *   BLUESKY_APP_PASSWORD — App-Passwort (NIEMALS das Konto-Passwort!)
 *   BLUESKY_SERVICE     — optional, Default "https://bsky.social"
 *
 * Ablauf (XRPC, kein SDK nötig): createSession → createRecord (app.bsky.feed.post).
 *
 * VORSCHAUKARTE: Bluesky erzeugt Link-Karten NICHT empfängerseitig aus den
 * OG-Tags des Ziels (anders als Mastodon) — sie müssen als
 * `app.bsky.embed.external` mitgesendet werden, sonst wirkt der Beitrag als
 * Plaintext mit abgeschnittener URL. Deshalb: best-effort eine Karte bauen
 * (Titel, Anreißer, Thumb aus dem eigenen serverseitigen OG-Bild via
 * uploadBlob) und die Roh-URL aus dem Text lassen. Schlägt IRGENDETWAS davon
 * fehl, greift das bisherige Verhalten: Text mit URL, klickbar via
 * RichText-Facet (Byte-Offsets, nicht Zeichen-Offsets — UTF-8!).
 */

import {
  buildPostText,
  kuerzen,
  type ChannelResult,
  type DigestSummary,
} from "./types";

/** Bluesky: 300 Graphem-Zeichen; die URL zählt voll mit. */
const MAX_CHARS = 300;
const CHANNEL = "bluesky";

/** Harte Obergrenze pro HTTP-Call — ein hängender Kanal darf die Aktion nicht blockieren. */
const TIMEOUT_MS = 10_000;

/** Bluesky-Blob-Limit ist ~1 MB — größere OG-Bilder gar nicht erst hochladen. */
const MAX_THUMB_BYTES = 900_000;

/** Kartentitel/-beschreibung: Bluesky rendert ohnehin nur wenige Zeilen. */
const MAX_CARD_TITLE_CHARS = 150;
const MAX_CARD_DESCRIPTION_CHARS = 200;

const FALLBACK_CARD_DESCRIPTION =
  "Quellengeprüfte Kurzfassung auf Partizip — jede Aussage mit Quellenlink.";

/**
 * Baut aus der createRecord-AT-URI (at://<did>/app.bsky.feed.post/<rkey>) die
 * öffentliche Web-URL des Beitrags. Best-effort: bei unerwartetem Format undefined.
 *
 * Bewusst die DID aus der AT-URI statt BLUESKY_IDENTIFIER: createSession
 * akzeptiert als identifier auch die Konto-E-Mail — die dürfte weder im Audit
 * landen (PII) noch ergäbe sie eine gültige URL. Die DID ist kanonisch,
 * bsky.app löst DID-Profil-URLs immer auf.
 */
function postUrlFromAtUri(atUri: string | undefined): string | undefined {
  if (!atUri) return undefined;
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(atUri);
  if (!m) return undefined;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}

/** Entfernt alle bekannten Geheimnisse (App-Passwort, Session-JWT) aus Fehlertexten. */
function redact(msg: string, secrets: Array<string | undefined>): string {
  let out = msg;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

export interface BlueskyDeps {
  fetchFn?: typeof fetch;
}

export async function sendDigestToBluesky(
  digest: DigestSummary,
  deps: BlueskyDeps = {},
): Promise<ChannelResult> {
  const identifier = process.env.BLUESKY_IDENTIFIER?.trim();
  const password = process.env.BLUESKY_APP_PASSWORD?.trim();
  const service = (process.env.BLUESKY_SERVICE?.trim() || "https://bsky.social").replace(/\/+$/, "");

  if (!identifier || !password) {
    console.log("[Bluesky] Nicht konfiguriert — kein Versand.");
    return { sent: false, channel: CHANNEL };
  }

  const doFetch = deps.fetchFn ?? fetch;
  const { text, url } = buildPostText(digest, MAX_CHARS);

  // Außerhalb des try, damit der catch auch das Session-JWT redigieren kann.
  let auth: { accessJwt?: string; did?: string } = {};

  try {
    // 1. Session (App-Passwort → kurzlebiges accessJwt)
    const authRes = await doFetch(`${service}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
      // Timeout: Abbruch landet im catch unten als normales Fehler-Result.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!authRes.ok) {
      const body = await authRes.text().catch(() => "");
      return {
        sent: false,
        channel: CHANNEL,
        // Erst redigieren, DANN kürzen — sonst kann der Schnitt mitten im
        // Secret liegen und ein Präfix davon ungeredacted durchrutschen.
        error: `Auth HTTP ${authRes.status}: ${redact(body, [password]).slice(0, 160)}`,
      };
    }
    auth = (await authRes.json()) as { accessJwt?: string; did?: string };
    if (!auth.accessJwt || !auth.did) {
      return { sent: false, channel: CHANNEL, error: "Auth-Antwort ohne accessJwt/did." };
    }

    // 2. Vorschaukarte (app.bsky.embed.external) bauen — BEST-EFFORT in eigenem
    // try/catch: JEDER Fehler hier führt zum bisherigen Verhalten (Text mit URL
    // + Link-Facet), nie zum Abbruch des Versands.
    let karte:
      | { text: string; embed: { $type: string; external: Record<string, unknown> } }
      | undefined;
    try {
      const first = digest.statements[0]?.text?.trim();
      const external: Record<string, unknown> = {
        uri: url,
        title: kuerzen(digest.title.trim(), MAX_CARD_TITLE_CHARS),
        description: first
          ? kuerzen(first, MAX_CARD_DESCRIPTION_CHARS)
          : FALLBACK_CARD_DESCRIPTION,
      };

      // Thumb: das serverseitig erzeugte OG-Bild des Permalinks als Blob
      // hochladen. Eigener try/catch — Thumb-Fehlschlag ⇒ Karte trotzdem
      // senden, nur ohne Bild (besser als gar keine Karte).
      try {
        const imgRes = await doFetch(`${url}/opengraph-image`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const imgType = imgRes.headers.get("content-type") ?? "";
        if (imgRes.ok && imgType.startsWith("image/")) {
          const bytes = await imgRes.arrayBuffer();
          if (bytes.byteLength > 0 && bytes.byteLength <= MAX_THUMB_BYTES) {
            const blobRes = await doFetch(`${service}/xrpc/com.atproto.repo.uploadBlob`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${auth.accessJwt}`,
                // Content-Type der Bild-Antwort durchreichen (PNG/JPEG/…).
                "Content-Type": imgType,
              },
              body: bytes,
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (blobRes.ok) {
              const blobData = (await blobRes.json().catch(() => ({}))) as {
                blob?: unknown;
              };
              if (blobData.blob) external.thumb = blobData.blob;
            }
          }
        }
      } catch {
        // Thumb ist optional — Karte ohne Bild trotzdem senden.
      }

      // Mit Karte trägt das Embed den Link: Roh-URL raus aus dem Text, dafür
      // volles 300-Zeichen-Budget für Titel + Anreißer; kein Facet nötig.
      const { text: kartenText } = buildPostText(digest, MAX_CHARS, { mitUrl: false });
      karte = { text: kartenText, embed: { $type: "app.bsky.embed.external", external } };
    } catch {
      karte = undefined; // Fallback unten: Text mit URL + Link-Facet.
    }

    // 3. Post bauen. Ohne Karte: Link als Facet klickbar machen — Offsets sind
    // BYTE-Positionen (UTF-8).
    const enc = new TextEncoder();
    const byteStart = enc.encode(text.slice(0, text.lastIndexOf(url))).length;
    const byteEnd = byteStart + enc.encode(url).length;

    const post = karte
      ? {
          $type: "app.bsky.feed.post",
          text: karte.text,
          createdAt: new Date().toISOString(),
          langs: ["de"],
          embed: karte.embed,
        }
      : {
          $type: "app.bsky.feed.post",
          text,
          createdAt: new Date().toISOString(),
          langs: ["de"],
          facets: [
            {
              index: { byteStart, byteEnd },
              features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
            },
          ],
        };

    const postRes = await doFetch(`${service}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.post", record: post }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!postRes.ok) {
      const body = await postRes.text().catch(() => "");
      return {
        sent: false,
        channel: CHANNEL,
        // Erst redigieren, dann kürzen (s. o.); zusätzlich das Session-JWT —
        // ein Proxy/Debug-Endpoint könnte den Authorization-Header zurückechoen.
        error: `Post HTTP ${postRes.status}: ${redact(body, [password, auth.accessJwt]).slice(0, 160)}`,
      };
    }

    // Post-URL aus der AT-URI ableiten (fürs Audit) — best-effort, kein Fehler bei Lücke.
    const data = (await postRes.json().catch(() => ({}))) as { uri?: string };
    const postUrl = postUrlFromAtUri(data.uri);

    console.log(`[Bluesky] Digest "${digest.title}" veröffentlicht.`);
    return { sent: true, channel: CHANNEL, url: postUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sent: false, channel: CHANNEL, error: redact(msg, [password, auth.accessJwt]) };
  }
}
