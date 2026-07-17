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
  /** Demo-Mandant: ehrlicher Aktivieren-Text (keine echten Benachrichtigungen). */
  demo?: boolean;
  /**
   * Kuratierte Musterstadt-Seed-Frage: KEINE Aktions-Buttons rendern — sie
   * würden nur am Seed-Guard scheitern (Gate-B MINOR-5). Die Karte kennzeichnet
   * die Frage stattdessen als „Beispiel".
   */
  istBeispiel?: boolean;
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

/**
 * Aktivieren verspricht E-Mails an Opt-in-Nutzer:innen — auf dem Demo-Mandanten
 * wird notifyNewPoll aber gefenced (keine Außenwirkung). Ehrlicher Text statt
 * eines uneingelösten Versprechens (Gate-B MINOR-1).
 */
const DEMO_AKTIVIEREN_BESCHREIBUNG =
  "Die Abstimmung wird sofort sichtbar. In der Demo werden keine echten " +
  "Benachrichtigungen versendet. Das lässt sich nicht zurücknehmen.";

export default function PollAdminActions({ pollId, status, demo, istBeispiel }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | Op>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Op | null>(null);

  // Seed-Beispiel-Fragen: keine zustandsändernden Aktionen (Seed-Guard würde
  // jede ablehnen) — die Karte kennzeichnet sie serverseitig als „Beispiel".
  if (istBeispiel) return null;

  // Beschreibung des Bestätigungsdialogs; auf Demo für „aktivieren" ehrlich.
  function beschreibungFuer(op: Op): string {
    if (op === "aktivieren" && demo) return DEMO_AKTIVIEREN_BESCHREIBUNG;
    return DIALOG[op].beschreibung;
  }

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
        beschreibung={confirm ? beschreibungFuer(confirm) : undefined}
        bestaetigenLabel={confirm ? DIALOG[confirm].label : ""}
        variante={confirm ? DIALOG[confirm].variante : "gefahr"}
        busy={busy !== null}
        onBestaetigen={() => confirm && run(confirm)}
        onAbbrechen={() => busy === null && setConfirm(null)}
      />
    </div>
  );
}
