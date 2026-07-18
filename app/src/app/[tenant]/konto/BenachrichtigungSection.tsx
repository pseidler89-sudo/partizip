/**
 * BenachrichtigungSection.tsx — Client-Komponente „Benachrichtigungen" (Opt-outs).
 *
 * Block J2c: aus einem Umschalter werden drei (je eigene Server-Action,
 * optimistisch, role="switch"):
 *   - „E-Mail bei neuen Abstimmungen" (notifyNewPolls, immer sichtbar),
 *   - „E-Mail bei Statusänderung meiner gefolgten Anliegen" (notifyAnliegenUpdates,
 *     nur wenn das Anliegen-Modul aktiv ist — sonst wäre der Schalter irreführend),
 *   - „Erinnerung, wenn meine Wohnsitz-Verifizierung ausläuft" (notifyReverify).
 * Jeder Schalter wirkt WIRKSAM als Versandfilter (Teil A3), nicht nur als Anzeige.
 *
 * Tonalität „Sie"; Design-Profil (pz-card, Fokus-Ringe).
 */

"use client";

import { useState } from "react";
import {
  setNeuePollBenachrichtigung,
  setAnliegenBenachrichtigung,
  setReverifyBenachrichtigung,
} from "@/lib/konto/notify-actions";
import { FEATURE_ANLIEGEN_EINREICHEN } from "@/lib/features";

type ToggleAction = (aktiv: boolean) => Promise<{ ok: boolean; error?: string }>;

function ToggleRow({
  titel,
  beschreibung,
  initial,
  action,
  bestaetigungAn,
  bestaetigungAus,
}: {
  titel: string;
  beschreibung: string;
  initial: boolean;
  action: ToggleAction;
  bestaetigungAn: string;
  bestaetigungAus: string;
}) {
  const [aktiv, setAktiv] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bestaetigt, setBestaetigt] = useState(false);

  async function handleToggle() {
    const next = !aktiv;
    // Optimistisch umschalten; bei Fehler zurücksetzen.
    setAktiv(next);
    setSubmitting(true);
    setError(null);
    setBestaetigt(false);
    try {
      const result = await action(next);
      if (!result.ok) {
        setAktiv(!next);
        setError(result.error ?? "Einstellung konnte nicht gespeichert werden.");
        return;
      }
      setBestaetigt(true);
    } catch {
      setAktiv(!next);
      setError("Verbindungsfehler.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
            {titel}
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            {beschreibung}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={aktiv}
          aria-label={titel}
          onClick={handleToggle}
          disabled={submitting}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full
                      transition-colors focus-visible:outline-none focus-visible:ring-2
                      focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2
                      disabled:opacity-50 ${aktiv ? "bg-[color:var(--pz-brand)]" : "bg-pz-line"}`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-pz-surface shadow transition-transform
                        ${aktiv ? "translate-x-5" : "translate-x-0.5"}`}
          />
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {bestaetigt && !error && (
        <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
          {aktiv ? bestaetigungAn : bestaetigungAus}
        </p>
      )}
    </div>
  );
}

export function BenachrichtigungSection({
  initialNewPolls,
  initialAnliegenUpdates,
  initialReverify,
}: {
  initialNewPolls: boolean;
  initialAnliegenUpdates: boolean;
  initialReverify: boolean;
}) {
  return (
    // id = Anker-Ziel der Einrichtungs-Checkliste („Benachrichtigungen einschalten");
    // scroll-mt hält die Überschrift beim Sprung sichtbar unter dem Seitenrand.
    <section id="benachrichtigungen" className="mb-6 scroll-mt-6">
      <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--pz-ink)" }}>
        Benachrichtigungen
      </h2>
      <div className="pz-card p-4 divide-y divide-pz-line">
        <div className="pb-4">
          <ToggleRow
            titel="E-Mail bei neuen Abstimmungen in meinem Gebiet"
            beschreibung="Wir benachrichtigen Sie, sobald in Ihrer Kommune eine neue Abstimmung startet. Sie können dies jederzeit hier ein- oder ausschalten."
            initial={initialNewPolls}
            action={setNeuePollBenachrichtigung}
            bestaetigungAn="Gespeichert — Sie erhalten künftig E-Mails zu neuen Abstimmungen."
            bestaetigungAus="Gespeichert — Sie erhalten keine E-Mails mehr zu neuen Abstimmungen."
          />
        </div>

        {/* Anliegen-Status-Mails: nur zeigen, wenn das Anliegen-Modul aktiv ist —
            sonst wäre ein Schalter ohne Wirkung irreführend (Spec A1). */}
        {FEATURE_ANLIEGEN_EINREICHEN && (
          <div className="py-4">
            <ToggleRow
              titel="E-Mail bei Statusänderung meiner gefolgten Anliegen"
              beschreibung="Sobald sich der Status eines Anliegens ändert, dem Sie folgen, informieren wir Sie per E-Mail."
              initial={initialAnliegenUpdates}
              action={setAnliegenBenachrichtigung}
              bestaetigungAn="Gespeichert — Sie erhalten künftig Status-E-Mails zu Ihren Anliegen."
              bestaetigungAus="Gespeichert — Sie erhalten keine Status-E-Mails mehr zu Ihren Anliegen."
            />
          </div>
        )}

        <div className="pt-4">
          <ToggleRow
            titel="Erinnerung, wenn meine Wohnsitz-Verifizierung ausläuft"
            beschreibung="Rechtzeitig vor Ablauf Ihrer Stufe-2-Verifizierung erinnern wir Sie, damit Sie sie erneuern und weiter verbindlich mitstimmen können."
            initial={initialReverify}
            action={setReverifyBenachrichtigung}
            bestaetigungAn="Gespeichert — Sie werden vor Ablauf Ihrer Verifizierung erinnert."
            bestaetigungAus="Gespeichert — wir erinnern Sie nicht mehr vor Ablauf Ihrer Verifizierung."
          />
        </div>
      </div>
    </section>
  );
}
