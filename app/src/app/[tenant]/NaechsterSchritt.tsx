/**
 * NaechsterSchritt.tsx — Ein-Schritt-Nudge im Flow (Fläche B der
 * Einrichtungs-Checkliste). Zeigt IMMER NUR den einen nächsten offenen
 * Einrichtungs-Schritt (naechsterSchritt(status)) als schmale Zeile —
 * Optik an StufenFortschritt variant="inline" angelehnt.
 *
 * Server-tauglich präsentational (keine Hooks); nur der „Später"-Knopf ist
 * eine Client-Subkomponente (Cookie + refresh). Die aufrufenden Server-Seiten
 * lesen das Später-Cookie und rendern diese Zeile dann gar nicht erst —
 * ebenso wenig auf dem Demo-Mandanten oder wenn alles erledigt ist
 * (Anti-Empörungs-Linie: der Hinweis verschwindet vollständig).
 */

import Link from "next/link";
import type { EinrichtungsSchritt } from "@/lib/konto/einrichtung";
import { SpaeterKnopf } from "./SpaeterKnopf";

interface Props {
  /** Der EINE offene Schritt (aus naechsterSchritt) — nie mehrere zugleich. */
  schritt: EinrichtungsSchritt;
  tenantSlug: string;
}

/** Kurzer Nutzen-Satz + CTA je Schritt — Ziel ist jeweils der Ort der Erledigung. */
const SCHRITT_INHALT: Record<
  EinrichtungsSchritt,
  { text: string; cta: string; pfad: string }
> = {
  wohnort: {
    text: "Legen Sie Ihren Wohnort fest — Sie sehen zuerst die Fragen aus Ihrem Ortsteil und Ihrer Kommune.",
    cta: "Wohnort festlegen",
    pfad: "/umfragen",
  },
  verifizierung: {
    text: "Nur mit bestätigtem Wohnsitz zählen Sie bei verbindlichen Abstimmungen.",
    cta: "Wohnsitz bestätigen",
    pfad: "/verifizieren",
  },
  benachrichtigung: {
    text: "Sie erfahren per E-Mail, wenn eine neue Abstimmung in Ihrem Gebiet startet.",
    cta: "Benachrichtigungen einschalten",
    pfad: "/konto#benachrichtigungen",
  },
  teilnahme: {
    text: "Probieren Sie es einfach aus — unverbindliche Stimmungsbilder gehen ab Stufe 1.",
    cta: "Jetzt mitmachen",
    pfad: "/umfragen",
  },
};

export default function NaechsterSchritt({ schritt, tenantSlug }: Props) {
  const inhalt = SCHRITT_INHALT[schritt];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[color:var(--pz-line)] bg-[color:var(--pz-surface)] px-4 py-3">
      <span className="text-xs" style={{ color: "var(--pz-body)" }}>
        {inhalt.text}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <SpaeterKnopf />
        <Link
          href={`/${tenantSlug}${inhalt.pfad}`}
          className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
          style={{ backgroundColor: "var(--pz-brand)" }}
        >
          {inhalt.cta} →
        </Link>
      </span>
    </div>
  );
}
