/**
 * VerifyConfirm.tsx — Bestätigungs-Button der Magic-Link-Seite
 *
 * Erst der Klick auf „Jetzt anmelden" (bewusste Nutzeraktion) sendet
 * POST /api/auth/verify und löst den Token dort atomar ein. Die Seite
 * selbst (GET) verbraucht nichts — siehe page.tsx.
 *
 * nextPath kommt bereits serverseitig validiert aus safeRedirectPath
 * (nur same-origin-relative Pfade) und bleibt der FALLBACK. Primär gilt seit
 * WP2 das `redirectTo` aus der POST-Antwort: der Server entscheidet das Ziel
 * (Auto-Perspektive für Rollenträger, explizites next schlägt sie). nextParam
 * ist der ROHE ?next=-Wert (oder null) und wird nur an den Server durchgereicht
 * — validiert wird ausschließlich serverseitig (safeRedirectPath).
 */

"use client";

import { useState } from "react";
import Link from "next/link";

type ConfirmState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; code: string; message: string };

const FEHLER_TITEL: Record<string, string> = {
  TOKEN_EXPIRED: "Link abgelaufen",
  TOKEN_USED: "Link bereits verwendet",
  TOKEN_INVALID: "Link ungültig",
  FORBIDDEN: "Anmeldung nicht möglich",
};

/**
 * Minimale CLIENTSEITIGE Plausibilitätsprüfung des Server-`redirectTo` (Defense-
 * in-Depth — die echte Validierung ist serverseitig safeRedirectPath): string,
 * beginnt mit GENAU einem "/" (kein protokoll-relatives "//host").
 */
function istPlausiblesRedirect(wert: unknown): wert is string {
  return (
    typeof wert === "string" && wert.startsWith("/") && !wert.startsWith("//")
  );
}

export default function VerifyConfirm({
  token,
  nextPath,
  nextParam,
  anmeldenHref,
}: {
  token: string;
  nextPath: string;
  /** Roher ?next=-Parameter der URL (null wenn keiner da war) — geht an den Server. */
  nextParam: string | null;
  anmeldenHref: string;
}) {
  const [state, setState] = useState<ConfirmState>({ status: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status === "submitting" || state.status === "success") return;
    setState({ status: "submitting" });

    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, next: nextParam }),
      });

      if (res.ok) {
        setState({ status: "success" });
        // Voller Dokument-Load zum Ziel: nur so liest das Server-Layout den
        // frischen Session-Cookie und rendert die Nav neu. Ein Client-
        // router.push auf eine Schwester-Route unter demselben [tenant]-Layout
        // ließ die „Anmelden"-Nav stale (Vor-Ort-Befund B).
        // WP2: primär das serverseitig entschiedene redirectTo (safeRedirect-
        // validiert, Auto-Perspektive); fehlt/unplausibel → Fallback nextPath
        // (serverseitig via safeRedirectPath validiert wie bisher).
        const data = (await res.json().catch(() => null)) as
          | { redirectTo?: unknown }
          | null;
        const redirectTo = data?.redirectTo;
        const ziel = istPlausiblesRedirect(redirectTo) ? redirectTo : nextPath;
        window.location.assign(ziel);
      } else {
        const data = (await res.json()) as {
          error?: { code?: string; message?: string };
        };
        setState({
          status: "error",
          code: data?.error?.code ?? "UNKNOWN",
          message:
            data?.error?.message ?? "Ein unbekannter Fehler ist aufgetreten.",
        });
      }
    } catch {
      setState({
        status: "error",
        code: "NETWORK_ERROR",
        message: "Verbindungsfehler. Bitte versuchen Sie es erneut.",
      });
    }
  }

  if (state.status === "error") {
    // z. B. wenn der Token zwischen Seitenaufruf und Klick auf einem anderen
    // Gerät eingelöst wurde oder inzwischen abgelaufen ist.
    const nochmalVersuchbar = state.code === "NETWORK_ERROR";
    return (
      <div aria-live="polite" className="mt-4">
        <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          {FEHLER_TITEL[state.code] ?? "Fehler bei der Anmeldung"}
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
          {state.message}
        </p>
        {nochmalVersuchbar ? (
          <button
            type="button"
            onClick={() => setState({ status: "idle" })}
            className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
            style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
          >
            Erneut versuchen
          </button>
        ) : (
          <Link
            href={anmeldenHref}
            className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
            style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
          >
            Neuen Link anfordern
          </Link>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4">
      <button
        type="submit"
        disabled={state.status !== "idle"}
        className="inline-block rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
      >
        {state.status === "idle" ? "Jetzt anmelden" : "Einen Moment …"}
      </button>
      <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        Aus Sicherheitsgründen ist ein letzter Klick nötig — so kann kein
        automatischer E-Mail-Scanner Ihren Anmeldelink versehentlich verbrauchen.
      </p>
      <p aria-live="polite" className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        {state.status === "submitting" && "Ihre Anmeldung wird geprüft …"}
        {state.status === "success" && "Anmeldung erfolgreich — Sie werden weitergeleitet …"}
      </p>
    </form>
  );
}
