"use client";

/**
 * DemoVerwaltungStart — Start-Button der Verwaltungs-Perspektive.
 *
 * Ruft die Server Action demoVerwaltungStarten() (ephemeres kommune_admin-Konto
 * + Session, NUR auf dem Demo-Mandanten, serverseitig gedeckelt), merkt die
 * Perspektive im UI-Cookie (perspektive-client.ts — kein Recht hängt daran)
 * und springt in die Abstimmungs-Verwaltung, den ersten Schritt des Tracks.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { demoVerwaltungStarten } from "@/lib/demo/actions";
import { setzePerspektiveVerwaltung } from "@/lib/demo/perspektive-client";

export function DemoVerwaltungStart({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setError(null);
    setBusy(true);
    try {
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

  return (
    <div>
      <button
        type="button"
        onClick={handleStart}
        disabled={busy}
        className="inline-flex min-h-[48px] items-center rounded-lg px-6 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        style={{ backgroundColor: "var(--pz-brand)" }}
      >
        {busy ? "Wird gestartet …" : "Verwaltungs-Perspektive starten"}
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
