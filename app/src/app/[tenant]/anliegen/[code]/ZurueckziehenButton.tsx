/**
 * ZurueckziehenButton.tsx — Client-Komponente für das Zurückziehen eines
 * eigenen Anliegens (M3).
 *
 * Wird nur gerendert, wenn der eingeloggte Betrachter der Ersteller ist UND
 * der Status zurückziehbar ist (Server-seitig geprüft in page.tsx). Die
 * Server-Action prüft die Berechtigung ebenfalls erneut (Defense in Depth).
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { zurueckziehenAnliegen } from "@/lib/anliegen/actions";

interface Props {
  anliegenId: string;
}

export function ZurueckziehenButton({ anliegenId }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleWithdraw() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await zurueckziehenAnliegen(anliegenId);
      if (!result.ok) {
        setError(result.error ?? "Zurückziehen fehlgeschlagen.");
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Verbindungsfehler.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!confirming) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-sm text-pz-muted underline underline-offset-4 hover:text-[color:var(--pz-danger)]"
        >
          Anliegen zurückziehen
        </button>
        <p className="text-xs text-pz-muted mt-1">
          Sie können Ihr Anliegen zurückziehen, solange es noch in Bearbeitung ist.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4">
      <p className="text-sm text-pz-body">
        Möchten Sie dieses Anliegen wirklich zurückziehen? Das lässt sich nicht rückgängig machen.
      </p>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      <div className="flex gap-2 mt-3">
        <button
          type="button"
          onClick={handleWithdraw}
          disabled={submitting}
          className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {submitting ? "Wird zurückgezogen…" : "Ja, zurückziehen"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={submitting}
          className="pz-btn pz-btn-secondary pz-btn-sm"
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}
