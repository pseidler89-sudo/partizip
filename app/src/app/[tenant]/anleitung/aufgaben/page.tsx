/**
 * [tenant]/anleitung/aufgaben/page.tsx — die Rollenträger-Anleitung.
 *
 * EINE Seite mit vier Abschnitten (Verifizierung, Redaktion, Administration,
 * Beobachtung) statt vier Routen — bewusst: Rollen kommen kombiniert vor
 * (ein kommune_admin darf auch verifizieren), und eine lange Seite lässt sich
 * am Stück lesen, durchsuchen und ausdrucken. Jeder Abschnitt hat einen stabilen
 * Anker, damit die Abholseite direkt hineinspringen kann.
 *
 * ÖFFENTLICH LESBAR (Owner-Entscheidung): Die Schutzwirkung sitzt an den echten
 * Flächen (Server-Guards), nicht an der Dokumentation. Wer nachlesen kann, was
 * eine Verifizierungsstelle darf und was sie NICHT speichert, kann der Plattform
 * eher vertrauen. Kein DB-, kein Session-Zugriff auf dieser Seite.
 *
 * KEINE Spur für die Betreiberrolle (super_admin) — Betreiber-Wissen gehört in
 * die internen Runbooks, nicht in eine öffentliche Anleitung.
 *
 * Inhalte ändern: NUR in ../anleitung-daten.ts (AUFGABEN_SPUREN).
 */

import type { Metadata } from "next";
import Link from "next/link";
import SpurInhalt from "../SpurInhalt";
import { AUFGABEN_SPUREN } from "../anleitung-daten";

export const metadata: Metadata = {
  title: "Anleitung für Rollenträger — Partizip",
  description:
    "Wohnsitz bestätigen, Ratsinfos schreiben, verwalten und freigeben, mitlesen — " +
    "was jede Aufgabe umfasst und wo ihre Grenzen liegen.",
};

export default async function AnleitungAufgabenPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-sm print:hidden">
        <Link
          href={`/${slug}/anleitung`}
          className="underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          style={{ color: "var(--pz-muted)" }}
        >
          <span aria-hidden>← </span>Alle Anleitungen
        </Link>
      </p>

      <header className="mt-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Anleitung für Rollenträger
        </h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Vier Aufgaben, vier Abschnitte. Wer mehrere Rollen hat, liest mehrere
          Abschnitte — die Rechte addieren sich, die Grenzen bleiben.
        </p>
      </header>

      {/* Inhaltsverzeichnis: erlaubt das Springen und macht den Umfang sichtbar.
          Als <nav> mit Beschriftung, damit Screenreader es überspringen können. */}
      <nav className="mt-6" aria-label="Abschnitte dieser Anleitung">
        <ul className="space-y-2 text-sm">
          {AUFGABEN_SPUREN.map((spur) => (
            <li key={spur.id}>
              <a
                href={`#${spur.id}`}
                className="font-medium underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                style={{ color: "var(--pz-brand-strong)" }}
              >
                {spur.titel}
              </a>
              <span style={{ color: "var(--pz-muted)" }}> — {spur.kurz}</span>
            </li>
          ))}
        </ul>
      </nav>

      {AUFGABEN_SPUREN.map((spur) => (
        <section
          key={spur.id}
          id={spur.id}
          className="mt-14 border-t pt-8"
          style={{ borderColor: "var(--pz-line)" }}
          aria-labelledby={`${spur.id}-titel`}
        >
          <h2
            id={`${spur.id}-titel`}
            className="text-xl font-semibold"
            style={{ color: "var(--pz-ink)" }}
          >
            {spur.titel}
          </h2>
          <SpurInhalt spur={spur} slug={slug} ebene={3} />
        </section>
      ))}

      <p className="mt-14 text-sm leading-relaxed" style={{ color: "var(--pz-muted)" }}>
        Für die Betreiberrolle der Plattform gibt es hier bewusst keine Anleitung:
        Sie liegt beim Betreiber selbst und ist nicht Teil des Kommunen-Betriebs.
      </p>
    </main>
  );
}
