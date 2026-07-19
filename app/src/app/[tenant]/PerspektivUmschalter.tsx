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
 * Aktiver Zustand kommt aus der ROUTE (usePathname), NICHT aus dem Cookie: auf
 * /aufgaben ist „Aufgaben" aktiv, sonst „Bürger-Ansicht" — so gibt es kein
 * Hydration-Mismatch und keine Abhängigkeit vom Cookie. Das Cookie ist reine
 * UI-Präferenz (am Cookie hängt KEIN Recht — die echten Fähigkeiten kommen aus
 * den Rollen); es wird beim Umschalten gesetzt/gelöscht, damit die zuletzt
 * gewählte Ansicht erhalten bleibt.
 */

import { usePathname, useRouter } from "next/navigation";
import {
  PERSPEKTIVE_AUFGABEN,
  PERSPEKTIVE_COOKIE,
  PERSPEKTIVE_MAX_AGE,
} from "@/lib/perspektive/constants";

/** Secure in Prod (https), lokal via http weglassen (Muster demo/perspektive-client). */
function secureFlag(): string {
  return typeof window !== "undefined" && window.location.protocol === "https:"
    ? "; Secure"
    : "";
}

function setzeAufgaben(): void {
  document.cookie =
    `${PERSPEKTIVE_COOKIE}=${PERSPEKTIVE_AUFGABEN}; Path=/; ` +
    `Max-Age=${PERSPEKTIVE_MAX_AGE}; SameSite=Lax${secureFlag()}`;
}

function loeschePerspektive(): void {
  document.cookie = `${PERSPEKTIVE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secureFlag()}`;
}

const segmentBase =
  "rounded-full px-3 py-1 text-xs font-semibold transition-colors focus:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-1";

export function PerspektivUmschalter({ slug }: { slug: string }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const p = pathname.replace(new RegExp(`^/${slug}`), "") || "/";
  const aufgabenAktiv = p.startsWith("/aufgaben");

  function zuBuerger() {
    loeschePerspektive();
    router.push(`/${slug}/umfragen`);
  }

  function zuAufgaben() {
    setzeAufgaben();
    router.push(`/${slug}/aufgaben`);
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
          className="inline-flex items-center gap-0.5 rounded-full bg-[color:var(--pz-brand-soft)] p-0.5"
          role="group"
          aria-label="Ansicht wechseln"
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
