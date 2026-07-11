/**
 * fetch-wrapper.ts — Gedrosselter HTTP-Client für RIS-Adapter (M7)
 *
 * - User-Agent: aus RIS_USER_AGENT env oder Fallback (H1)
 * - Drosselung: min. 1100 ms zwischen Requests je Host
 * - N3: Parallel-sicher via Promise-Kette je Host (kein check-then-set-Race)
 * - Timeout: 15 Sekunden
 * - Nur GET — kein POST/PUT/DELETE
 */

// H1: User-Agent aus Env mit Fallback
const USER_AGENT =
  process.env.RIS_USER_AGENT ??
  "PartizipBot/0.1 (+https://partizip.online; kontakt folgt)";
const MIN_DELAY_MS = 1100;
const TIMEOUT_MS = 15_000;

// N3: Promise-Kette je Host — parallel-sicher (kein check-then-set)
// Jeder neue Request hängt sich an die laufende Kette, sodass die
// Mindestwartezeit garantiert eingehalten wird, auch bei mehreren parallelen Aufrufen.
const hostChain = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gibt eine Promise zurück, die nach der erforderlichen Wartezeit resolvet,
 * und hängt sie parallel-sicher an die Host-Kette.
 */
function throttleForHost(host: string): Promise<void> {
  const prev = hostChain.get(host) ?? Promise.resolve();
  // Neue Kette: warte auf vorherigen Request + Mindestdelay
  const next = prev.then(() => sleep(MIN_DELAY_MS));
  // Kette aktualisieren; nach Ablauf bereinigen
  hostChain.set(host, next.catch(() => undefined));
  return prev.then(() => sleep(MIN_DELAY_MS));
}

/**
 * Gedrosselter GET-Request mit User-Agent und Timeout.
 * Wirft bei HTTP-Fehlern oder Timeout.
 */
export async function risGet(url: string): Promise<Response> {
  const { hostname } = new URL(url);

  // N3: Parallel-sichere Drosselung
  await throttleForHost(hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/pdf,*/*",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} für ${url}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gibt eine injizierbare Fetch-Funktion zurück (für Tests: Stub übergeben).
 */
export type RisGetFn = (url: string) => Promise<Response>;

export function makeRisGetFn(impl?: RisGetFn): RisGetFn {
  return impl ?? risGet;
}
