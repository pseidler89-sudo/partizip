/**
 * EinladungAnnehmen.tsx — Bestätigungs-Button der Einladungs-Seite.
 *
 * Erst der Klick auf „Einladung annehmen" (bewusste Nutzeraktion) ruft die
 * Server Action `einladungAnnehmen` und löst den Token dort ATOMAR ein (der
 * Seiten-GET verbraucht nichts — siehe page.tsx). Nach Erfolg wird ins Konto
 * weitergeleitet.
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { einladungAnnehmen } from "@/lib/admin/invitation-actions";

type State =
  | { status: "idle" }
  | { status: "success" }
  /** K3: Verifier-Einladung angenommen — Rolle bedarf noch der Bestätigung. */
  | { status: "pendingApproval" }
  | { status: "error"; message: string };

export default function EinladungAnnehmen({
  token,
  tenantSlug,
}: {
  token: string;
  tenantSlug: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<State>({ status: "idle" });

  function handleAccept() {
    if (state.status === "success" || state.status === "pendingApproval") return;
    setState({ status: "idle" });
    startTransition(async () => {
      const result = await einladungAnnehmen(token);
      if (result.ok) {
        // K3: Verifier-Einladung → Ernennungs-Vorschlag statt sofortiger Rolle.
        // KEIN Auto-Redirect — die Person soll die Erklärung lesen können.
        if (result.pendingApproval) {
          setState({ status: "pendingApproval" });
          router.refresh();
          return;
        }
        setState({ status: "success" });
        router.refresh();
        router.push(`/${tenantSlug}/konto`);
      } else {
        setState({
          status: "error",
          message: result.error ?? "Die Einladung konnte nicht angenommen werden.",
        });
      }
    });
  }

  if (state.status === "pendingApproval") {
    return (
      <div aria-live="polite" className="mt-4">
        <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Einladung angenommen
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
          Die Rolle Verifizierer:in wird zweistufig vergeben (Vier-Augen-Prinzip):
          Ihre Ernennung ist als Vorschlag hinterlegt und bedarf noch der
          Bestätigung durch eine zweite Person in der Verwaltung. Sie werden
          freigeschaltet, sobald die Bestätigung erfolgt ist — Sie müssen nichts
          weiter tun.
        </p>
        <Link
          href={`/${tenantSlug}/konto`}
          className="mt-3 inline-block text-sm font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Zu Ihrem Konto
        </Link>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div aria-live="polite" className="mt-4">
        <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Annahme nicht möglich
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
          {state.message}
        </p>
        <Link
          href={`/${tenantSlug}`}
          className="mt-3 inline-block text-sm font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Zur Startseite
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={handleAccept}
        disabled={isPending || state.status === "success"}
        className="inline-block rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
      >
        {state.status === "success"
          ? "Angenommen — weiter …"
          : isPending
            ? "Einen Moment …"
            : "Einladung annehmen"}
      </button>
      <p aria-live="polite" className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        {isPending && "Ihre Einladung wird angenommen …"}
        {state.status === "success" && "Erfolgreich — Sie werden weitergeleitet …"}
      </p>
    </div>
  );
}
