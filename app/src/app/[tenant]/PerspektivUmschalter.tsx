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
 * hinterher (dezente Pending-Optik, keine Doppel-Auslösung). Die Route
 * gewinnt: der optimistische Wunsch zählt NUR solange die eigene Transition
 * läuft (isPending) — endet sie (auch wenn die Navigation auf demselben Pfad
 * endet, z. B. Guard-Redirect zurück) oder wechselt die Route extern
 * (Browser-Zurück, Nav-Link), entscheidet wieder allein die Route. Ein
 * abgelaufener Wunsch kann so nie reaktiviert werden. Wahrheit bleibt die
 * Route, kein Hydration-Mismatch, keine Abhängigkeit vom Cookie.
 *
 * Das Cookie ist reine UI-Präferenz (am Cookie hängt KEIN Recht — die echten
 * Fähigkeiten kommen aus den Rollen). Seit WP2 wird BEIDES gesetzt
 * ('aufgaben' bzw. 'buerger', je 30 Tage), damit der Login-Flow eine bewusste
 * Bürger-Wahl von „nie gewechselt" unterscheiden kann.
 */

import { useEffect, useRef, useState, useTransition } from "react";
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
  // Optimistischer Zustand: beim Klick merken wir uns nur die Wunsch-Ansicht;
  // die Pille zeigt sie sofort. Der Wunsch zählt AUSSCHLIESSLICH solange
  // unsere eigene Transition läuft (isPending) — endet sie, gewinnt sofort
  // wieder die Route. Bewusst NICHT über „Pfad noch gleich Klick-Pfad"
  // abgeleitet: diese Konstruktion würde den alten Wunsch reaktivieren, wenn
  // man später (Browser-Zurück, Nav-Link) exakt auf den Klick-Pfad
  // zurückkehrt (Gate-B MAJOR). Und sie deckt auch den Randfall ab, dass die
  // Navigation auf demselben Pfad endet (serverseitiger Guard-Redirect
  // zurück): isPending wird false → Route entscheidet, nichts bleibt hängen.
  const [optimistisch, setOptimistisch] = useState<boolean | null>(null);
  // Synchroner Doppelklick-Schutz: isPending wird erst beim nächsten Render
  // true — zwei sehr schnelle Klicks davor würden den State-Guard beide
  // passieren. Der Ref sperrt sofort und wird im Effekt unten wieder gelöst.
  const klickGesperrt = useRef(false);

  // startsWith statt new RegExp(`^/${slug}`): kein Regex über einen dynamischen
  // Wert (Metazeichen-Falle), gleiche Semantik fürs Tenant-Präfix.
  const prefix = `/${slug}`;
  const p = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length) || "/"
    : pathname || "/";
  const routeAufgabenAktiv = p.startsWith("/aufgaben");

  // Klick-Sperre lösen, sobald die Navigation abgeschlossen ist (reiner
  // Ref-Reset, kein setState im Effekt).
  useEffect(() => {
    if (!isPending) klickGesperrt.current = false;
  }, [isPending]);

  // Route gewinnt: der optimistische Wunsch zählt NUR während unserer eigenen
  // Transition. Direkt nach dem Klick sind setOptimistisch und startTransition
  // im selben Render-Batch wirksam (isPending schon true) — die Pille flippt
  // also sofort; mit dem Commit der Navigation (neuer pathname + isPending
  // false im selben Render) übernimmt nahtlos die Route. Ein abgeschlossener
  // (stale) Wunsch kann so weder nach Browser-Zurück noch nach einem
  // Guard-Redirect auf denselben Pfad je wieder aktiv werden.
  const aufgabenAktiv =
    isPending && optimistisch !== null ? optimistisch : routeAufgabenAktiv;

  function zuBuerger() {
    // Keine Doppel-Auslösung: Ref sperrt synchron (isPending erst nach Render).
    if (isPending || klickGesperrt.current) return;
    klickGesperrt.current = true;
    setzeBuerger();
    setOptimistisch(false);
    startTransition(() => {
      router.push(`/${slug}/umfragen`);
    });
  }

  function zuAufgaben() {
    if (isPending || klickGesperrt.current) return;
    klickGesperrt.current = true;
    setzeAufgaben();
    setOptimistisch(true);
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
