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
        className="pz-btn pz-btn-primary pz-btn-lg min-h-[48px]"
      >
        {busy ? "Wird gestartet …" : "Verwaltungs-Perspektive starten"}
      </button>
      {error && <p className="mt-2 text-sm" style={{ color: "var(--pz-danger)" }}>{error}</p>}
    </div>
  );
}
