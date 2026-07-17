/**
 * AnliegenNeuForm.tsx — Formular für Anliegen-Erfassung (Client-Komponente)
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAnliegen } from "@/lib/anliegen/actions";

interface Ortsteil {
  id: string;
  name: string;
  code: string;
}

interface Props {
  ortsteile: Ortsteil[];
}

export default function AnliegenNeuForm({ ortsteile }: Props) {
  const router = useRouter();
  const [titel, setTitel] = useState("");
  const [beschreibung, setBeschreibung] = useState("");
  const [ortsteilId, setOrtsteilId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await createAnliegen({
        titel: titel.trim(),
        beschreibung: beschreibung.trim() || undefined,
        ortsteilId: ortsteilId || null,
      });

      if (!result.ok || !result.trackingCode) {
        setError(result.error ?? "Unbekannter Fehler.");
        return;
      }

      // Erfolg: zur Code-Seite navigieren (hostbasierte URL — Middleware rewritet)
      router.push(`/anliegen/${result.trackingCode}?neu=1`);
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Titel */}
      <div>
        <label htmlFor="titel" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
          Titel <span className="text-red-500">*</span>
        </label>
        <input
          id="titel"
          type="text"
          value={titel}
          onChange={(e) => setTitel(e.target.value)}
          maxLength={200}
          required
          placeholder="Kurze Beschreibung Ihres Anliegens"
          className="w-full rounded-md border border-[color:var(--pz-line)] px-4 py-2.5 text-sm
                     text-pz-ink placeholder:text-pz-muted
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus:border-[color:var(--pz-brand)]"
        />
        <p className="mt-1 text-xs text-pz-muted">{titel.length}/200 Zeichen</p>
      </div>

      {/* Beschreibung */}
      <div>
        <label htmlFor="beschreibung" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
          Beschreibung <span className="text-pz-muted font-normal">(optional)</span>
        </label>
        <textarea
          id="beschreibung"
          value={beschreibung}
          onChange={(e) => setBeschreibung(e.target.value)}
          maxLength={5000}
          rows={5}
          placeholder="Weitere Details zu Ihrem Anliegen"
          className="w-full rounded-md border border-[color:var(--pz-line)] px-4 py-2.5 text-sm
                     text-pz-ink placeholder:text-pz-muted resize-y
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus:border-[color:var(--pz-brand)]"
        />
        <p className="mt-1 text-xs text-pz-muted">{beschreibung.length}/5000 Zeichen</p>
      </div>

      {/* Ortsteil */}
      {ortsteile.length > 0 && (
        <div>
          <label htmlFor="ortsteil" className="block text-sm font-medium mb-1" style={{ color: "var(--pz-ink)" }}>
            Ortsteil <span className="text-pz-muted font-normal">(optional)</span>
          </label>
          <select
            id="ortsteil"
            value={ortsteilId}
            onChange={(e) => setOrtsteilId(e.target.value)}
            className="w-full rounded-md border border-[color:var(--pz-line)] px-4 py-2.5 text-sm
                       text-pz-ink bg-pz-surface
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus:border-[color:var(--pz-brand)]"
          >
            <option value="">— Kein Ortsteil —</option>
            {ortsteile.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || !titel.trim()}
        className="w-full rounded-md px-4 py-2.5 text-sm font-semibold
                   text-white shadow-sm hover:opacity-90 focus:outline-none focus-visible:ring-2
                   focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 transition-opacity
                   disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: "var(--tenant-primary)" }}
      >
        {submitting ? "Wird eingereicht…" : "Anliegen einreichen"}
      </button>
    </form>
  );
}
