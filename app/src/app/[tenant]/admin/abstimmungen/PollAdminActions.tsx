/**
 * PollAdminActions.tsx — Client-Buttons für den Umfrage-Lebenszyklus (M5).
 *
 * Je nach Status werden die passenden Aktionen angeboten:
 *   - Entwurf     → [Aktivieren] [Entwurf löschen]
 *   - Aktiv       → [Schließen]
 *   - Geschlossen → (keine zustandsändernden Aktionen)
 *
 * Alle Aktionen rufen die admin-gated Server-Actions; serverseitig wird die
 * Berechtigung + der Status-Guard (atomar) erneut erzwungen — die Buttons sind
 * nur Komfort. Fehler werden inline gezeigt, Erfolg löst router.refresh() aus.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  pollAktivieren,
  pollSchliessen,
  pollEntwurfLoeschen,
} from "@/lib/polls/actions";

type Status = "entwurf" | "aktiv" | "geschlossen";

interface Props {
  pollId: string;
  status: Status;
}

export default function PollAdminActions({ pollId, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "aktivieren" | "schliessen" | "loeschen">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(
    op: "aktivieren" | "schliessen" | "loeschen",
    fn: () => Promise<{ ok: boolean; error?: string }>
  ) {
    setError(null);
    setBusy(op);
    try {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Die Aktion ist fehlgeschlagen.");
        return;
      }
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  const btnBase =
    "inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {status === "entwurf" && (
          <>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("aktivieren", () => pollAktivieren(pollId))}
              className={`${btnBase} text-white hover:opacity-90`}
              style={{ backgroundColor: "var(--tenant-primary)" }}
            >
              {busy === "aktivieren" ? "…" : "Aktivieren"}
            </button>

            {!confirmDelete ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmDelete(true)}
                className={`${btnBase} border border-red-200 bg-white text-red-700 hover:bg-red-50`}
              >
                Entwurf löschen
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs" style={{ color: "var(--pz-muted)" }}>
                  Wirklich löschen?
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => run("loeschen", () => pollEntwurfLoeschen(pollId))}
                  className={`${btnBase} border border-red-300 bg-red-600 text-white hover:bg-red-700`}
                >
                  {busy === "loeschen" ? "…" : "Ja, löschen"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setConfirmDelete(false)}
                  className={`${btnBase} border bg-white`}
                  style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                >
                  Abbrechen
                </button>
              </span>
            )}
          </>
        )}

        {status === "aktiv" && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run("schliessen", () => pollSchliessen(pollId))}
            className={`${btnBase} border bg-white`}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          >
            {busy === "schliessen" ? "…" : "Schließen"}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-red-700">{error}</p>
      )}
    </div>
  );
}
