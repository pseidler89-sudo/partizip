"use client";

/**
 * MitmachenFormular — Stufe 4 des „Mitmachen"-Trichters (Block N4): schlankes
 * Lead-Formular für Multiplikatoren. Ruft die gehärtete Server Action
 * interesseHinterlassen (Origin-Check, Honeypot, Rate-Limit, Demo-Fence).
 *
 * Honeypot: ein visuell + für AT verstecktes Feld `website`. Menschen lassen es
 * leer; Bots füllen es aus → die Action antwortet dann still mit Erfolg, ohne
 * einen Lead zu schreiben. Deshalb: aria-hidden, tabIndex -1, autoComplete off.
 */

import { useState } from "react";
import { interesseHinterlassen } from "@/lib/interessenten/actions";

export default function MitmachenFormular() {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFehler(null);
    setBusy(true);
    const formData = new FormData(e.currentTarget);
    try {
      const res = await interesseHinterlassen(formData);
      if (!res.ok) {
        setFehler(res.error ?? "Es ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut.");
        return;
      }
      setErfolg(true);
    } catch {
      setFehler("Verbindungsfehler — bitte versuchen Sie es erneut.");
    } finally {
      setBusy(false);
    }
  }

  if (erfolg) {
    return (
      <div
        className="rounded-xl p-6 text-center"
        style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
        role="status"
      >
        <p className="text-base font-semibold">Vielen Dank für Ihr Interesse!</p>
        <p className="mt-1 text-sm">
          Wir haben Ihre Nachricht erhalten und melden uns zeitnah bei Ihnen.
        </p>
      </div>
    );
  }

  const feldClass =
    "w-full rounded-md border px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Honeypot — versteckt für Menschen & AT; Bots tappen hinein. */}
      <div aria-hidden="true" className="absolute h-0 w-0 overflow-hidden opacity-0">
        <label htmlFor="website">Website (bitte leer lassen)</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ansprechpartner" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
            Name <span className="text-red-500">*</span>
          </label>
          <input
            id="ansprechpartner"
            name="ansprechpartner"
            type="text"
            required
            maxLength={120}
            autoComplete="name"
            className={feldClass}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
            E-Mail <span className="text-red-500">*</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className={feldClass}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="kommune" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
            Organisation <span className="text-pz-muted font-normal">(optional)</span>
          </label>
          <input
            id="kommune"
            name="kommune"
            type="text"
            maxLength={160}
            placeholder="Kommune, Kreis oder Verein"
            className={feldClass}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          />
        </div>
        <div>
          <label htmlFor="rolle" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
            Ihre Funktion <span className="text-pz-muted font-normal">(optional)</span>
          </label>
          <input
            id="rolle"
            name="rolle"
            type="text"
            maxLength={80}
            className={feldClass}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          />
        </div>
      </div>

      <div>
        <label htmlFor="nachricht" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
          Nachricht <span className="text-pz-muted font-normal">(optional)</span>
        </label>
        <textarea
          id="nachricht"
          name="nachricht"
          rows={4}
          maxLength={2000}
          placeholder="Worum geht es? Was möchten Sie wissen?"
          className={`${feldClass} resize-y`}
          style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
        />
      </div>

      {fehler && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {fehler}
        </div>
      )}

      <button type="submit" disabled={busy} className="pz-btn pz-btn-primary pz-btn-lg min-h-[48px]">
        {busy ? "Wird gesendet…" : "Interesse senden"}
      </button>

      <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
        Mit dem Absenden übermitteln Sie uns Ihre Angaben zur Kontaktaufnahme. Details
        finden Sie in unserer Datenschutzerklärung.
      </p>
    </form>
  );
}
