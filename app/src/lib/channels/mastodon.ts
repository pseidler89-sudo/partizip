/**
 * mastodon.ts — ActivityPub/Mastodon-Kanal (ADR-021).
 *
 * ActivityPub ist ein W3C-Standard; die Instanz ist frei wählbar und notfalls
 * selbst hostbar — das ist der souveränste verfügbare Verbreitungsweg und passt
 * zum Kernversprechen (deutscher Server, keine US-Silos in der Kette).
 *
 * No-op ohne Konfiguration. Fehler brechen die Veröffentlichung nie ab.
 *
 * Env:
 *   MASTODON_INSTANCE_URL  — z. B. "https://norden.social" (ohne Slash am Ende)
 *   MASTODON_ACCESS_TOKEN  — Token einer Anwendung mit Scope `write:statuses`
 *                            (Mastodon → Einstellungen → Entwicklung → Neue Anwendung)
 *
 * Sicherheit: Der Token wird NIE geloggt (Redaction wie im LLM-Pfad). Beiträge
 * sind öffentlich (visibility "public") und enthalten nur bereits FREIGEGEBENE
 * Digest-Inhalte + Permalink — das menschliche Vier-Augen-Gate bleibt vorgelagert.
 */

import {
  buildPostText,
  type ChannelResult,
  type DigestSummary,
} from "./types";

/** Mastodon: 500 Zeichen Standard; jede URL zählt pauschal als 23 Zeichen. */
const MAX_CHARS = 500;
const CHANNEL = "mastodon";

/** Harte Obergrenze pro HTTP-Call — ein hängender Kanal darf die Aktion nicht blockieren. */
const TIMEOUT_MS = 10_000;

/** Entfernt den Access-Token aus beliebigen Fehlertexten. */
function redact(msg: string, token: string | undefined): string {
  if (!token) return msg;
  return msg.split(token).join("***");
}

export interface MastodonDeps {
  /** Injizierbar für Tests — NIE echter HTTP-Call in der Testsuite. */
  fetchFn?: typeof fetch;
}

export async function sendDigestToMastodon(
  digest: DigestSummary,
  deps: MastodonDeps = {},
): Promise<ChannelResult> {
  const instance = process.env.MASTODON_INSTANCE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MASTODON_ACCESS_TOKEN?.trim();

  if (!instance || !token) {
    console.log("[Mastodon] Nicht konfiguriert — kein Versand.");
    return { sent: false, channel: CHANNEL };
  }

  // Mastodon rechnet jede URL pauschal als 23 Zeichen → mehr Textbudget.
  const { text } = buildPostText(digest, MAX_CHARS + 23);
  const doFetch = deps.fetchFn ?? fetch;

  try {
    const res = await doFetch(`${instance}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Verhindert Doppel-Posts bei Retry (Mastodon-Idempotenz).
        "Idempotency-Key": `digest-${digest.id}`,
      },
      body: JSON.stringify({ status: text, visibility: "public", language: "de" }),
      // Timeout: Abbruch landet im catch unten als normales Fehler-Result.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        sent: false,
        channel: CHANNEL,
        // Erst redigieren, DANN kürzen — sonst kann der Schnitt mitten im
        // Token liegen und ein Präfix davon ungeredacted durchrutschen.
        error: `HTTP ${res.status}: ${redact(body, token).slice(0, 200)}`,
      };
    }

    const data = (await res.json().catch(() => ({}))) as { url?: string };
    console.log(`[Mastodon] Digest "${digest.title}" veröffentlicht.`);
    return { sent: true, channel: CHANNEL, url: data.url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sent: false, channel: CHANNEL, error: redact(msg, token) };
  }
}
