/**
 * .pa11yci.js — LAUF 1 des a11y-Gates (Issue #60).
 *
 * Warum eine .js- und keine .json-Datei: die Basis-URL und die Liste der
 * geprüften Seiten sind sonst zweimal im Repo hinterlegt (hier und in
 * scripts/a11y-preflight.ts). Driftet eine der beiden, prüft der Preflight
 * einen anderen Server als pa11y — das Gate wäre still grün. pa11y-ci lädt
 * `.cjs`/`.js`-Configs über `loadConfigModule` (bin/pa11y-ci.js), deshalb sind
 * BASIS_URL und PFADE hier definiert und werden von .pa11yci.streng.js sowie
 * von scripts/a11y-preflight.ts importiert. EINE Quelle für beide Läufe und
 * den Preflight.
 *
 * ─── Warum ZWEI Läufe ───────────────────────────────────────────────────────
 * axe unterscheidet `violations` (belegter Verstoß) und `incomplete` (axe konnte
 * es nicht entscheiden). pa11y bildet beides auf Meldungen ab und deckelt die
 * incomplete-Klasse über `levelCapWhenNeedsReview` — aber PAUSCHAL, nie
 * regelbezogen (pa11y/lib/runners/axe.js, `choosePa11yLevel` prüft nur das Flag
 * `issueNeedsReview`, nie die Regel-ID). Zusätzlich bildet pa11y die gesamte
 * axe-Impact-Klasse `moderate` auf `warning` ab, und pa11y zählt Warnungen
 * per Default nicht (`includeWarnings: false`).
 *
 * Ein einziger Lauf kann deshalb nicht gleichzeitig
 *   (a) die unberechenbaren Kontrast-`incomplete`s des Verlaufs-Heros dämpfen und
 *   (b) belegte Befunde wie `duplicate-id-aria` (das axe wegen `reviewOnFail`
 *       ebenfalls nach `incomplete` schreibt) hart blocken.
 * Genau daran ist die erste Fassung dieses Gates gescheitert: sie meldete 0
 * Befunde, während 3 belegte Verstöße bestanden.
 *
 * Deshalb:
 *   LAUF 1 (diese Datei)      — `levelCapWhenNeedsReview: "warning"`, Kontrast-
 *                               regel auf ALLEN Seiten aktiv. Blockt belegte
 *                               `violations` mit Impact critical/serious,
 *                               insbesondere echte `color-contrast`-Verstöße.
 *   LAUF 2 (.pa11yci.streng.js) — KEINE Deckelung, `includeWarnings`/
 *                               `includeNotices` an, dafür `color-contrast` auf
 *                               der Startseite regel- und seitengenau aus.
 *                               Blockt alles Übrige: incomplete-Befunde jeder
 *                               Impact-Klasse und moderate/minor-Verstöße.
 * Beide zusammen laufen als `npm run a11y`; jeder Lauf beendet die Kette bei
 * Exit != 0.
 *
 * ─── Tenant-Vorbedingung ────────────────────────────────────────────────────
 * Der Server MUSS mit PILOT_TENANT_SLUG=taunusstein laufen, sonst liefert die
 * Haupt-Domain die neutrale Landing-Page statt der Tenant-App (src/middleware.ts)
 * und der Lauf wäre grün und wertlos. `npm run a11y` erzwingt das über
 * scripts/a11y-preflight.ts (Status-200-Prüfung, Seed-Inhalts-Assertion,
 * CSS-Assertion).
 *
 * ─── Zur Notation `"ignore": []` ────────────────────────────────────────────
 * Das leere Array liest sich wie ein Opt-out aus globalen Ignores, ist aber
 * keines: pa11y-ci merged URL-Optionen über lodash `defaultsDeep`, und das
 * merged Arrays INDEXWEISE statt sie zu ersetzen. Solange `defaults` hier kein
 * `ignore` setzt (tut es nicht), ist das folgenlos — dokumentiert, damit es
 * niemanden beißt, der später ein globales `defaults.ignore` ergänzt.
 */

/** Basis-URL des laufenden Servers. Identisch zu scripts/a11y-preflight.ts. */
const BASIS_URL = (
  process.env.A11Y_BASE_URL || "http://127.0.0.1:3000"
).replace(/\/+$/, "");

/** Die geprüften Kernseiten. Einzige Quelle für beide Läufe und den Preflight. */
const PFADE = ["/", "/umfragen", "/anliegen", "/anmelden"];

/** Pfad → absolute URL des laufenden Servers. */
const url = (pfad) => `${BASIS_URL}${pfad}`;

/**
 * Von beiden Läufen geteilte Grundeinstellungen.
 *
 * `concurrency: 1`: pa11y startet je Ziel einen eigenen Inkognito-Browser-
 * Kontext; parallel dazu kam es reproduzierbar zu `Protocol error
 * (Target.closeTarget)`-Abbrüchen. Die Richtung wäre zwar sicher (rot statt
 * grün), aber ein flackerndes Pflicht-Gate wird weggeklickt. Bei vier URLs
 * bringt Parallelität ohnehin fast nichts.
 */
const BASIS_DEFAULTS = {
  runners: ["axe"],
  standard: "WCAG2AA",
  timeout: 60000,
  wait: 1000,
  concurrency: 1,
  chromeLaunchConfig: {
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  },
};

module.exports = {
  defaults: {
    ...BASIS_DEFAULTS,

    // Deckelt die axe-`incomplete`-Klasse auf `warning`; pa11y zählt Warnungen
    // hier nicht mit (`includeWarnings` bleibt aus). Grund: `.pz-hero` in
    // globals.css hat einen Verlauf als Hintergrund, und bei Verlaufs-
    // hintergründen kann axe den Kontrast prinzipiell nicht berechnen — 21
    // Textknoten der Startseite landen deshalb als `color-contrast`/incomplete.
    // Wichtig: die Deckelung wirkt pauschal auf ALLE incomplete-Befunde, nicht
    // nur auf Kontrast. Was sie hier durchlässt, fängt LAUF 2 wieder ein.
    levelCapWhenNeedsReview: "warning",
  },

  urls: [
    {
      url: url("/"),
      ignore: [],
    },
    {
      url: url("/umfragen"),
      ignore: [],
    },
    {
      _kommentar_ignore: [
        "ALTLAST, eingefroren am 2026-07-26 — abzubauen, nicht auszuweiten.",
        "Regel: link-in-text-block · Seite: /anliegen · Element:",
        '#main-content > main > p > a → <a href="/<tenant>/konto" ...>Konto unter',
        "„Meine Anliegen“</a>. Der Link im Fließtext ist nur farblich (--pz-brand-strong)",
        "vom umgebenden Text unterschieden; 'hover:underline' greift erst beim Hover.",
        "Grund für die Ausnahme: dieser PR friert den Bestand ein und ändert",
        "bewusst KEINE UI (Issue #60). Fix gehört in einen eigenen PR (Unterstreichung",
        "im Ruhezustand oder ausreichender Nicht-Farb-Unterschied); danach diese",
        "Ausnahme in BEIDEN Configs ersatzlos entfernen.",
        "Die Ausnahme gilt regel- UND seitengenau: auf allen anderen URLs blockt",
        "link-in-text-block weiterhin hart.",
      ],
      url: url("/anliegen"),
      ignore: ["link-in-text-block"],
    },
    {
      url: url("/anmelden"),
      ignore: [],
    },
  ],
};

// Geteilte Konstanten für .pa11yci.streng.js und scripts/a11y-preflight.ts.
// pa11y-ci liest nur `defaults` und `urls` (bin/pa11y-ci.js, `defaultConfig`),
// zusätzliche Exporte stören es nicht.
module.exports.BASIS_URL = BASIS_URL;
module.exports.PFADE = PFADE;
module.exports.BASIS_DEFAULTS = BASIS_DEFAULTS;
module.exports.url = url;
