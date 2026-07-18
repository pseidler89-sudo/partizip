/**
 * PollAdminActions.tsx — Client-Buttons für den Umfrage-Lebenszyklus (M5 + Block L).
 *
 * Je nach Status werden die passenden Aktionen angeboten:
 *   - Entwurf     → [Aktivieren] [Entwurf löschen]
 *                   (bei aktivem KI-Check: [Zur Prüfung einreichen] statt Aktivieren)
 *   - In Prüfung  → Prüf-Panel: Begründung + verletzte Regel + [Freigeben] / [Anhalten]
 *   - Aktiv       → [Schließen]
 *   - Geschlossen → (keine zustandsändernden Aktionen)
 *
 * Alle Aktionen rufen die admin-gated Server-Actions; serverseitig wird die
 * Berechtigung + der Status-Guard (atomar) + SoD (bei Freigabe) erneut erzwungen —
 * die Buttons sind nur Komfort. Fehler werden inline gezeigt, Erfolg löst
 * router.refresh() aus.
 *
 * Block L (ADR-028): Ist der KI-Neutralitäts-Check für den Tenant AN, geht eine
 * eingereichte Umfrage in den Zustand „in Prüfung"; ein Betreiber bewertet sie
 * anhand des öffentlichen Prompts und gibt sie frei oder hält sie an.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  pollAktivieren,
  pollSchliessen,
  pollEntwurfLoeschen,
  pollPruefungAbschliessen,
} from "@/lib/polls/actions";
import BestaetigungsDialog from "../../BestaetigungsDialog";

type Status = "entwurf" | "aktiv" | "geschlossen" | "in_pruefung";
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
  /**
   * Block L: KI-Neutralitäts-Check für den Tenant AN → „Zur Prüfung einreichen"
   * statt „Aktivieren"; im Status „in Prüfung" erscheint das Prüf-Panel.
   */
  kiPflicht?: boolean;
  /** Link zur öffentlichen Prompt-/Transparenz-Seite (Prüf-Panel-Hinweis). */
  pruefLink?: string;
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

/**
 * Bei aktivem KI-Check geht die Umfrage NICHT direkt live, sondern in die Prüfung.
 * Der Aktivieren-Button + Dialog werden entsprechend ehrlich umbenannt.
 */
const PRUEFUNG_EINREICHEN_DIALOG = {
  titel: "Zur Neutralitätsprüfung einreichen?",
  beschreibung:
    "Für diese Kommune ist der Neutralitäts-Check aktiv. Die Umfrage geht nicht sofort live, sondern zuerst in die Prüfung. Erst nach der Freigabe wird sie sichtbar und benachrichtigt.",
  label: "Ja, einreichen",
} as const;

export default function PollAdminActions({
  pollId,
  status,
  demo,
  istBeispiel,
  kiPflicht,
  pruefLink,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | Op | "pruefung">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Op | null>(null);

  // Prüf-Panel-Zustand (nur im Status in_pruefung genutzt).
  const [begruendung, setBegruendung] = useState("");
  const [verletzteRegel, setVerletzteRegel] = useState("");
  const [istOverride, setIstOverride] = useState(false);
  const [pruefConfirm, setPruefConfirm] = useState<null | "neutral" | "angehalten">(null);

  // Seed-Beispiel-Fragen: keine zustandsändernden Aktionen (Seed-Guard würde
  // jede ablehnen) — die Karte kennzeichnet sie serverseitig als „Beispiel".
  if (istBeispiel) return null;

  // Beschreibung des Bestätigungsdialogs; auf Demo für „aktivieren" ehrlich, bei
  // aktivem KI-Check „zur Prüfung einreichen".
  function beschreibungFuer(op: Op): string {
    if (op === "aktivieren") {
      if (kiPflicht) return PRUEFUNG_EINREICHEN_DIALOG.beschreibung;
      if (demo) return DEMO_AKTIVIEREN_BESCHREIBUNG;
    }
    return DIALOG[op].beschreibung;
  }
  function titelFuer(op: Op): string {
    if (op === "aktivieren" && kiPflicht) return PRUEFUNG_EINREICHEN_DIALOG.titel;
    return DIALOG[op].titel;
  }
  function labelFuer(op: Op): string {
    if (op === "aktivieren" && kiPflicht) return PRUEFUNG_EINREICHEN_DIALOG.label;
    return DIALOG[op].label;
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

  async function runPruefung(verdict: "neutral" | "angehalten") {
    setError(null);
    // Client-Vorprüfung (Server validiert erneut): Begründung Pflicht; verletzte
    // Regel Pflicht beim Anhalten.
    if (begruendung.trim().length === 0) {
      setError("Bitte geben Sie eine kurze Begründung an.");
      return;
    }
    if (verdict === "angehalten" && verletzteRegel.trim().length === 0) {
      setError("Bitte benennen Sie die verletzte Regel.");
      return;
    }
    setBusy("pruefung");
    try {
      const result = await pollPruefungAbschliessen({
        pollId,
        verdict,
        begruendung: begruendung.trim(),
        verletzteRegel: verletzteRegel.trim() || null,
        istOverride,
      });
      if (!result.ok) {
        setError(result.error ?? "Die Prüfung ist fehlgeschlagen.");
        return;
      }
      setPruefConfirm(null);
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusy(null);
    }
  }

  // --- Status „in Prüfung": Prüf-Panel ---------------------------------------
  if (status === "in_pruefung") {
    return (
      <div className="w-full">
        <div
          className="rounded-lg border p-4"
          style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-surface)" }}
        >
          <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
            Neutralitätsprüfung
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            Bewerten Sie diese Frage anhand des{" "}
            {pruefLink ? (
              <Link href={pruefLink} className="underline" style={{ color: "var(--pz-brand-strong)" }}>
                öffentlichen Prüf-Prompts
              </Link>
            ) : (
              "öffentlichen Prüf-Prompts"
            )}
            . Bei &bdquo;Anhalten&ldquo; geht die Frage mit Ihrer Begründung zurück an
            die erstellende Person.
          </p>

          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor={`begr-${pollId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                Begründung (max. 2 Sätze)
              </label>
              <textarea
                id={`begr-${pollId}`}
                value={begruendung}
                onChange={(e) => setBegruendung(e.target.value)}
                maxLength={400}
                rows={2}
                aria-describedby={`begr-hint-${pollId}`}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-bg)", color: "var(--pz-ink)" }}
              />
              <p id={`begr-hint-${pollId}`} className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
                Die Begründung erscheint öffentlich im Transparenz-Log (ohne Ihren
                Namen). Bitte zitieren Sie darin <strong>keine Klarnamen oder
                personenbezogenen Daten</strong> — der Text wird veröffentlicht.
              </p>
            </div>

            <div>
              <label htmlFor={`regel-${pollId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                Verletzte Regel (nur beim Anhalten erforderlich)
              </label>
              <input
                id={`regel-${pollId}`}
                type="text"
                value={verletzteRegel}
                onChange={(e) => setVerletzteRegel(e.target.value)}
                maxLength={160}
                placeholder="z. B. Regel 1 (Suggestivität)"
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-bg)", color: "var(--pz-ink)" }}
              />
            </div>

            <label className="flex items-center gap-2 text-xs" style={{ color: "var(--pz-body)" }}>
              <input
                type="checkbox"
                checked={istOverride}
                onChange={(e) => setIstOverride(e.target.checked)}
              />
              Menschlicher Override (bei wiederholter Einreichung — wird protokolliert)
            </label>
          </div>

          {error && <p className="mt-2 text-sm" style={{ color: "var(--pz-danger)" }}>{error}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => { setError(null); setPruefConfirm("neutral"); }}
              className="pz-btn pz-btn-sm pz-btn-primary"
            >
              Freigeben
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => { setError(null); setPruefConfirm("angehalten"); }}
              className="pz-btn pz-btn-sm pz-btn-secondary"
              style={{ color: "var(--pz-danger)" }}
            >
              Anhalten &amp; zurück an Ersteller
            </button>
          </div>
        </div>

        <BestaetigungsDialog
          offen={pruefConfirm !== null}
          titel={
            pruefConfirm === "neutral"
              ? "Umfrage freigeben?"
              : "Umfrage anhalten?"
          }
          beschreibung={
            pruefConfirm === "neutral"
              ? "Die Umfrage wird als neutral bewertet, geht live und benachrichtigt die Nutzer:innen im Gebiet. Da sie damit ohnehin öffentlich ist, erscheint im Transparenz-Log der Frage-Wortlaut samt Begründung."
              : "Die Umfrage geht mit Ihrer Begründung zurück an die erstellende Person und kann angepasst erneut eingereicht werden. Im öffentlichen Transparenz-Log erscheint die Frage selbst NICHT — nur Ergebnis, verletzte Regel und Ihre Begründung."
          }
          bestaetigenLabel={pruefConfirm === "neutral" ? "Ja, freigeben" : "Ja, anhalten"}
          variante={pruefConfirm === "neutral" ? "normal" : "gefahr"}
          busy={busy !== null}
          onBestaetigen={() => pruefConfirm && runPruefung(pruefConfirm)}
          onAbbrechen={() => busy === null && setPruefConfirm(null)}
        />
      </div>
    );
  }

  // --- Übrige Status: Standard-Aktionen --------------------------------------
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {status === "entwurf" && (
          <>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirm("aktivieren")}
              className="pz-btn pz-btn-sm pz-btn-primary"
            >
              {kiPflicht ? "Zur Prüfung einreichen" : "Aktivieren"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirm("loeschen")}
              className="pz-btn pz-btn-sm pz-btn-secondary"
              style={{ color: "var(--pz-danger)" }}
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
            className="pz-btn pz-btn-sm pz-btn-secondary"
          >
            Schließen
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-sm" style={{ color: "var(--pz-danger)" }}>{error}</p>}

      <BestaetigungsDialog
        offen={confirm !== null}
        titel={confirm ? titelFuer(confirm) : ""}
        beschreibung={confirm ? beschreibungFuer(confirm) : undefined}
        bestaetigenLabel={confirm ? labelFuer(confirm) : ""}
        variante={confirm ? DIALOG[confirm].variante : "gefahr"}
        busy={busy !== null}
        onBestaetigen={() => confirm && run(confirm)}
        onAbbrechen={() => busy === null && setConfirm(null)}
      />
    </div>
  );
}
