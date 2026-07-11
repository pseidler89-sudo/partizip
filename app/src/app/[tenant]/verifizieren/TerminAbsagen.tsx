/**
 * TerminAbsagen.tsx — Storno-Button für den eigenen offenen Termin (D6).
 * Ruft die Server Action cancelBooking; gibt bei Erfolg die Kapazität frei.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cancelBooking } from "@/lib/verification/booking-actions";

export default function TerminAbsagen({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function absagen() {
    setError(null);
    setBusy(true);
    try {
      const r = await cancelBooking(bookingId);
      if (!r.ok) {
        setError(r.error ?? "Absagen fehlgeschlagen.");
        return;
      }
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={absagen}
        disabled={busy}
        className="text-sm font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:opacity-50"
        style={{ color: "var(--pz-muted)" }}
      >
        {busy ? "Wird abgesagt…" : "Termin absagen"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
