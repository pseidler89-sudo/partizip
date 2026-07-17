/**
 * [tenant]/error.tsx — Freundliche Fehlerseite (M11).
 *
 * Fängt Laufzeitfehler in Tenant-Routen ab, statt die rohe Fehlerseite zu zeigen.
 * Keine technischen Details für Bürger:innen; Fehler wird nur in der Konsole geloggt.
 */

"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function TenantError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Nur loggen — keine PII/Details an die Nutzeroberfläche.
    console.error("[tenant error]", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <div className="text-4xl" aria-hidden>⚠️</div>
      <h1 className="mt-3 text-xl font-semibold text-pz-ink">Etwas ist schiefgelaufen</h1>
      <p className="mt-2 text-sm text-pz-muted">
        Beim Laden dieser Seite ist ein Fehler aufgetreten. Das liegt nicht an Ihnen.
        Bitte versuchen Sie es noch einmal — wenn es weiterhin nicht klappt, schauen Sie
        später erneut vorbei.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={() => reset()}
          className="rounded-md px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
        >
          Erneut versuchen
        </button>
        <Link
          href="/"
          className="pz-btn pz-btn-secondary"
        >
          Zur Startseite
        </Link>
      </div>
    </main>
  );
}
