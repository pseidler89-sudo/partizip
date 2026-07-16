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
 *
 * Block E: Aktivieren (feuert Benachrichtigungen an alle Opt-in-Nutzer im Gebiet)
 * und Schließen (irreversibel — eine geschlossene Abstimmung öffnet nicht wieder)
 * verlangen jetzt eine bewusste Bestätigung; Entwurf-Löschen ebenso.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  pollAktivieren,
  pollSchliessen,
  pollEntwurfLoeschen,
} from "@/lib/polls/actions";
import BestaetigungsDialog from "../../BestaetigungsDialog";

type Status = "entwurf" | "aktiv" | "geschlossen";
type Op = "aktivieren" | "schliessen" | "loeschen";

interface Props {
  pollId: string;
  status: Status;
}

const DIALOG: Record<
  Op,
  { titel: string; beschreibung: string; label: string; variante: "gefahr" | "normal" }
> = {
  aktivieren: {
    titel: "Abstimmung aktivieren?",
    beschreibung:
      "Die Abstimmung wird sofort sichtbar und alle Nutzer:innen im Gebiet, die Benachrichtigungen aktiviert haben, erhalten eine E-Mail. Das lässt sich nicht zurücknehmen.",
    label: "Ja, aktivieren",
    variante: "normal",
  },
  schliessen: {
    titel: "Abstimmung schließen?",
    beschreibung:
      "Nach dem Schließen kann niemand mehr abstimmen und das Ergebnis wird endgültig ausgezählt. Eine geschlossene Abstimmung lässt sich nicht wieder öffnen.",
    label: "Ja, schließen",
    variante: "gefahr",
  },
  loeschen: {
    titel: "Entwurf löschen?",
    beschreibung:
      "Der Entwurf wird dauerhaft gelöscht. Das lässt sich nicht rückgängig machen.",
    label: "Ja, löschen",
    variante: "gefahr",
  },
};

export default function PollAdminActions({ pollId, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | Op>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Op | null>(null);

  const AKTIONEN: Record<Op, () => Promise<{ ok: boolean; error?: string }>> = {
    aktivieren: () => pollAktivieren(pollId),
    schliessen: () => pollSchliessen(pollId),
    loeschen: () => pollEntwurfLoeschen(pollId),
  };

  async function run(op: Op) {
    setError(null);
    setBusy(op);
    try {
      const result = await AKTIONEN[op]();
      if (!result.ok) {
        setError(result.error ?? "Die Aktion ist fehlgeschlagen.");
        return;
      }
      setConfirm(null);
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusy(null);
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
              onClick={() => setConfirm("aktivieren")}
              className={`${btnBase} text-white hover:opacity-90`}
              style={{ backgroundColor: "var(--tenant-primary)" }}
            >
              Aktivieren
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirm("loeschen")}
              className={`${btnBase} border border-red-200 bg-white text-red-700 hover:bg-red-50`}
            >
              Entwurf löschen
            </button>
          </>
        )}

        {status === "aktiv" && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirm("schliessen")}
            className={`${btnBase} border bg-white`}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          >
            Schließen
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      <BestaetigungsDialog
        offen={confirm !== null}
        titel={confirm ? DIALOG[confirm].titel : ""}
        beschreibung={confirm ? DIALOG[confirm].beschreibung : undefined}
        bestaetigenLabel={confirm ? DIALOG[confirm].label : ""}
        variante={confirm ? DIALOG[confirm].variante : "gefahr"}
        busy={busy !== null}
        onBestaetigen={() => confirm && run(confirm)}
        onAbbrechen={() => busy === null && setConfirm(null)}
      />
    </div>
  );
}
