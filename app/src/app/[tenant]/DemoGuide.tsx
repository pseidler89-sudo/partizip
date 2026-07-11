"use client";

/**
 * DemoGuide — dezente Schritt-Führung durch die Akquise-Demo („1 von 5").
 *
 * Zeigt anhand der aktuellen Route, wo im Soll-Erlebnis der Besucher steht
 * (Ankommen → Verstehen → Abstimmen → Beleg prüfen → Für Kommunen) und bietet
 * genau EINE Weiter-Aktion. Rein präsentational: keine Daten-Mutation, kein
 * Zustand außer der Route — man kann nichts falsch machen, kein Zurück in
 * Sackgassen. Wird vom Layout nur auf dem Demo-Mandanten gerendert.
 *
 * belegeHref: Belege-Liste der geseedeten GESCHLOSSENEN Beispiel-Frage (die
 * öffentliche Liste existiert bewusst erst nach Abstimmungsende — der Guide
 * zeigt den Prüf-Moment daher an der abgeschlossenen Frage).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";

interface Step {
  n: 1 | 2 | 3 | 4 | 5;
  label: string;
  /** Ziel der einen Weiter-Aktion (null auf dem letzten Schritt). */
  next: { href: string; label: string } | null;
}

export function DemoGuide({
  slug,
  belegeHref,
}: {
  slug: string;
  belegeHref: string;
}) {
  const pathname = usePathname() ?? "";
  const p = pathname.replace(new RegExp(`^/${slug}`), "") || "/";

  let step: Step | null = null;
  if (p === "/") {
    step = {
      n: 1,
      label: "Ankommen — das sehen Bürger:innen Ihrer Kommune",
      next: { href: `/${slug}/digest`, label: "Ratsinfos ansehen" },
    };
  } else if (p.startsWith("/digest")) {
    step = {
      n: 2,
      label: "Verstehen — Ratsinfos, menschlich freigegeben",
      next: { href: `/${slug}/umfragen`, label: "Jetzt abstimmen" },
    };
  } else if (p.startsWith("/umfrage/") && p.endsWith("/belege")) {
    step = {
      n: 4,
      label: "Beleg prüfen — Sie müssen uns nicht glauben",
      next: { href: `/${slug}/fuer-kommunen`, label: "Für Ihre Kommune" },
    };
  } else if (p.startsWith("/umfragen") || p.startsWith("/umfrage/")) {
    step = {
      n: 3,
      label: "Abstimmen — anonym, mit Beleg-Code",
      next: { href: belegeHref, label: "Beleg-Liste ansehen" },
    };
  } else if (p.startsWith("/fuer-kommunen")) {
    step = {
      n: 5,
      label: "Für Ihre Kommune — so geht es weiter",
      next: null,
    };
  }

  // Auf Neben-Routen (Konto, Impressum …) keine Führung — nicht stören.
  if (!step) return null;

  return (
    <nav
      aria-label="Demo-Rundgang"
      className="border-b px-4 py-2"
      style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-card)" }}
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-2 text-xs sm:text-sm" style={{ color: "var(--pz-body)" }}>
          <span
            className="inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold"
            style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
          >
            Schritt {step.n} von 5
          </span>
          {step.label}
        </span>
        {step.next && (
          <Link
            href={step.next.href}
            className="inline-flex items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline sm:text-sm"
            style={{ color: "var(--pz-brand-strong)" }}
          >
            {step.next.label}
            <ArrowRight aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          </Link>
        )}
      </div>
    </nav>
  );
}
