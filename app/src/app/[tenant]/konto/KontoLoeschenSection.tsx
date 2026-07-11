/**
 * KontoLoeschenSection.tsx — Client-Komponente „Konto löschen" (H3 DSGVO).
 *
 * Zweistufiger Ablauf gegen versehentliche Löschung:
 *   1. Abschnitt aufklappen → Irreversibilitäts-Warnung + Erklärung, was bleibt.
 *   2. Bestätigungswort „LÖSCHEN" eintippen → Action aufrufen → Redirect.
 *
 * Die Server-Action prüft Auth, Bestätigung und „letzter Admin" erneut
 * (Defense in Depth). Bei Erfolg leitet der Client auf die Tenant-Startseite.
 */

"use client";

import { useState } from "react";
import { kontoLoeschen } from "@/lib/konto/actions";
import { KONTO_LOESCHEN_BESTAETIGUNG } from "@/lib/konto/constants";

export function KontoLoeschenSection() {
  const [open, setOpen] = useState(false);
  const [bestaetigung, setBestaetigung] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eingabeKorrekt = bestaetigung.trim() === KONTO_LOESCHEN_BESTAETIGUNG;

  async function handleDelete() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await kontoLoeschen(bestaetigung.trim());
      if (!result.ok) {
        setError(result.error ?? "Löschung fehlgeschlagen.");
        setSubmitting(false);
        return;
      }
      // Harter Redirect: Session ist serverseitig beendet, Cookie gelöscht.
      window.location.href = result.redirectTo ?? "/";
    } catch {
      setError("Verbindungsfehler.");
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-10 rounded-lg border border-red-200 bg-red-50/40 p-4">
      <h2 className="text-sm font-semibold text-red-800">Konto löschen</h2>

      {!open ? (
        <div className="mt-2">
          <p className="text-xs text-zinc-600">
            Sie können Ihr Konto dauerhaft löschen. Dieser Schritt ist
            unwiderruflich.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5
                       text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Konto löschen…
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3 text-sm text-zinc-700">
          <p className="font-medium text-red-800">
            Achtung: Diese Löschung ist unwiderruflich.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-600">
            <li>
              Ihre Kontodaten (E-Mail, Wohnort-/Alters-Angaben, Rollen) werden
              dauerhaft anonymisiert bzw. gelöscht. Eine Anmeldung ist danach
              nicht mehr möglich.
            </li>
            <li>
              Ihre bereits eingereichten Anliegen bleiben als pseudonymer
              Vorgang erhalten (öffentlich/administrativ sichtbar sind nur Text
              und Status, niemals Ihre Identität). Möchten Sie ein Anliegen
              beenden, ziehen Sie es bitte vorher zurück.
            </li>
            <li>
              Ein technisches Protokoll (PII-frei, ohne Ihre E-Mail) bleibt aus
              Nachweisgründen erhalten.
            </li>
          </ul>

          <div>
            <label htmlFor="loeschen-bestaetigung" className="block text-xs text-zinc-600">
              Geben Sie zur Bestätigung{" "}
              <span className="font-mono font-semibold">{KONTO_LOESCHEN_BESTAETIGUNG}</span>{" "}
              ein:
            </label>
            <input
              id="loeschen-bestaetigung"
              type="text"
              value={bestaetigung}
              onChange={(e) => setBestaetigung(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5
                         text-sm focus:border-red-400 focus:outline-none"
              placeholder={KONTO_LOESCHEN_BESTAETIGUNG}
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={!eingabeKorrekt || submitting}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium
                         text-white hover:bg-red-700 disabled:opacity-50"
            >
              {submitting ? "Wird gelöscht…" : "Konto endgültig löschen"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setBestaetigung("");
                setError(null);
              }}
              disabled={submitting}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5
                         text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
