"use client";

/**
 * DemoGuide — dezente Schritt-Führung durch die Akquise-Demo, jetzt mit
 * Perspektiv-Umschalter „Ansehen als: Bürger:in | Verwaltung" (Block I).
 *
 * BÜRGER-Perspektive (Default, unverändert): Schritte hängen an der aktuellen
 * Route (Ankommen → Verstehen → Abstimmen → Beleg prüfen → Für Kommunen), genau
 * EINE Weiter-Aktion, kein Zustand — man kann nichts falsch machen.
 *
 * VERWALTUNGS-Perspektive: der Hands-on-Track (Frage erstellen → als Bürger:in
 * abstimmen → schließen → Rollen → Für Kommunen). Schritt 1 und 3 liegen auf
 * DERSELBEN Route (/admin/abstimmungen) — der Schritt-Index kann daher NICHT
 * aus der Route kommen und lebt stattdessen in sessionStorage (endet mit dem
 * Tab), mit expliziten Zurück-/Weiter-Knöpfen + CTA-Link je Schritt.
 *
 * Die aktive Perspektive kommt aus dem UI-Cookie pz_demo_perspektive (Client-
 * seitig gelesen, erst nach Mount — SSR rendert den Bürger-Default, sonst
 * Hydration-Mismatch). Am Cookie hängt KEIN Recht: der Umschalter „Verwaltung"
 * ruft die Server Action demoVerwaltungStarten(), die die echte Berechtigung
 * (ephemere Session + kommune_admin-Rolle) serverseitig und NUR auf dem
 * Demo-Mandanten erzeugt. Wird vom Layout nur auf dem Demo-Mandanten gerendert.
 */

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { demoVerwaltungStarten } from "@/lib/demo/actions";
import {
  gespeicherterSchritt,
  istVerwaltungsPerspektive,
  loeschePerspektive,
  setzePerspektiveVerwaltung,
  speichereSchritt,
  subscribeDemoPerspektive,
} from "@/lib/demo/perspektive-client";

interface Step {
  n: 1 | 2 | 3 | 4 | 5;
  label: string;
  /** Ziel der einen Weiter-Aktion (null auf dem letzten Schritt). */
  next: { href: string; label: string } | null;
}

/** Hands-on-Track der Verwaltungs-Perspektive; pfad relativ zum Tenant-Slug. */
const VERWALTUNG_SCHRITTE: { label: string; ctaPfad: string; ctaLabel: string }[] = [
  {
    label: "Eigene Frage erstellen & aktivieren",
    ctaPfad: "/admin/abstimmungen",
    ctaLabel: "Zur Abstimmungs-Verwaltung",
  },
  {
    label: "Als Bürger:in ansehen & abstimmen",
    ctaPfad: "",
    ctaLabel: "Zur Bürger-Ansicht",
  },
  {
    label: "Frage schließen — das Ergebnis wird ausgezählt",
    ctaPfad: "/admin/abstimmungen",
    ctaLabel: "Zur Abstimmungs-Verwaltung",
  },
  {
    label: "Rollen & Vier-Augen ansehen",
    ctaPfad: "/admin/rollen",
    ctaLabel: "Rollen ansehen",
  },
  {
    label: "Für Ihre Kommune",
    ctaPfad: "/fuer-kommunen",
    ctaLabel: "Für Ihre Kommune",
  },
];

export function DemoGuide({
  slug,
  belegeHref,
}: {
  slug: string;
  belegeHref: string;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const p = pathname.replace(new RegExp(`^/${slug}`), "") || "/";

  // Perspektive + Schrittzähler aus Cookie/sessionStorage als externem Store —
  // SSR-Snapshot ist der Bürger-Default (Schritt 1), kein Hydration-Mismatch.
  const verwaltung = useSyncExternalStore(
    subscribeDemoPerspektive,
    istVerwaltungsPerspektive,
    () => false,
  );
  const schritt = useSyncExternalStore(
    subscribeDemoPerspektive,
    gespeicherterSchritt,
    () => 1,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function zurVerwaltung() {
    if (busy || verwaltung) return;
    setError(null);
    setBusy(true);
    try {
      // Serverseitig: ephemere Session + kommune_admin NUR auf dem Demo-Mandanten.
      const result = await demoVerwaltungStarten();
      if (!result.ok) {
        setError(result.error ?? "Demo-Start fehlgeschlagen.");
        return;
      }
      setzePerspektiveVerwaltung();
      router.push(`/${slug}/admin/abstimmungen`);
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  function zurBuergerin() {
    if (busy || !verwaltung) return;
    setError(null);
    // Nur das UI-Cookie löschen — die (rechtefreie) Bürger-Sicht steht sofort;
    // die ephemere Session läuft über TTL/Reset aus.
    loeschePerspektive();
    router.push(`/${slug}`);
  }

  function geheZuSchritt(n: number) {
    const geklemmt = speichereSchritt(n);
    router.push(`/${slug}${VERWALTUNG_SCHRITTE[geklemmt - 1].ctaPfad}`);
  }

  // Bürger-Perspektive: Schritt aus der Route (unverändert).
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

  // Auf Neben-Routen (Konto, Impressum …) keine Bürger-Führung — nicht stören.
  // In der VERWALTUNGS-Perspektive rendert der Guide dagegen überall: die
  // Schritte hängen nicht an der Route, und der Rück-Umschalter muss auch auf
  // den Admin-Seiten erreichbar bleiben.
  if (!verwaltung && !step) return null;

  const vs = VERWALTUNG_SCHRITTE[schritt - 1];

  const segmentBase =
    "rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors focus:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-1 " +
    "disabled:cursor-not-allowed disabled:opacity-60";
  const knopfBase =
    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold transition-colors " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] " +
    "focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <nav
      aria-label="Demo-Rundgang"
      className="border-b px-4 py-2"
      style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-card)" }}
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {/* Perspektiv-Umschalter — beide Knöpfe tastaturbedienbar (aria-pressed). */}
        <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: "var(--pz-muted)" }}>
          <span className="hidden sm:inline">Ansehen als:</span>
          <span
            className="inline-flex items-center gap-0.5 rounded-full border p-0.5"
            style={{ borderColor: "var(--pz-line)" }}
          >
            <button
              type="button"
              aria-pressed={!verwaltung}
              disabled={busy}
              onClick={zurBuergerin}
              className={segmentBase}
              style={
                !verwaltung
                  ? { backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }
                  : { color: "var(--pz-muted)" }
              }
            >
              Bürger:in
            </button>
            <button
              type="button"
              aria-pressed={verwaltung}
              disabled={busy}
              onClick={zurVerwaltung}
              className={segmentBase}
              style={
                verwaltung
                  ? { backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }
                  : { color: "var(--pz-muted)" }
              }
            >
              {busy ? "Startet …" : "Verwaltung"}
            </button>
          </span>
        </span>

        {verwaltung ? (
          <>
            <span
              className="inline-flex items-center gap-2 text-xs sm:text-sm"
              style={{ color: "var(--pz-body)" }}
            >
              <span
                className="inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold"
                style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
              >
                Schritt {schritt} von {VERWALTUNG_SCHRITTE.length}
              </span>
              {vs.label}
            </span>
            <span className="inline-flex items-center gap-3">
              <Link
                href={`/${slug}${vs.ctaPfad}`}
                className="inline-flex items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline sm:text-sm"
                style={{ color: "var(--pz-brand-strong)" }}
              >
                {vs.ctaLabel}
                <ArrowRight aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
              </Link>
              <span className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => geheZuSchritt(schritt - 1)}
                  disabled={schritt <= 1}
                  className={knopfBase}
                  style={{ color: "var(--pz-body)" }}
                >
                  <ArrowLeft aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
                  Zurück
                </button>
                <button
                  type="button"
                  onClick={() => geheZuSchritt(schritt + 1)}
                  disabled={schritt >= VERWALTUNG_SCHRITTE.length}
                  className={knopfBase}
                  style={{ color: "var(--pz-brand-strong)" }}
                >
                  Weiter
                  <ArrowRight aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </span>
            </span>
          </>
        ) : (
          step && (
            <>
              <span
                className="inline-flex items-center gap-2 text-xs sm:text-sm"
                style={{ color: "var(--pz-body)" }}
              >
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
            </>
          )
        )}
      </div>
      {error && (
        <p className="mx-auto mt-1 max-w-3xl text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </nav>
  );
}
