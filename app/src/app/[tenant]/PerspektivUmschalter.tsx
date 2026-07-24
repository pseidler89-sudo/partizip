"use client";

/**
 * PerspektivUmschalter — Segmented Control „Bürger-Ansicht ⇄ Aufgaben" für
 * ECHTE Rollenträger (kein Wegwerf-Admin wie in der Demo). Wird vom Layout NUR
 * gerendert, wenn der Server den Nutzer als Rollenträger erkannt hat
 * (hatAufgaben, serverseitig aus den account_status-gefilterten Rollen).
 *
 * Visuelle Vorlage: der Demo-Segmented-Control aus DemoGuide.tsx (Soft-Fläche
 * als Schiene, aktives Segment als weiße Pille, aria-pressed).
 *
 * WP2 — in-place/optimistisch: beim Klick flippt die weiße Pille SOFORT
 * (lokaler optimistischer State), die Navigation läuft in einer useTransition
 * hinterher (dezente Pending-Optik, keine Doppel-Auslösung). Sobald sich die
 * ROUTE ändert (usePathname), gewinnt die Route: der optimistische Zustand ist
 * an den Klick-Pfad gebunden und verfällt beim Routenwechsel von selbst
 * (abgeleitet, kein Effekt) — Wahrheit bleibt die Route, kein Hydration-
 * Mismatch, keine Abhängigkeit vom Cookie.
 *
 * Das Cookie ist reine UI-Präferenz (am Cookie hängt KEIN Recht — die echten
 * Fähigkeiten kommen aus den Rollen). Seit WP2 wird BEIDES gesetzt
 * ('aufgaben' bzw. 'buerger', je 30 Tage), damit der Login-Flow eine bewusste
 * Bürger-Wahl von „nie gewechselt" unterscheiden kann.
 */

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  PERSPEKTIVE_AUFGABEN,
  PERSPEKTIVE_BUERGER,
  PERSPEKTIVE_COOKIE,
  PERSPEKTIVE_MAX_AGE,
} from "@/lib/perspektive/constants";

/** Secure in Prod (https), lokal via http weglassen (Muster demo/perspektive-client). */
function secureFlag(): string {
  return typeof window !== "undefined" && window.location.protocol === "https:"
    ? "; Secure"
    : "";
}

function schreibePerspektive(wert: string): void {
  document.cookie =
    `${PERSPEKTIVE_COOKIE}=${wert}; Path=/; ` +
    `Max-Age=${PERSPEKTIVE_MAX_AGE}; SameSite=Lax${secureFlag()}`;
}

function setzeAufgaben(): void {
  schreibePerspektive(PERSPEKTIVE_AUFGABEN);
}

/**
 * WP2: „Bürger-Ansicht" SETZT den Wert 'buerger' (statt zu löschen) — nur so
 * kann der Login-Flow die bewusste Bürger-Wahl respektieren (kein Auto-Sprung
 * nach /aufgaben), ohne sie mit „nie gewechselt" zu verwechseln.
 */
function setzeBuerger(): void {
  schreibePerspektive(PERSPEKTIVE_BUERGER);
}

const segmentBase =
  "rounded-full px-3 py-1 text-xs font-semibold transition-colors focus:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-1";

export function PerspektivUmschalter({ slug }: { slug: string }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Optimistischer Zustand als ABGELEITETER Wert (kein Effekt nötig, die Route
  // gewinnt automatisch): beim Klick merken wir uns Wunsch-Ansicht + den Pfad,
  // AUF dem geklickt wurde. Solange der Pfad unverändert ist, zeigt die Pille
  // sofort den Wunsch; sobald sich die Route ändert (unsere Navigation ODER
  // ein externer Wechsel), verfällt der Optimismus und die Route entscheidet.
  const [optimistisch, setOptimistisch] = useState<{
    aufgaben: boolean;
    beiPfad: string;
  } | null>(null);

  // startsWith statt new RegExp(`^/${slug}`): kein Regex über einen dynamischen
  // Wert (Metazeichen-Falle), gleiche Semantik fürs Tenant-Präfix.
  const prefix = `/${slug}`;
  const p = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length) || "/"
    : pathname || "/";
  const routeAufgabenAktiv = p.startsWith("/aufgaben");

  const aufgabenAktiv =
    optimistisch !== null && optimistisch.beiPfad === pathname
      ? optimistisch.aufgaben
      : routeAufgabenAktiv;

  function zuBuerger() {
    if (isPending) return; // keine Doppel-Auslösung während der Navigation
    setzeBuerger();
    setOptimistisch({ aufgaben: false, beiPfad: pathname });
    startTransition(() => {
      router.push(`/${slug}/umfragen`);
    });
  }

  function zuAufgaben() {
    if (isPending) return;
    setzeAufgaben();
    setOptimistisch({ aufgaben: true, beiPfad: pathname });
    startTransition(() => {
      router.push(`/${slug}/aufgaben`);
    });
  }

  return (
    <div
      className="border-b px-4 py-2"
      style={{
        borderColor: "var(--pz-line)",
        backgroundColor: "color-mix(in srgb, var(--pz-brand) 4%, var(--pz-surface))",
      }}
    >
      <div className="mx-auto flex max-w-5xl items-center gap-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        <span className="hidden sm:inline">Ansicht:</span>
        <span
          className="inline-flex items-center gap-0.5 rounded-full bg-[color:var(--pz-brand-soft)] p-0.5 transition-opacity"
          role="group"
          aria-label="Ansicht wechseln"
          aria-busy={isPending}
          // Dezenter Pending-Zustand ohne Layout-Shift: nur Opacity.
          style={isPending ? { opacity: 0.6 } : undefined}
        >
          <button
            type="button"
            aria-pressed={!aufgabenAktiv}
            onClick={zuBuerger}
            className={segmentBase}
            style={
              !aufgabenAktiv
                ? {
                    backgroundColor: "#fff",
                    color: "var(--pz-brand-strong)",
                    boxShadow: "var(--pz-shadow-1)",
                  }
                : { backgroundColor: "transparent", color: "var(--pz-muted)" }
            }
          >
            Bürger-Ansicht
          </button>
          <button
            type="button"
            aria-pressed={aufgabenAktiv}
            onClick={zuAufgaben}
            className={segmentBase}
            style={
              aufgabenAktiv
                ? {
                    backgroundColor: "#fff",
                    color: "var(--pz-brand-strong)",
                    boxShadow: "var(--pz-shadow-1)",
                  }
                : { backgroundColor: "transparent", color: "var(--pz-muted)" }
            }
          >
            Aufgaben
          </button>
        </span>
      </div>
    </div>
  );
}
