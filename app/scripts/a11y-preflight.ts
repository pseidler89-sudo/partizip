/**
 * a11y-preflight.ts — Torwächter vor dem pa11y-Lauf (Issue #60).
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
 *
 * Exit 0 = Preflight bestanden, pa11y darf laufen. Exit 1 = Abbruch.
 *
 * Env:
 *   A11Y_BASE_URL       Basis-URL des laufenden Servers (Default http://127.0.0.1:3000)
 *   PILOT_TENANT_SLUG   Tenant, dessen Seeds erwartet werden (Default taunusstein)
 *   A11Y_READY_TIMEOUT  Readiness-Timeout in ms (Default 120000)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = (
  process.env.A11Y_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/+$/, "");
const TENANT_SLUG = process.env.PILOT_TENANT_SLUG?.trim() || "taunusstein";
const READY_TIMEOUT_MS = Number(process.env.A11Y_READY_TIMEOUT ?? 120_000);
const READY_INTERVAL_MS = 500;

/** Die Kernseiten, die pa11y prüft — identisch zu app/.pa11yci.json. */
const PAGES = ["/", "/umfragen", "/anliegen", "/anmelden"] as const;

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

/** Alle vier Seiten müssen unauthentifiziert 200 liefern, nicht 3xx/4xx. */
async function assertStatusCodes(): Promise<void> {
  const abweichungen: string[] = [];

  for (const path of PAGES) {
    const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
    console.log(`status: ${path} → ${res.status}`);
    if (res.status !== 200) abweichungen.push(`${path} → ${res.status}`);
  }

  if (abweichungen.length > 0) {
    fail(
      `Nicht alle Kernseiten liefern unauthentifiziert 200: ${abweichungen.join(", ")}. ` +
        `pa11y würde Weiterleitungs- oder Fehlerseiten prüfen statt der Kernseiten.`
    );
  }
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
 * Der eigentliche Beweis: /umfragen zeigt echte Seed-Inhalte des Pilot-Tenants.
 */
async function assertTenantPagesVisible(): Promise<void> {
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

  const res = await fetch(`${BASE_URL}/umfragen`, { redirect: "manual" });
  const html = decodeEntities(await res.text());
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

async function main(): Promise<void> {
  console.log(`a11y-preflight gegen ${BASE_URL} (Tenant: ${TENANT_SLUG})`);
  await waitForServer();
  await assertStatusCodes();
  await assertTenantPagesVisible();
  console.log("\na11y-preflight bestanden — pa11y prüft echte Tenant-Seiten.\n");
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
