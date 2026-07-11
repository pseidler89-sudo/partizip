/**
 * Landing.tsx — Bürger-Landingpage (Haustür), Mitmachen-first (ADR-015).
 *
 * Aus der Landingpage-Recherche/-Konzept-Loop:
 * EINE dominante Aktion (PLZ-/Standort-Einstieg) im Hero, „erst sehen, dann Konto",
 * Vertrauen belegt statt behauptet, Bürger oben / Multiplikatoren-Pitch abgesetzt unten.
 * Server-Komponente; interaktive Teile sind RegionEinstieg + LoginForm (Client).
 *
 * Vorbild-Mix: GOV.UK-Klarheit · meinBerlin-Kartenraster · Linear/Civic-Teal-Ruhe.
 */

import Link from "next/link";
import { RegionEinstieg } from "./RegionEinstieg";
import { LoginForm } from "./LoginForm";

const SCHRITTE = [
  {
    titel: "Postleitzahl eingeben",
    text: "Sie sehen sofort die Abstimmungen aus Ihrem Ortsteil, Ihrer Stadt und Ihrem Kreis — ohne Anmeldung.",
  },
  {
    titel: "In Ruhe ansehen",
    text: "Frage und bisheriges Ergebnis sind für alle sichtbar. Schauen Sie, was vor Ort gerade bewegt wird.",
  },
  {
    titel: "Mit einem Klick mitstimmen",
    text: "Anmeldung per Link an Ihre E-Mail — ohne Passwort, ab 16. Ihre Stimme bleibt geheim.",
  },
];

const VERTRAUEN = [
  {
    titel: "Geheime Wahl",
    text: "Niemand sieht, wie Sie abgestimmt haben — auch wir nicht. Ihre Stimme zählt anonym.",
  },
  {
    titel: "Kein Tracking, keine Werbung",
    text: "Wir analysieren Sie nicht und verkaufen keine Daten. Keine Like-Jagd, kein Algorithmus.",
  },
  {
    titel: "Überparteilich & unabhängig",
    text: "Alle Antwortmöglichkeiten sind gleichwertig. Keine Parteifarben, keine Schlagseite.",
  },
  {
    titel: "Ergebnisse öffentlich",
    text: "Wie abgestimmt wurde, ist für alle einsehbar — Mitmachen wird sichtbar.",
  },
];

const NUTZEN = [
  "Mitreden, ohne zur Versammlung gehen zu müssen.",
  "Sehen, was Ihre Nachbarschaft bewegt.",
  "In wenigen Minuten, von zu Hause oder unterwegs.",
  "Auch für Ihren Ortsteil — nicht nur die große Politik.",
];

const FAQ = [
  { f: "Ist das wirklich anonym?", a: "Ja. Wir speichern nicht, wie Sie abgestimmt haben. Ihre Stimme ist von Ihrer Person getrennt (geheime Wahl)." },
  { f: "Kostet das etwas?", a: "Nein. Die Teilnahme ist für Bürgerinnen und Bürger kostenlos." },
  { f: "Brauche ich eine App?", a: "Nein. Alles läuft im Browser — am Handy, Tablet oder Computer." },
  { f: "Ab welchem Alter?", a: "Ab 16 Jahren. Das bestätigen Sie einmalig bei der Anmeldung." },
  { f: "Brauche ich ein Passwort?", a: "Nein. Sie erhalten einen Anmelde-Link per E-Mail — ohne Passwort." },
  { f: "Ich bin technisch unsicher — geht das trotzdem?", a: "Ja. Sie brauchen nur Ihre Postleitzahl und eine E-Mail-Adresse. Mehr nicht." },
];

/**
 * Statischer Vorschau-Mock — „so sieht es aus". Auf der ÖFFENTLICHEN Seite muss
 * jede Karte unübersehbar als Beispiel gekennzeichnet sein: die Zahlen sind
 * illustrativ, nicht real (Ehrlichkeits-Leitplanke — erfundene Stimmen-Zahlen
 * dürfen nie wie laufende echte Abstimmungen aussehen).
 */
function PreviewKarten() {
  const karten = [
    { ebene: "Ortsteil", frage: "Soll der Spielplatz am Rathausplatz erneuert werden?", tage: "Noch 6 Tage", stimmen: "312 Stimmen · 180 wohnsitz-verifiziert" },
    { ebene: "Kommune", frage: "Tempo 30 in allen Wohngebieten?", tage: "Noch 11 Tage", stimmen: "1.204 Stimmen · 642 wohnsitz-verifiziert" },
    { ebene: "Kreis", frage: "Radwege-Ausbau zuerst priorisieren?", tage: "Noch 3 Tage", stimmen: "2.870 Stimmen · 1.510 wohnsitz-verifiziert" },
  ];
  return (
    <div className="space-y-3" aria-hidden>
      {karten.map((k) => (
        <div key={k.ebene} className="pz-card p-4">
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
          >
            {k.ebene}
          </span>
          <span
            className="ml-1.5 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: "var(--pz-neutral-soft, #eee)", color: "var(--pz-muted)" }}
          >
            Beispiel
          </span>
          <p className="mt-2 text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>{k.frage}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>{k.tage} · {k.stimmen}</p>
        </div>
      ))}
    </div>
  );
}

function TrustZeile() {
  const items = ["Geheime Wahl", "Kein Tracking", "Überparteilich", "Mitmachen ab 16"];
  return (
    <ul className="mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm lg:justify-start" style={{ color: "var(--pz-body)" }}>
      {items.map((i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <span aria-hidden style={{ color: "var(--pz-brand-strong)" }}>✓</span> {i}
        </li>
      ))}
    </ul>
  );
}

export function Landing({ tenantName, slug }: { tenantName: string; slug: string }) {
  return (
    <main>
      {/* 1) Hero — eine dominante Aktion: PLZ-Einstieg */}
      <section className="pz-hero">
        <div className="mx-auto grid max-w-5xl items-center gap-10 px-6 py-16 lg:grid-cols-2">
          <div className="text-center lg:text-left">
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
              style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
            >
              <span aria-hidden>●</span> Kommunale Beteiligung · überparteilich
            </span>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl" style={{ color: "var(--pz-ink)" }}>
              Worüber wird gerade bei Ihnen abgestimmt?
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed lg:mx-0" style={{ color: "var(--pz-body)" }}>
              Postleitzahl eingeben und sofort die Umfragen aus Ihrem Ortsteil, Ihrer Stadt
              und Ihrem Kreis sehen. Ohne Anmeldung, ohne Passwort.
            </p>
            <div className="mt-8">
              <RegionEinstieg tenantName={tenantName} />
            </div>
            <TrustZeile />
          </div>
          {/* Echtes Produkt-Visual statt Stockfoto (Vorschau-Mock) */}
          <div className="hidden lg:block" aria-hidden>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--pz-muted)" }}>
              So sieht es aus — Beispiel-Vorschau
            </p>
            <PreviewKarten />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-6">
        {/* 2) So funktioniert's — 3 Schritte */}
        <section className="py-14">
          <h2 className="text-center text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            So einfach machen Sie mit
          </h2>
          <ol className="mt-8 grid gap-5 sm:grid-cols-3">
            {SCHRITTE.map((s, i) => (
              <li key={s.titel} className="pz-card p-6">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full text-base font-semibold text-white"
                  style={{ backgroundColor: "var(--tenant-primary)" }}
                >
                  {i + 1}
                </div>
                <h3 className="mt-3 text-base font-semibold" style={{ color: "var(--pz-ink)" }}>{s.titel}</h3>
                <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* 3) Vertrauen & Überparteilichkeit */}
        <section className="py-14">
          <div className="text-center">
            <h2 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
              Ihre Stimme ist sicher — und sie zählt
            </h2>
            <p className="mx-auto mt-2 max-w-2xl text-base" style={{ color: "var(--pz-body)" }}>
              Wir behaupten Vertrauen nicht nur, wir bauen es ein.
            </p>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {VERTRAUEN.map((v) => (
              <div key={v.titel} className="pz-card flex gap-3 p-5">
                <span aria-hidden className="text-lg leading-none" style={{ color: "var(--pz-brand-strong)" }}>✓</span>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>{v.titel}</h3>
                  <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>{v.text}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 4) Warum mitmachen */}
        <section className="py-14">
          <h2 className="text-center text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Warum mitmachen?</h2>
          <ul className="mx-auto mt-6 grid max-w-3xl gap-3 sm:grid-cols-2">
            {NUTZEN.map((n) => (
              <li key={n} className="flex items-start gap-2.5 text-base" style={{ color: "var(--pz-body)" }}>
                <span aria-hidden className="mt-0.5" style={{ color: "var(--pz-brand-strong)" }}>→</span> {n}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* 5) CTA-Wiederholung (gleiche Aktion) */}
      <section className="pz-hero">
        <div className="mx-auto max-w-xl px-6 py-14 text-center">
          <h2 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Bereit? Sehen Sie, worüber bei Ihnen abgestimmt wird.
          </h2>
          <div className="mt-7">
            <RegionEinstieg tenantName={tenantName} />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-6">
        {/* 6) FAQ */}
        <section className="py-14">
          <h2 className="text-center text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Häufige Fragen</h2>
          <div className="mt-6 space-y-3">
            {FAQ.map((q) => (
              <details key={q.f} className="pz-card p-4">
                <summary className="cursor-pointer text-sm font-semibold marker:text-[color:var(--pz-brand-strong)]" style={{ color: "var(--pz-ink)" }}>
                  {q.f}
                </summary>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>{q.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* 8) Anmelden (sekundär, für Wiederkehrende) */}
        <section id="anmelden" className="pb-6">
          <div className="pz-card p-8">
            <div className="mb-6 text-center">
              <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>Schon dabei? Anmelden</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
                Per E-Mail-Link, ohne Passwort. Frage und Ergebnis sehen Sie auch ohne Anmeldung.
              </p>
            </div>
            <LoginForm tenantSlug={slug} />
          </div>
        </section>
      </div>

      {/* 9) Für Kommunen & Vereine — abgesetzter Teaser, der auf die schlanke
          B2G-Seite verlinkt (P2 §Empf. 6: Bürger-Landing bleibt fokussiert). */}
      <section id="fuer-kommunen" className="mt-8" style={{ backgroundColor: "var(--pz-brand-strong)" }}>
        <div className="mx-auto max-w-3xl px-6 py-14 text-center text-white">
          <h2 className="text-2xl font-semibold">Sie entscheiden für eine Kommune, einen Kreis oder einen Verein?</h2>
          <p className="mx-auto mt-3 max-w-2xl text-base leading-relaxed text-white/90">
            Halten Sie bürgernahe Umfragen ab — datensparsam, ohne Tracking, in wenigen Tagen
            startklar. DSGVO- und barrierefrei (WCAG 2.1 AA), gehostet in Deutschland.
          </p>
          <Link
            href={`/${slug}/fuer-kommunen`}
            className="mt-7 inline-flex min-h-[48px] items-center rounded-lg bg-white px-6 py-3 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90"
            style={{ color: "var(--pz-brand-strong)" }}
          >
            Für Kommunen & Vereine →
          </Link>
          <p className="mt-3 text-sm text-white/80">Oder direkt eine Demo anfragen: patrick@seidler.ml</p>
        </div>
      </section>
    </main>
  );
}
