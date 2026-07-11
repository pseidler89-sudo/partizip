/**
 * types.ts — Gemeinsamer Vertrag der Kanal-Schicht (ADR-021).
 *
 * KANAL-PRINZIP: Die eigene Seite IST der Kanal. Soziale Netzwerke erhalten nur
 * einen kurzen Anreißer + den Permalink auf partizip.online — der Inhalt lebt auf
 * dem eigenen, in Deutschland gehosteten Server (kein Plattform-Lock-in, kein
 * Algorithmus zwischen Kommune und Bürgerschaft).
 *
 * SOUVERÄNITÄTS-REGEL (nicht verhandelbar, ADR-021): Es werden ausschließlich
 * Kanäle mit offenem Protokoll bespielt — ActivityPub (Mastodon, W3C-Standard,
 * selbst hostbar) und AT-Protocol (Bluesky). Kein Telegram, kein WhatsApp, keine
 * proprietären US-Silos in der Verbreitungskette: Datensouveränität ist das
 * Kernversprechen des Produkts und muss auch für die eigenen Kanäle gelten.
 *
 * Jeder Kanal ist ein NO-OP ohne konfigurierte Zugangsdaten (env). Fehler dürfen
 * die Digest-Veröffentlichung NIEMALS verhindern (best-effort, try/catch + Audit).
 */

/** Ein veröffentlichungsbereiter Digest (bereits menschlich freigegeben!). */
export interface DigestSummary {
  id: string;
  title: string;
  statements: Array<{ text: string }>;
  tenantSlug: string;
}

/** Einheitliches Ergebnis eines Kanal-Versands. */
export interface ChannelResult {
  sent: boolean;
  /** Kanal-Kennung für Audit-Events (z. B. "mastodon"). */
  channel: string;
  /** URL des erzeugten Beitrags, falls die Plattform sie zurückgibt. */
  url?: string;
  error?: string;
}

/** Basis-URL der Plattform (Permalinks in den Beiträgen). */
export function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ??
    process.env.APP_BASE_URL ??
    "https://partizip.online"
  );
}

/** Permalink der Digest-Seite — das Ziel JEDES Kanal-Beitrags. */
export function digestPermalink(tenantSlug: string, digestId: string): string {
  return `${baseUrl()}/${tenantSlug}/digest/${digestId}`;
}

/**
 * Kürzt auf maximal `max` Zeichen mit Ellipse. Kein Surrogat-Paar zerschneiden
 * (Emoji/Astralzeichen): Endet der Schnitt mitten in einem Paar (Lone High
 * Surrogate), ein Code-Unit weniger nehmen.
 */
export function kuerzen(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = Math.max(0, max - 1);
  const last = s.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return s.slice(0, cut).trimEnd() + "…";
}

/**
 * Baut den Beitragstext: Titel + erste Aussage als Anreißer + Permalink.
 * Bewusst KURZ (Bluesky: 300 Zeichen hart) und ohne Wertung — der Beitrag ist
 * eine Verlinkung, kein Ersatzartikel. Neutralitätskodex gilt auch hier.
 *
 * `mitUrl: false` liefert denselben Anreißer OHNE angehängte Roh-URL — für
 * Kanäle, die den Link als eigene Vorschaukarte transportieren (Bluesky
 * `app.bsky.embed.external`); dort stünde die URL sonst doppelt und roh im
 * Text. Der Anreißer bekommt dann das volle Zeichenbudget. Mastodon nutzt
 * weiter die Default-Variante (Karte entsteht dort empfängerseitig aus OG).
 */
export function buildPostText(
  digest: DigestSummary,
  maxChars: number,
  opts: { mitUrl?: boolean } = {},
): { text: string; url: string } {
  const mitUrl = opts.mitUrl !== false;
  const url = digestPermalink(digest.tenantSlug, digest.id);
  const first = digest.statements[0]?.text?.trim() ?? "";

  // Reserve für "\n\n" + URL (Bluesky zählt die URL mit, Mastodon pauschal 23).
  const reserved = mitUrl ? url.length + 2 : 0;
  const budget = Math.max(0, maxChars - reserved);

  let body = digest.title.trim();
  if (first && body.length + 2 + first.length <= budget) {
    body = `${body}\n\n${first}`;
  }
  if (body.length > budget) {
    body = kuerzen(body, budget);
  }
  return { text: mitUrl ? `${body}\n\n${url}` : body, url };
}
