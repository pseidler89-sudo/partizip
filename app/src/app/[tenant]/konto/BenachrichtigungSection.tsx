/**
 * BenachrichtigungSection.tsx — Client-Komponente „E-Mail bei neuen Abstimmungen"
 * (Benachrichtigungs-Motor, Opt-out im Konto).
 *
 * Ein einzelner Umschalter (Default an). Beim Umschalten wird die Server-Action
 * setNeuePollBenachrichtigung aufgerufen; bei Erfolg erscheint eine dezente
 * Bestätigung. Schlägt die Action fehl, wird der Schalter visuell zurückgesetzt.
 *
 * Tonalität „Sie"; Design-Profil (pz-card, Fokus-Ringe).
 */

"use client";

import { useState } from "react";
import { setNeuePollBenachrichtigung } from "@/lib/konto/notify-actions";

export function BenachrichtigungSection({ initial }: { initial: boolean }) {
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
      const result = await setNeuePollBenachrichtigung(next);
      if (!result.ok) {
        setAktiv(!next); // zurücksetzen
        setError(result.error ?? "Einstellung konnte nicht gespeichert werden.");
        return;
      }
      setBestaetigt(true);
    } catch {
      setAktiv(!next); // zurücksetzen
      setError("Verbindungsfehler.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // id = Anker-Ziel der Einrichtungs-Checkliste („Benachrichtigungen einschalten");
    // scroll-mt hält die Überschrift beim Sprung sichtbar unter dem Seitenrand.
    <section id="benachrichtigungen" className="mb-6 scroll-mt-6">
      <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--pz-ink)" }}>
        Benachrichtigungen
      </h2>
      <div className="pz-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
              E-Mail bei neuen Abstimmungen in meinem Gebiet
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
              Wir benachrichtigen Sie, sobald in Ihrer Kommune eine neue Abstimmung
              startet. Sie können dies jederzeit hier ein- oder ausschalten.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={aktiv}
            aria-label="E-Mail bei neuen Abstimmungen in meinem Gebiet"
            onClick={handleToggle}
            disabled={submitting}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full
                        transition-colors focus-visible:outline-none focus-visible:ring-2
                        focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2
                        disabled:opacity-50 ${aktiv ? "bg-[color:var(--pz-brand)]" : "bg-zinc-300"}`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform
                          ${aktiv ? "translate-x-5" : "translate-x-0.5"}`}
            />
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        {bestaetigt && !error && (
          <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            {aktiv
              ? "Gespeichert — Sie erhalten künftig E-Mails zu neuen Abstimmungen."
              : "Gespeichert — Sie erhalten keine E-Mails mehr zu neuen Abstimmungen."}
          </p>
        )}
      </div>
    </section>
  );
}
