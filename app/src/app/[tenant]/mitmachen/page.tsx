/**
 * [tenant]/mitmachen/page.tsx — B2G-„Mitmachen"-Trichter (Block N4).
 *
 * Ein linearer Pfad in vier Stufen aufsteigender Verbindlichkeit für
 * Multiplikatoren (Kommune/Kreis/Verein/Verwaltung). Der Interessent bestimmt
 * das Tempo; der Betreiber kommt erst bei echtem Interesse ins Spiel (Stufe 3/4).
 *
 *   Stufe 1  selbst erleben     → Demo (Bürger + Verwaltungs-Track)
 *   Stufe 2  selbst verstehen   → Kommunen-FAQ (Akkordeon) + Pitch/Über-uns
 *   Stufe 3  Termin buchen      → prominenter Link zu Tymeslot (KEIN iframe in v1)
 *   Stufe 4  Interesse hinterlassen → Lead-Formular (interessenten)
 *
 * H1 bewusst multiplikator-adressiert, um die Kollision mit dem Bürger-
 * „Mitmachen"-Vokabular (PollMitmachen etc.) zu vermeiden. Öffentlich (Stufe 0),
 * im [tenant]-Layout. `inDemo`-Sonderfall wie fuer-kommunen: auf dem Demo-
 * Mandanten lokale Links statt absoluter Demo-URL.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { demoTenantSlug, isDemoTenant } from "@/lib/demo/config";
import { KOMMUNEN_FAQ } from "../kommunen-faq-daten";
import MitmachenFormular from "./MitmachenFormular";

export const metadata: Metadata = {
  title: "Mitmachen — für Kommunen, Vereine & Verwaltung — Partizip",
  description:
    "In vier Schritten zu Partizip: Demo selbst erleben, häufige Fragen klären, Termin buchen oder unverbindlich Interesse hinterlassen.",
};

/** Öffentliche Selbstbedienungs-Demo (Musterstadt-Spielwiese, nächtlicher Reset). */
const DEMO_URL = "https://demo.partizip.online";
/** Verwaltungs-Perspektive der Demo (Block I) — Slug aus DEMO_TENANT_SLUG (SSOT). */
const DEMO_VERWALTUNG_URL = `${DEMO_URL}/${demoTenantSlug() ?? "demo"}/demo-verwaltung`;
/** Terminbuchung (Tymeslot, live). Immer machbar, keine Config nötig. */
const TERMIN_URL = "https://termine.partizip.online/seidler";

function StufenKopf({ n, titel, unter }: { n: string; titel: string; unter: string }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold"
        style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
      >
        {n}
      </span>
      <div>
        <h2 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          {titel}
        </h2>
        <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
          {unter}
        </p>
      </div>
    </div>
  );
}

export default async function MitmachenPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const inDemo = isDemoTenant(slug);

  return (
    <main>
      {/* Hero */}
      <section className="pz-hero">
        <div className="mx-auto max-w-3xl px-6 pb-12 pt-10 text-center">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
            style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
          >
            Für Kommunen, Vereine & Verwaltung
          </span>
          <h1
            className="mx-auto mt-4 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl"
            style={{ color: "var(--pz-ink)" }}
          >
            Mitmachen — für Kommunen, Vereine &amp; Verwaltung
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed" style={{ color: "var(--pz-body)" }}>
            In vier Schritten, in Ihrem Tempo: erst selbst erleben, dann Ihre Fragen
            klären — und wenn es passt, sprechen wir persönlich.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-3xl space-y-12 px-6 py-14">
        {/* Stufe 1 — selbst erleben */}
        <section>
          <StufenKopf n="1" titel="Selbst erleben" unter="Die Demo — ohne Anmeldung, jede Nacht zurückgesetzt." />
          <div className="pz-card mt-4 p-6">
            <p className="text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
              Probieren Sie die Plattform gefahrlos in der fiktiven &bdquo;Musterstadt&ldquo; aus —
              als Bürgerin oder Bürger und aus Sicht der Verwaltung. Es kann nichts
              kaputtgehen.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              {inDemo ? (
                <>
                  <Link href={`/${slug}`} className="pz-btn pz-btn-primary min-h-[44px]">
                    Bürger-Demo öffnen
                  </Link>
                  <Link href={`/${slug}/demo-verwaltung`} className="pz-btn pz-btn-secondary min-h-[44px]">
                    Verwaltungs-Demo öffnen
                  </Link>
                </>
              ) : (
                <>
                  <a href={DEMO_URL} className="pz-btn pz-btn-primary min-h-[44px]">
                    Bürger-Demo öffnen
                  </a>
                  <a href={DEMO_VERWALTUNG_URL} className="pz-btn pz-btn-secondary min-h-[44px]">
                    Verwaltungs-Demo öffnen
                  </a>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Stufe 2 — selbst verstehen */}
        <section>
          <StufenKopf n="2" titel="Selbst verstehen" unter="Die häufigsten Fragen von Kommunen und Vereinen." />
          <div className="mt-4 space-y-3">
            {KOMMUNEN_FAQ.map((q) => (
              <details key={q.f} className="pz-card p-4">
                <summary
                  className="cursor-pointer text-sm font-semibold marker:text-[color:var(--pz-brand-strong)]"
                  style={{ color: "var(--pz-ink)" }}
                >
                  {q.f}
                </summary>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
                  {q.a}
                </p>
              </details>
            ))}
          </div>
          <p className="mt-4 text-sm" style={{ color: "var(--pz-body)" }}>
            Mehr zum Hintergrund:{" "}
            <Link
              href={`/${slug}/fuer-kommunen`}
              className="font-semibold underline-offset-4 hover:underline"
              style={{ color: "var(--pz-brand-strong)" }}
            >
              Für Kommunen
            </Link>{" "}
            und{" "}
            <Link
              href={`/${slug}/ueber-uns`}
              className="font-semibold underline-offset-4 hover:underline"
              style={{ color: "var(--pz-brand-strong)" }}
            >
              Über uns
            </Link>
            .
          </p>
        </section>

        {/* Stufe 3 — Termin buchen */}
        <section>
          <StufenKopf n="3" titel="Termin buchen" unter="Ein kurzes Gespräch — Sie wählen einen Zeitpunkt." />
          <div className="pz-card mt-4 p-6 text-center sm:text-left">
            <p className="text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
              Am schnellsten geht es im direkten Gespräch. Suchen Sie sich einen
              passenden Termin aus — die Buchung dauert eine Minute.
            </p>
            <div className="mt-5">
              <a
                href={TERMIN_URL}
                className="pz-btn pz-btn-primary pz-btn-lg min-h-[48px]"
                rel="noreferrer"
              >
                Termin auswählen →
              </a>
            </div>
          </div>
        </section>

        {/* Stufe 4 — Interesse hinterlassen */}
        <section>
          <StufenKopf
            n="4"
            titel="Interesse hinterlassen"
            unter="Lieber schriftlich? Hinterlassen Sie uns eine kurze Nachricht."
          />
          <div className="pz-card mt-4 p-6">
            <MitmachenFormular />
          </div>
        </section>
      </div>
    </main>
  );
}
