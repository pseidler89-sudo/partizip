/**
 * AnliegenTrackerForm.tsx — Client-Formular für Tracking-Code-Eingabe
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  tenantSlug: string;
}

export default function AnliegenTrackerForm({ tenantSlug }: Props) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) {
      setError("Bitte geben Sie einen Tracking-Code ein.");
      return;
    }
    setError(null);
    router.push(`/${tenantSlug}/anliegen/${encodeURIComponent(trimmed)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="tracking-code"
          className="block text-sm font-medium mb-1"
          style={{ color: "var(--pz-ink)" }}
        >
          Tracking-Code
        </label>
        <input
          id="tracking-code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="z. B. TS-ABCD-1234"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="w-full rounded-md border border-[color:var(--pz-line)] px-4 py-2.5 text-sm
                     font-mono tracking-wider text-pz-ink placeholder:text-pz-muted
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus:border-[color:var(--pz-brand)]"
        />
        {error && (
          <p className="mt-1 text-sm text-red-600">{error}</p>
        )}
      </div>

      <button
        type="submit"
        className="w-full rounded-md px-4 py-2.5 text-sm font-semibold
                   text-white shadow-sm hover:opacity-90 focus:outline-none focus-visible:ring-2
                   focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 transition-opacity"
        style={{ backgroundColor: "var(--tenant-primary)" }}
      >
        Status abrufen
      </button>
    </form>
  );
}
