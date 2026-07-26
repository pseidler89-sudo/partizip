/**
 * .pa11yci.streng.js — LAUF 2 des a11y-Gates (Issue #60).
 *
 * Ergänzt LAUF 1 (.pa11yci.js) um genau die Befundklassen, die dort
 * konstruktionsbedingt stumm bleiben. Die Aufteilung und ihre Begründung
 * stehen im Kopfkommentar von .pa11yci.js — hier nur, was DIESER Lauf tut:
 *
 *   1. `levelCapWhenNeedsReview` wird NICHT gesetzt (pa11y-Default: "error").
 *      Damit behalten axe-`incomplete`-Befunde ihre vom Impact abgeleitete
 *      Stufe. Nötig, weil axe belegte Verstöße wie `duplicate-id-aria` wegen
 *      `reviewOnFail: true` (axe-core) in die incomplete-Klasse schreibt — die
 *      Deckelung in LAUF 1 macht daraus eine Warnung, die niemand zählt.
 *
 *   2. `includeWarnings: true` + `includeNotices: true`. pa11y bildet die
 *      gesamte axe-Impact-Klasse `moderate` auf `warning` und `minor` auf
 *      `notice` ab (pa11y/lib/runners/axe.js, `axeImpactToPa11yLevel`) und
 *      zählt beides per Default NICHT (pa11y/lib/option.js schiebt sonst
 *      'warning'/'notice' in die Ignore-Liste). Ohne diese zwei Schalter wären
 *      z. B. `heading-order` und `form-field-multiple-labels` dauerhaft stumm —
 *      beides reale Befunde auf den geprüften Seiten. pa11y-ci zählt jede
 *      verbliebene Meldung als Fehler (lib/pa11y-ci.js: `results.issues.length`),
 *      also blocken sie hier.
 *
 *   3. `color-contrast` ist auf `/` regel- und seitengenau abgeschaltet.
 *      Der Verlaufshintergrund von `.pz-hero` macht die Kontrastberechnung dort
 *      prinzipiell unentscheidbar (21 incomplete-Meldungen). ES ENTSTEHT KEINE
 *      LÜCKE: LAUF 1 lässt `color-contrast` auf allen Seiten aktiv, und ein
 *      belegter Kontrast-*Verstoß* hat Impact `serious` → Stufe `error` → blockt
 *      dort weiterhin hart. Abgeschaltet ist hier nur das Unentscheidbare.
 *
 * ─── Reichweite dieses Gates (ehrlich) ──────────────────────────────────────
 * Beide Läufe zusammen decken auf den vier geprüften Seiten alle axe-Regeln des
 * Standards WCAG2AA ab, in jeder Impact-Klasse, sowohl `violations` als auch
 * `incomplete` — mit der einen dokumentierten Ausnahme `color-contrast`/`/` aus
 * Punkt 3. Sonst gibt es keine Ausnahme mehr. Was das Gate NICHT sieht:
 * andere Seiten (siehe .pa11yci.js: nur vier anonyme Sichten), alles was
 * Interaktion braucht (Fokus-Reihenfolge, Tastaturbedienung, Live-Regionen nach
 * einer Aktion), und alles, was automatisierte Prüfung grundsätzlich nicht
 * entscheiden kann (Verständlichkeit, sinnvolle Alternativtexte).
 *
 * ─── Zur Notation `"ignore": []` ────────────────────────────────────────────
 * Siehe .pa11yci.js: kein Opt-out aus globalen Ignores, nur Dokumentation.
 * `defaults` setzt hier bewusst kein `ignore`.
 */

const { PFADE, BASIS_DEFAULTS, url } = require("./.pa11yci.js");

// Absicherung gegen stilles Auseinanderlaufen der beiden Configs: wenn jemand
// PFADE in .pa11yci.js ändert, ohne die Ausnahmen hier nachzuziehen, prüft
// dieser Lauf sonst eine Seite ohne die für sie gedachten Ausnahmen (oder
// umgekehrt eine Ausnahme ohne Seite). Beides fällt hier sofort auf.
const AUSNAHMEN = {
  /**
   * `color-contrast` — technisch bedingt, KEINE Altlast, bleibt dauerhaft.
   *   Regel: color-contrast · Seite: / · Element: alle Textknoten in `.pz-hero`
   *   Grund: Verlaufshintergrund (globals.css), axe kann den Kontrast dort
   *          prinzipiell nicht berechnen → 21x incomplete.
   *   Abbau: nur mit einem einfarbigen Hero-Hintergrund. Kein Ziel für sich —
   *          echte Kontrast-VERSTÖSSE blockt LAUF 1 auf dieser Seite weiterhin.
   *
   * Die vier am 2026-07-26 eingefrorenen Altlasten (`duplicate-id-aria` und
   * `form-field-multiple-labels` auf `/`, `heading-order` auf `/umfragen`,
   * `link-in-text-block` auf `/anliegen`) sind behoben und ihre Ausnahmen
   * ersatzlos entfernt — die Regeln blocken jetzt auf allen Seiten hart.
   */
  "/": ["color-contrast"],

  "/umfragen": [],

  "/anliegen": [],

  "/anmelden": [],
};

const unbekannt = Object.keys(AUSNAHMEN).filter((p) => !PFADE.includes(p));
if (unbekannt.length > 0) {
  throw new Error(
    `.pa11yci.streng.js: Ausnahmen für Seiten, die .pa11yci.js gar nicht prüft: ${unbekannt.join(", ")}`
  );
}

module.exports = {
  defaults: {
    ...BASIS_DEFAULTS,
    includeWarnings: true,
    includeNotices: true,
    // levelCapWhenNeedsReview bewusst NICHT gesetzt — siehe Kopfkommentar.
  },

  urls: PFADE.map((pfad) => ({
    url: url(pfad),
    ignore: AUSNAHMEN[pfad] ?? [],
  })),
};
