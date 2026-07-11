/**
 * TermineVerwaltung.tsx — Verifier-Liste offener Termine (D6).
 *
 * PII-frei: zeigt NUR Termin-Code + Zeit + Standort. Der Bürger nennt vor Ort
 * seinen Code; nach Sicht-Prüfung des Ausweises bestätigt der Verifier über
 * „Wahrnehmen" → die Person wird wohnsitz-verifiziert (Stufe 2). Server Action
 * erzwingt canVerify; die Liste hier ist nur Komfort.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, CheckCircle2 } from "lucide-react";
import { bookingWahrnehmen } from "@/lib/verification/booking-actions";

export interface TerminVM {
  bookingId: string;
  code: string;
  label: string;
  locationName: string;
}

export default function TermineVerwaltung({ termine }: { termine: TerminVM[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  async function wahrnehmen(bookingId: string) {
    setError(null);
    setBusy(bookingId);
    try {
      const r = await bookingWahrnehmen(bookingId);
      if (!r.ok) {
        setError(r.error ?? "Bestätigen fehlgeschlagen.");
        return;
      }
      setDone((prev) => new Set(prev).add(bookingId));
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusy(null);
    }
  }

  if (termine.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
        Derzeit sind keine offenen Termine gebucht.
      </p>
    );
  }

  return (
    <div>
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {termine.map((t) => {
          const erledigt = done.has(t.bookingId);
          return (
            <li
              key={t.bookingId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
              style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-surface)" }}
            >
              <div>
                <p className="font-mono text-sm font-medium" style={{ color: "var(--pz-ink)" }}>{t.code}</p>
                <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
                  {t.label} · {t.locationName}
                </p>
              </div>
              {erledigt ? (
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--pz-success-ink)" }}>
                  <CheckCircle2 aria-hidden className="h-4 w-4" strokeWidth={2} /> verifiziert
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => wahrnehmen(t.bookingId)}
                  disabled={busy !== null}
                  aria-busy={busy === t.bookingId}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ backgroundColor: "var(--tenant-primary)" }}
                >
                  <BadgeCheck aria-hidden className="h-4 w-4" strokeWidth={2} />
                  {busy === t.bookingId ? "…" : "Wahrnehmen"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
