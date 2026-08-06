/**
 * [tenant]/anleitung/mitmachen/page.tsx — die Bürger-Spur.
 *
 * ÖFFENTLICH (Stufe 0), ohne Datenbank- und ohne Session-Zugriff: die Seite ist
 * reine Textausspielung aus anleitung-daten.ts. Damit funktioniert sie auch
 * ohne JavaScript vollständig und lässt sich sinnvoll ausdrucken.
 *
 * Inhalte ändern: NUR in ../anleitung-daten.ts (BUERGER_SPUR).
 */

import type { Metadata } from "next";
import Link from "next/link";
import SpurInhalt from "../SpurInhalt";
import { BUERGER_SPUR } from "../anleitung-daten";

export const metadata: Metadata = {
  title: "Anleitung: Mitmachen — Partizip",
  description:
    "Schritt für Schritt: lesen, mitstimmen, Wohnsitz bestätigen lassen. Und was " +
    "mit Ihrer Stimme passiert.",
};

export default async function AnleitungMitmachenPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {/* Rücksprung zur Abholseite — im Ausdruck überflüssig, deshalb dort aus. */}
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
          {BUERGER_SPUR.titel}
        </h1>
      </header>

      <SpurInhalt spur={BUERGER_SPUR} slug={slug} ebene={2} />
    </main>
  );
}
