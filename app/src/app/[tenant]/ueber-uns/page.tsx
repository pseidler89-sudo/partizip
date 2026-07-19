/**
 * [tenant]/ueber-uns/page.tsx — Über uns / Presse.
 *
 * Öffentliche Vertrauens-/Presseseite (Stufe 0, im [tenant]-Layout): Mission,
 * Überparteilichkeits-Statement (inkl. ausdrücklicher Partei-Absage), Methodik
 * (wie Umfragen und Ratsinfos entstehen), Pressekontakt, Quellcode-Hinweis.
 * Inhalt gespiegelt aus dem verbindlichen Konzept (Kernprinzipien Kap. 1) und
 * den öffentlichen Bausteinen (Transparenz, ADR-028 KI-Neutralität). Ton „Sie".
 */

import type { Metadata } from "next";
import Link from "next/link";
import { ANBIETER } from "@/lib/legal/anbieter";
import { PLATFORM_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Über uns & Presse — Partizip",
  description:
    "Wer hinter Partizip steht, warum die Plattform überparteilich ist, wie wir arbeiten — und wie Sie uns als Presse erreichen.",
};

const PRINZIPIEN: { titel: string; text: string }[] = [
  {
    titel: "Überparteilich",
    text: "Keine Partei ist Kundin, Trägerin oder bevorzugte Partnerin. Keine Parteilogos, keine Parteikooperationen, kein Zugang für Parteien zu Nutzerdaten — auch nicht „nur für den Start“.",
  },
  {
    titel: "Verifiziert, aber anonym",
    text: "Ob jemand teilnahmeberechtigt ist, wird geprüft; wie jemand abgestimmt hat, bleibt geheim. Ihre Stimme ist nicht mit Ihrem Konto verknüpft gespeichert.",
  },
  {
    titel: "Nur Richtung Teilnahme nudgen — nie Richtung Meinung",
    text: "Wir laden zum Mitmachen ein, beeinflussen aber nie, wofür Sie stimmen. Keine Dark Patterns.",
  },
  {
    titel: "Bürgerinnen und Bürger zahlen nie",
    text: "Die Teilnahme ist und bleibt kostenlos — auch die Verifizierung.",
  },
  {
    titel: "Datensparsam und zweckgebunden",
    text: "Daten sind nie das Produkt; das Werkzeug ist es. Wir erheben nur, was für die Beteiligung nötig ist.",
  },
  {
    titel: "Kein Vorwurf, nur Status",
    text: "Die Plattform dokumentiert neutral und urteilt nicht. Auch „liegt seit Monaten im Ausschuss“ ist ein sachlicher Status, keine Anklage.",
  },
];

export default async function UeberUnsPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="text-center">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Über uns &amp; Presse
        </h1>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          {PLATFORM_NAME} ist eine überparteiliche, kommunale Beteiligungsplattform.
          Sie holt Menschen zurück, die das Vertrauen in Politik verloren haben —
          nicht durch Behauptungen, sondern durch nachweisbares Zuhören und
          größtmögliche Transparenz bei geringstmöglicher Hürde.
        </p>
      </header>

      {/* Mission */}
      <section className="mt-12">
        <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Warum es uns gibt
        </h2>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Kommunalpolitik entscheidet über das, was Menschen unmittelbar umgibt —
          und wird trotzdem am seltensten mitgestaltet. {PLATFORM_NAME} macht das
          Mitreden vor Ort einfach: eine kurze Frage, ein sofortiges Ergebnis, ein
          Konto so spät wie möglich. Fragen stellen können Ortsbeiräte, Verwaltung
          und Kommunalpolitik über ein gestuftes Modell; die Tiefenschicht bilden
          verständlich aufbereitete Ratsinformationen, jede Aussage mit Fundstelle.
        </p>
      </section>

      {/* Prinzipien / Überparteilichkeit */}
      <section className="mt-12">
        <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Woran wir uns halten
        </h2>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Diese Grundsätze sind für uns nicht verhandelbar. Sie sind der Grund,
          warum auch eine Verwaltung {PLATFORM_NAME} nutzen kann, ohne sich ein
          Parteiwerkzeug ins Haus zu holen.
        </p>
        <div className="mt-6 space-y-3">
          {PRINZIPIEN.map((p) => (
            <div
              key={p.titel}
              className="rounded-xl border p-4"
              style={{ borderColor: "var(--pz-line)" }}
            >
              <h3 className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
                {p.titel}
              </h3>
              <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
                {p.text}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Methodik */}
      <section className="mt-12">
        <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Wie wir arbeiten
        </h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          <li>
            <strong style={{ color: "var(--pz-ink)" }}>Geheime Wahl.</strong> Stimmen
            werden über ein Pseudonym gezählt, das nicht mit dem Konto verknüpft
            gespeichert wird. Was wir sehen können und was ausdrücklich nicht, legen
            wir in jedem Konto offen.
          </li>
          <li>
            <strong style={{ color: "var(--pz-ink)" }}>Ehrliche Stichprobe.</strong> Wir
            behaupten keine Repräsentativität. Ergebnisse zeigen die Stichprobe
            transparent; kleine Gruppen werden zum Schutz der Anonymität
            zusammengefasst.
          </li>
          <li>
            <strong style={{ color: "var(--pz-ink)" }}>Belegte Ratsinformationen.</strong>{" "}
            Zusammenfassungen aus öffentlichen Protokollen und Vorlagen werden vor
            Veröffentlichung von einem Menschen freigegeben — jede Aussage mit
            Fundstellenlink. Freigaben sind auf unserer{" "}
            <Link
              href={`/${slug}/transparenz`}
              className="underline"
              style={{ color: "var(--pz-brand)" }}
            >
              Transparenzseite
            </Link>{" "}
            nachvollziehbar.
          </li>
          <li>
            <strong style={{ color: "var(--pz-ink)" }}>Nachvollziehbare KI statt
            Blackbox.</strong> Wo wir Künstliche Intelligenz einsetzen, geschieht das
            mit einem öffentlich einsehbaren Prüfmaßstab und menschlicher
            Letztentscheidung — nie als automatische Ablehnung. Der Mensch bleibt die
            letzte Instanz.
          </li>
          <li>
            <strong style={{ color: "var(--pz-ink)" }}>Offener Quellcode.</strong> Die
            Plattform ist quelloffen. Wer wissen will, wie etwas funktioniert, kann
            nachlesen:{" "}
            <a
              href="https://github.com/pseidler89-sudo/partizip"
              className="underline"
              style={{ color: "var(--pz-brand)" }}
              rel="noreferrer"
            >
              github.com/pseidler89-sudo/partizip
            </a>
            .
          </li>
        </ul>
      </section>

      {/* Presse / Kontakt */}
      <section className="pz-card mt-12 p-6">
        <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Presse &amp; Kontakt
        </h2>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Für Presseanfragen, Hintergrundgespräche oder eine Demo erreichen Sie uns
          direkt:
        </p>
        <p className="mt-3 text-sm" style={{ color: "var(--pz-ink)" }}>
          {ANBIETER.name}
          <br />
          <a
            href={`mailto:${ANBIETER.email}`}
            className="underline"
            style={{ color: "var(--pz-brand)" }}
          >
            {ANBIETER.email}
          </a>
        </p>
        <p className="mt-4 text-xs" style={{ color: "var(--pz-muted)" }}>
          Vollständige Anbieterangaben finden Sie im{" "}
          <Link
            href={`/${slug}/impressum`}
            className="underline"
            style={{ color: "var(--pz-brand)" }}
          >
            Impressum
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
