"use client";

/**
 * RegionBanner.tsx — zeigt die gemerkte Region (ADR-015).
 *
 * Dezenter Streifen: „Region: <Kommune> · <Ortsteil/ganze Kommune>" mit
 * Ortsteil-Auswahl (verfeinert die Sicht für nicht-eingeloggte Leser) und
 * „Region ändern" (vergisst das Cookie → Haustür).
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ortsteilSetzen, regionZuruecksetzen } from "@/lib/region/actions";
import type { OrtsteilOption } from "@/lib/region/queries";

export function RegionBanner({
  tenantName,
  ortsteile,
  currentOrtsteilCode,
}: {
  tenantName: string;
  ortsteile: OrtsteilOption[];
  currentOrtsteilCode: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleOrtsteilChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const code = e.target.value || null;
    startTransition(async () => {
      await ortsteilSetzen(code);
      router.refresh();
    });
  }

  function handleAendern() {
    startTransition(async () => {
      await regionZuruecksetzen();
      router.refresh();
    });
  }

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg px-4 py-2.5 text-sm"
      style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
    >
      <span className="font-medium">
        <span aria-hidden>📍</span> Region: {tenantName}
      </span>

      {ortsteile.length > 0 && (
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Ortsteil wählen</span>
          <select
            value={currentOrtsteilCode ?? ""}
            onChange={handleOrtsteilChange}
            disabled={pending}
            className="rounded-md border border-[color:var(--pz-line)] bg-white px-2 py-1 text-sm disabled:opacity-60"
            style={{ color: "var(--pz-ink)" }}
          >
            <option value="">Ganze Kommune</option>
            {ortsteile.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        type="button"
        onClick={handleAendern}
        disabled={pending}
        className="underline-offset-4 hover:underline disabled:opacity-60"
      >
        Andere PLZ / Region ansehen
      </button>
    </div>
  );
}
