/**
 * EmailAendernSection.tsx — Aufklapp „E-Mail-Adresse ändern" in den Kontodaten
 * (Block J2b). Eingabe der neuen Adresse + Senden; danach ein neutraler
 * Pending-Hinweis (kein Adress-Oracle — die Antwort ist für alle möglichen
 * Ausgänge identisch). Ton „Sie", pz-System.
 *
 * Auf dem Demo-Mandanten wird die Sektion nicht gerendert (die Konto-Seite
 * blendet sie aus) — der Wechsel ist dort serverseitig ohnehin gefenced.
 */

"use client";

import { useState } from "react";
import { emailAenderungAnfordern } from "@/lib/konto/email-change-actions";

export function EmailAendernSection() {
  const [offen, setOffen] = useState(false);
  const [neueEmail, setNeueEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setHinweis(null);
    try {
      const res = await emailAenderungAnfordern(neueEmail);
      if (!res.ok) {
        setError(res.error ?? "Die Anforderung ist fehlgeschlagen.");
        return;
      }
      setHinweis(res.message ?? "Bitte prüfen Sie das Postfach der neuen Adresse.");
      setNeueEmail("");
    } catch {
      setError("Verbindungsfehler.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!offen) {
    return (
      <button
        type="button"
        onClick={() => setOffen(true)}
        className="text-xs font-medium underline-offset-2 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
        style={{ color: "var(--pz-brand-strong)" }}
      >
        E-Mail-Adresse ändern
      </button>
    );
  }

  if (hinweis) {
    return (
      <div className="text-xs" aria-live="polite" style={{ color: "var(--pz-muted)" }}>
        <p>{hinweis}</p>
        <button
          type="button"
          onClick={() => {
            setOffen(false);
            setHinweis(null);
          }}
          className="mt-2 font-medium underline-offset-2 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Schließen
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <label htmlFor="neue-email" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
        Neue E-Mail-Adresse
      </label>
      <input
        id="neue-email"
        type="email"
        value={neueEmail}
        onChange={(e) => setNeueEmail(e.target.value)}
        autoComplete="email"
        placeholder="neue.adresse@beispiel.de"
        className="w-full rounded-md border border-pz-line px-3 py-1.5 text-sm focus:border-pz-brand focus:outline-none"
      />
      <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
        Wir senden einen Bestätigungslink an die neue Adresse. Die Änderung wird
        erst wirksam, nachdem Sie diesen Link bestätigt haben.
      </p>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="pz-btn pz-btn-primary">
          {submitting ? "Senden…" : "Bestätigungslink senden"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOffen(false);
            setError(null);
          }}
          className="text-xs underline-offset-2 hover:underline"
          style={{ color: "var(--pz-muted)" }}
        >
          Abbrechen
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
