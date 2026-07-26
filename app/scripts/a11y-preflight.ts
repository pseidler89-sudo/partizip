/**
 * a11y-preflight.ts — Torwächter vor den pa11y-Läufen (Issue #60).
 *
 * WARUM DIESES SKRIPT ÜBERHAUPT EXISTIERT:
 * Die Tenant-Auflösung ist host-basiert (src/middleware.ts). `localhost` und
 * `127.0.0.1` sind HAUPT-Domains — ein Server, der ohne `PILOT_TENANT_SLUG`
 * startet, liefert dort die NEUTRALE Landing-Page, nicht die Tenant-App. Ein
 * a11y-Job, der dagegen läuft, ist grün und wertlos: er prüft eine Seite, die
 * mit den Kernflüssen nichts zu tun hat.
 *
 * Dieses Skript macht daraus einen harten Fehler statt einer stillen Lüge:
 *
 *   1. READINESS: HTTP-Poll auf die Basis-URL bis Timeout — KEIN `sleep` als
 *      Synchronisation (nicht deterministisch, verdeckt Boot-Fehler).
 *   2. STATUS: jede der geprüften Seiten muss unauthentifiziert exakt 200
 *      liefern. Ein 3xx/404 hieße, dass pa11y eine Weiterleitungs- oder
 *      Fehlerseite prüft statt der Kernseite.
 *   3. TENANT-BEWEIS: /umfragen MUSS den Wortlaut mindestens einer geseedeten
 *      Umfrage aus db/seeds/polls.json enthalten. Die neutrale Landing-Page
 *      kann das prinzipiell nicht — damit ist bewiesen, dass der Lauf die
 *      echten Tenant-Seiten sieht. (Dieselbe Fehlerklasse wie ein erfundenes
 *      Fixture: grün gegen eine Struktur, die es so nicht gibt.)
 *   4. STYLING-BEWEIS: jede Seite muss mindestens ein <link rel="stylesheet">
 *      führen, und jedes davon muss mit 200 und nicht-leerem Rumpf ausliefern.
 *      Punkt 2 und 3 beweisen nur INHALT, nicht STYLING — und viele
 *      axe-Regeln sind rein visuell (color-contrast, link-in-text-block).
 *      Real nachgestellt: mit blockiertem Stylesheet verschwindet die bekannte
 *      link-in-text-block-Violation auf /anliegen spurlos, ohne dass irgendein
 *      anderer Schritt bricht. Ein CSS-loser Lauf wäre also wieder grün und
 *      wertlos — hier wird er zum harten Fehler.
 *
 * Exit 0 = Preflight bestanden, pa11y darf laufen. Exit 1 = Abbruch.
 *
 * Basis-URL und Seitenliste kommen aus ../.pa11yci.js — derselben Datei, aus
 * der pa11y-ci seine Ziele liest. Vorher lagen beide doppelt vor (hier und in
 * der Config); driftet eines, prüft der Preflight einen anderen Server oder
 * andere Seiten als pa11y, ohne dass es auffällt.
 *
 * Env:
 *   A11Y_BASE_URL       Basis-URL des laufenden Servers (Default http://127.0.0.1:3000)
 *   PILOT_TENANT_SLUG   Tenant, dessen Seeds erwartet werden (Default taunusstein)
 *   A11Y_READY_TIMEOUT  Readiness-Timeout in ms (Default 120000)
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

interface Pa11yZiele {
  BASIS_URL: string;
  PFADE: string[];
}

/**
 * `.pa11yci.js` ist eine CommonJS-Config (pa11y-ci lädt sie über `require`).
 * `createRequire` holt sie hier mit demselben Auflösungsverhalten — ein
 * statischer `import` würde TypeScript zwingen, die JS-Datei mitzutypen.
 */
const requireCjs = createRequire(join(process.cwd(), "package.json"));
const ziele = requireCjs("./.pa11yci.js") as Pa11yZiele;

const BASE_URL = (process.env.A11Y_BASE_URL ?? ziele.BASIS_URL).replace(
  /\/+$/,
  ""
);
const TENANT_SLUG = process.env.PILOT_TENANT_SLUG?.trim() || "taunusstein";
const READY_TIMEOUT_MS = Number(process.env.A11Y_READY_TIMEOUT ?? 120_000);
const READY_INTERVAL_MS = 500;

/** Die Kernseiten, die pa11y prüft — direkt aus der pa11y-Config. */
const PAGES: readonly string[] = ziele.PFADE;

interface PollSeed {
  tenantSlug: string;
  frage: string;
}

function fail(message: string): never {
  console.error(`\na11y-preflight FEHLGESCHLAGEN: ${message}\n`);
  process.exit(1);
}

/**
 * Readiness über HTTP-Poll statt sleep: fragt die Basis-URL, bis sie irgendeine
 * HTTP-Antwort liefert (auch 4xx/5xx zählt als „Server nimmt Verbindungen an").
 */
async function waitForServer(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "keine Antwort";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      console.log(`readiness: ${BASE_URL}/ antwortet mit ${res.status}`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }

  fail(
    `Server unter ${BASE_URL} war nach ${READY_TIMEOUT_MS} ms nicht erreichbar (${lastError}).`
  );
}

/**
 * Holt jede Kernseite genau einmal. Alle folgenden Assertions arbeiten auf
 * diesen Antworten — ein Fetch pro Seite, keine Doppelabfragen.
 */
async function ladeSeiten(): Promise<Map<string, string>> {
  const html = new Map<string, string>();
  const abweichungen: string[] = [];

  for (const path of PAGES) {
    const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
    console.log(`status: ${path} → ${res.status}`);
    if (res.status !== 200) {
      abweichungen.push(`${path} → ${res.status}`);
      continue;
    }
    html.set(path, await res.text());
  }

  if (abweichungen.length > 0) {
    fail(
      `Nicht alle Kernseiten liefern unauthentifiziert 200: ${abweichungen.join(", ")}. ` +
        `pa11y würde Weiterleitungs- oder Fehlerseiten prüfen statt der Kernseiten.`
    );
  }

  return html;
}

/**
 * Minimale Entity-Dekodierung: React escaped im HTML-Output u. a. `&`, `<`, `>`,
 * `"` und `'`. Ohne diese Rücknahme scheitert ein Substring-Vergleich an
 * Fragen, die solche Zeichen enthalten — ein falsch-negativer Abbruch.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Der eigentliche Inhalts-Beweis: /umfragen zeigt echte Seed-Inhalte des
 * Pilot-Tenants.
 */
function assertTenantPagesVisible(seiten: Map<string, string>): void {
  const seedPath = join(process.cwd(), "..", "db", "seeds", "polls.json");
  const polls = JSON.parse(readFileSync(seedPath, "utf8")) as PollSeed[];
  const fragen = polls
    .filter((p) => p.tenantSlug === TENANT_SLUG)
    .map((p) => p.frage);

  if (fragen.length === 0) {
    fail(
      `db/seeds/polls.json enthält keine Umfrage für Tenant "${TENANT_SLUG}" — ` +
        `die Tenant-Assertion wäre inhaltsleer.`
    );
  }

  const html = decodeEntities(seiten.get("/umfragen") ?? "");
  const gefunden = fragen.filter((frage) => html.includes(frage));

  if (gefunden.length === 0) {
    fail(
      `/umfragen enthält KEINE der ${fragen.length} geseedeten Umfragen des Tenants ` +
        `"${TENANT_SLUG}".\nErwartet (mindestens eine):\n` +
        fragen.map((f) => `  - ${f}`).join("\n") +
        `\n\nWahrscheinlichste Ursache: der Server läuft ohne PILOT_TENANT_SLUG, ` +
        `also liefert die Haupt-Domain die NEUTRALE Landing-Page statt der Tenant-App ` +
        `(src/middleware.ts). Alternativ fehlt der Seed (npm run db:seed).`
    );
  }

  console.log(
    `tenant-assertion: ${gefunden.length}/${fragen.length} geseedete Umfragen auf /umfragen gefunden`
  );
  for (const frage of gefunden) console.log(`  ✓ ${frage}`);
}

/** Alle `<link rel="stylesheet" href="…">` einer Seite, in Dokumentreihenfolge. */
function stylesheetHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) hrefs.push(href);
  }
  return hrefs;
}

/**
 * Der Styling-Beweis. Ohne ihn kann der Lauf gegen ein ungestyltes Dokument
 * grün werden: axe prüft berechnete Stile, und ohne CSS gibt es weder
 * Kontrastprobleme noch nur-farblich markierte Links.
 */
async function assertStylesheetsLoaded(
  seiten: Map<string, string>
): Promise<void> {
  const probleme: string[] = [];

  for (const path of PAGES) {
    const hrefs = stylesheetHrefs(seiten.get(path) ?? "");
    if (hrefs.length === 0) {
      probleme.push(`${path}: kein <link rel="stylesheet"> im HTML`);
      continue;
    }

    for (const href of hrefs) {
      const cssUrl = new URL(href, `${BASE_URL}/`).toString();
      let status = 0;
      let laenge = 0;
      try {
        const res = await fetch(cssUrl, { redirect: "manual" });
        status = res.status;
        laenge = (await res.text()).length;
      } catch (err) {
        probleme.push(
          `${path}: ${cssUrl} nicht abrufbar (${err instanceof Error ? err.message : String(err)})`
        );
        continue;
      }
      if (status !== 200 || laenge === 0) {
        probleme.push(`${path}: ${cssUrl} → ${status}, ${laenge} Bytes`);
        continue;
      }
      console.log(`css: ${path} → ${href} (200, ${laenge} Bytes)`);
    }
  }

  if (probleme.length > 0) {
    fail(
      `Stylesheets nicht ausgeliefert:\n` +
        probleme.map((p) => `  - ${p}`).join("\n") +
        `\n\nDer Lauf würde ein ungestyltes Dokument prüfen. Rein visuelle Regeln ` +
        `(color-contrast, link-in-text-block) hätten dann nichts zu finden und das ` +
        `Gate wäre grün und wertlos. Wahrscheinlichste Ursache: der Server läuft ` +
        `ohne die statischen Assets (bei .next/standalone müssen .next/static und ` +
        `public danebenkopiert werden — siehe npm run start:standalone).`
    );
  }
}

async function main(): Promise<void> {
  console.log(`a11y-preflight gegen ${BASE_URL} (Tenant: ${TENANT_SLUG})`);
  console.log(`geprüfte Seiten (aus .pa11yci.js): ${PAGES.join(", ")}`);
  await waitForServer();
  const seiten = await ladeSeiten();
  assertTenantPagesVisible(seiten);
  await assertStylesheetsLoaded(seiten);
  console.log(
    "\na11y-preflight bestanden — pa11y prüft echte, gestylte Tenant-Seiten.\n"
  );
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
