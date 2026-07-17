/**
 * [tenant]/fuer-kommunen/page.tsx — schlanke B2G-Seite (P2, CANNANAS_EVAL §Empf. 6).
 *
 * Rollen-getrennter Pfad: die Bürger-Landing bleibt fokussiert, Multiplikatoren
 * (Kommune/Kreis/Verein) bekommen hier eine eigene, schlanke Seite — 4 Schritte +
 * Trust-Badges + EIN Demo-CTA. Öffentlich (Stufe 0), im [tenant]-Layout gerendert.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { demoTenantSlug, isDemoTenant } from "@/lib/demo/config";

export const metadata: Metadata = {
  title: "Für Kommunen & Vereine — Partizip",
  description:
    "Bürgernahe Umfragen für Kommunen, Kreise und Vereine — datensparsam, überparteilich, barrierefrei, gehostet in Deutschland.",
};

const DEMO_MAILTO =
  "mailto:patrick@seidler.ml?subject=Partizip%20%E2%80%93%20Demo%20f%C3%BCr%20unsere%20Kommune";

/** Öffentliche Selbstbedienungs-Demo (Musterstadt-Spielwiese, nächtlicher Reset). */
const DEMO_URL = "https://demo.partizip.online";

/**
 * Einstieg in die Verwaltungs-Perspektive der Demo (Block I) — Tenant-Route
 * /[tenant]/demo-verwaltung auf dem Demo-Mandanten. Der Pfad-Slug kommt aus
 * DEMO_TENANT_SLUG (SSOT), NICHT aus einem zweiten Hardcode „demo" — weicht der
 * konfigurierte Slug ab (z. B. Staging), zeigte ein fester Pfad sonst ins Leere
 * (404, Gate-B MINOR-6). Fallback „demo" bleibt parat zur Subdomain in DEMO_URL.
 */
const DEMO_VERWALTUNG_URL = `${DEMO_URL}/${demoTenantSlug() ?? "demo"}/demo-verwaltung`;

const SCHRITTE: { n: string; titel: string; text: string }[] = [
  {
    n: "1",
    titel: "Frage stellen",
    text: "Sie erstellen eine lokale Frage — als unverbindliches Stimmungsbild oder verbindliche Abstimmung, nach Ebene (Ortsteil, Stadt, Kreis).",
  },
  {
    n: "2",
    titel: "Bürger:innen stimmen ab",
    text: "Niedrige Hürde: Anmeldung per E-Mail-Link (ohne Passwort). Verbindliche Abstimmungen nur mit Wohnsitz-Bestätigung — per QR-Code vor Ort.",
  },
  {
    n: "3",
    titel: "Ergebnis auf einen Blick",
    text: "Ausgezählt nach Abstimmungsende — nach Ebene gekennzeichnet, mit Anteil wohnsitz-verifizierter Stimmen. Die Wahl selbst bleibt geheim.",
  },
  {
    n: "4",
    titel: "Optional: Ratsinfos",
    text: "Verständliche Zusammenfassungen aus dem Ratsinformationssystem — quellengebunden und vor Veröffentlichung freigegeben.",
  },
];

const TRUST: string[] = [
  "DSGVO-konform",
  "WCAG 2.1 AA — barrierefrei",
  "Hosting in Deutschland",
  "Datensparsam, kein Tracking",
  "Überparteilich",
  "Geheime Wahl",
];

export default async function FuerKommunenPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  // Auf dem Demo-Tenant selbst ist „Demo ausprobieren" ein Kreisverweis —
  // der Besucher IST bereits in der Demo (Gate-B-Befund).
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
            Für Kommunen, Kreise & Vereine
          </span>
          <h1
            className="mx-auto mt-4 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl"
            style={{ color: "var(--pz-ink)" }}
          >
            Bürgernahe Umfragen — in wenigen Tagen startklar
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed" style={{ color: "var(--pz-body)" }}>
            Fragen Sie Ihre Bürger:innen direkt — datensparsam, überparteilich und
            barrierefrei. Ergebnis nach Ebene, mit verifiziertem Stimmenanteil.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {!inDemo && (
              <a
                href={DEMO_URL}
                className="pz-btn pz-btn-primary pz-btn-lg min-h-[48px]"
              >
                Demo sofort ausprobieren
              </a>
            )}
            {/* Verwaltungs-Track (Block I): auf dem Demo-Mandanten direkt lokal
                verlinken (kein Kreisverweis über die absolute URL nötig). */}
            {inDemo ? (
              <Link
                href={`/${slug}/demo-verwaltung`}
                className="pz-btn pz-btn-secondary pz-btn-lg min-h-[48px]"
              >
                Verwaltungs-Demo ausprobieren
              </Link>
            ) : (
              <a
                href={DEMO_VERWALTUNG_URL}
                className="pz-btn pz-btn-secondary pz-btn-lg min-h-[48px]"
              >
                Verwaltungs-Demo ausprobieren
              </a>
            )}
            <a
              href={DEMO_MAILTO}
              className="pz-btn pz-btn-secondary pz-btn-lg min-h-[48px]"
            >
              Persönliche Demo anfragen
            </a>
          </div>
          <p className="mx-auto mt-3 max-w-xl text-sm" style={{ color: "var(--pz-body)" }}>
            {inDemo
              ? "Sie sind bereits in der Demo-Spielwiese — probieren Sie alles gefahrlos aus, jede Nacht wird zurückgesetzt."
              : "Die Demo-Spielwiese \u201eMusterstadt\u201c ist fiktiv, ohne Anmeldung nutzbar und wird jede Nacht zurückgesetzt — probieren Sie alles gefahrlos aus."}
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-6 py-14">
        {/* So funktioniert's — 4 Schritte */}
        <section>
          <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            So funktioniert es
          </h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-2">
            {SCHRITTE.map((s) => (
              <li key={s.n} className="pz-card p-5">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                    style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
                  >
                    {s.n}
                  </span>
                  <h3 className="text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
                    {s.titel}
                  </h3>
                </div>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
                  {s.text}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* Vertrauen / Trust-Badges */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Worauf Sie sich verlassen können
          </h2>
          <ul className="mt-4 flex flex-wrap gap-2.5">
            {TRUST.map((t) => (
              <li
                key={t}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
              >
                <span aria-hidden>✓</span> {t}
              </li>
            ))}
          </ul>
        </section>

        {/* Abschluss-CTA */}
        <section className="mt-12 rounded-2xl px-6 py-10 text-center" style={{ backgroundColor: "var(--pz-brand-strong)" }}>
          <h2 className="text-2xl font-semibold text-white">Interesse? Lernen Sie die Plattform kennen.</h2>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-white/90">
            Eine kurze Demo zeigt Ihnen die ganze Kette — von der Frage bis zum Ergebnis.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {!inDemo && (
              <a
                href={DEMO_URL}
                className="inline-flex min-h-[48px] items-center rounded-lg bg-white px-6 py-3 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90"
                style={{ color: "var(--pz-brand-strong)" }}
              >
                Demo sofort ausprobieren
              </a>
            )}
            <a
              href={DEMO_MAILTO}
              className="inline-flex min-h-[48px] items-center rounded-lg px-6 py-3 text-sm font-semibold text-white underline-offset-4 hover:underline"
            >
              Persönliche Demo anfragen
            </a>
            <Link
              href={`/${slug}`}
              className="inline-flex min-h-[48px] items-center rounded-lg px-6 py-3 text-sm font-semibold text-white underline-offset-4 hover:underline"
            >
              Plattform live ansehen →
            </Link>
          </div>
          <p className="mt-4 text-sm text-white/80">Oder direkt schreiben: patrick@seidler.ml</p>
        </section>
      </div>
    </main>
  );
}
