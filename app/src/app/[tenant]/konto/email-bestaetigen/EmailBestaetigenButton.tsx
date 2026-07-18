/**
 * EmailBestaetigenButton.tsx — Bestätigungs-Button der E-Mail-Änderung (J2b).
 *
 * Erst der Klick (bewusste Nutzeraktion) ruft die Server Action
 * emailAenderungBestaetigen auf, die den Token atomar konsumiert und den
 * Wechsel vollzieht. Die Seite selbst (GET) verbraucht nichts.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { emailAenderungBestaetigen } from "@/lib/konto/email-change-actions";

type State =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; code: string; message: string };

/** Fehler, bei denen ein erneuter Klick sinnlos ist → zurück ins Konto. */
const ENDGUELTIG = new Set(["USED", "EXPIRED", "INVALID", "WRONG_ACCOUNT", "TAKEN"]);

export default function EmailBestaetigenButton({
  token,
  tenantSlug,
}: {
  token: string;
  tenantSlug: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status === "submitting" || state.status === "success") return;
    setState({ status: "submitting" });
    try {
      const res = await emailAenderungBestaetigen(token);
      if (res.ok) {
        setState({ status: "success" });
        router.refresh();
        router.push(`/${tenantSlug}/konto`);
      } else {
        setState({
          status: "error",
          code: res.code ?? "INVALID",
          message: res.error ?? "Die Bestätigung ist fehlgeschlagen.",
        });
      }
    } catch {
      setState({ status: "error", code: "NETWORK_ERROR", message: "Verbindungsfehler. Bitte versuchen Sie es erneut." });
    }
  }

  if (state.status === "error") {
    const endgueltig = ENDGUELTIG.has(state.code);
    return (
      <div aria-live="polite" className="mt-4">
        <p className="text-sm" style={{ color: "var(--pz-body)" }}>
          {state.message}
        </p>
        {endgueltig ? (
          <Link
            href={`/${tenantSlug}/konto`}
            className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
            style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
          >
            Zum Konto
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setState({ status: "idle" })}
            className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
            style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
          >
            Erneut versuchen
          </button>
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
        {state.status === "idle" ? "Neue Adresse jetzt bestätigen" : "Einen Moment …"}
      </button>
      <p aria-live="polite" className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        {state.status === "submitting" && "Ihre Änderung wird geprüft …"}
        {state.status === "success" && "Adresse geändert — Sie werden weitergeleitet …"}
      </p>
    </form>
  );
}
