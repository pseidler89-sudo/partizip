/**
 * ProfilSection.tsx — Konto-Sektion „Ihr öffentlicher Name" für ROLLENTRÄGER
 * (Block J1). Klarname (Pflicht-Hinweis für die Rolle) + optionale Funktion.
 *
 * Erscheint NUR für Rollenträger (die Konto-Seite rendert sie nicht für reine
 * Bürger). Speichern läuft über die Server-Action profilSpeichern; bei Erfolg
 * eine dezente Bestätigung, bei Fehler wird die Eingabe erhalten und der Fehler
 * gezeigt. Tonalität „Sie", pz-System.
 */

"use client";

import { useState } from "react";
import { profilSpeichern } from "@/lib/konto/profil-actions";

export function ProfilSection({
  initialDisplayName,
  initialFunktion,
}: {
  initialDisplayName: string | null;
  initialFunktion: string | null;
}) {
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [funktion, setFunktion] = useState(initialFunktion ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bestaetigt, setBestaetigt] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setBestaetigt(false);
    try {
      const result = await profilSpeichern({ displayName, funktion });
      if (!result.ok) {
        setError(result.error ?? "Speichern fehlgeschlagen.");
        return;
      }
      // Serverseitig getrimmte Werte übernehmen (null → leeres Feld).
      setDisplayName(result.displayName ?? "");
      setFunktion(result.funktion ?? "");
      setBestaetigt(true);
    } catch {
      setError("Verbindungsfehler.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section id="oeffentlicher-name" className="mb-6 scroll-mt-6">
      <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--pz-ink)" }}>
        Ihr öffentlicher Name
      </h2>
      <form onSubmit={handleSubmit} className="pz-card space-y-4 p-4">
        <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
          Sie tragen eine Rolle auf dieser Plattform. Damit Bürgerinnen und Bürger
          erkennen, wer hinter einer Abstimmung oder Prüfung steht, zeigen wir bei
          Ihrer Rollenausübung Ihren Klarnamen und – falls angegeben – Ihre Funktion.
          Ihre eigene Teilnahme als Bürgerin oder Bürger (Abstimmen, Anliegen) bleibt
          davon unberührt und pseudonym.
        </p>

        <div>
          <label
            htmlFor="profil-display-name"
            className="block text-xs font-medium"
            style={{ color: "var(--pz-body)" }}
          >
            Klarname
          </label>
          <input
            id="profil-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80}
            autoComplete="name"
            placeholder="z. B. Maria Musterfrau"
            className="mt-1 w-full rounded-md border border-pz-line px-3 py-1.5 text-sm
                       focus:border-pz-brand focus:outline-none"
          />
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            Für Ihre Rolle empfohlen. Ohne Klarnamen erscheint bei Ihren Beiträgen nur
            der Name Ihrer Institution.
          </p>
        </div>

        <div>
          <label
            htmlFor="profil-funktion"
            className="block text-xs font-medium"
            style={{ color: "var(--pz-body)" }}
          >
            Funktion / Amtsbezeichnung <span style={{ color: "var(--pz-muted)" }}>(optional)</span>
          </label>
          <input
            id="profil-funktion"
            type="text"
            value={funktion}
            onChange={(e) => setFunktion(e.target.value)}
            maxLength={80}
            placeholder="z. B. Bürgermeisterin"
            className="mt-1 w-full rounded-md border border-pz-line px-3 py-1.5 text-sm
                       focus:border-pz-brand focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={submitting} className="pz-btn pz-btn-primary">
            {submitting ? "Speichern…" : "Speichern"}
          </button>
          {bestaetigt && !error && (
            <span className="text-xs" style={{ color: "var(--pz-muted)" }}>
              Gespeichert.
            </span>
          )}
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </form>
    </section>
  );
}
