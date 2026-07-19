/**
 * ProofBestaetigen.tsx — Verifizierer-Bestätigung des Konto-QR (V3).
 *
 * Der Verifizierer hat den Konto-QR des Bürgers gescannt (Token in der URL). Diese
 * Client-Komponente zeigt die Gebiets-Auswahl und den Bestätigen-Button. Bei Klick
 * ruft sie die Server Action verifizierungPerProofBestaetigen (die canVerify,
 * Gebiets-Autorität, Single-Use-Konsum und Kein-Selbst-Grant serverseitig
 * erzwingt). Die Bürger-Identität wird NIE angezeigt.
 */

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { verifizierungPerProofBestaetigen } from "@/lib/verification/proof-actions";

export interface ProofGebietOption {
  regionId: string;
  typ: "gemeinde" | "ortsteil";
  label: string;
}

interface Props {
  proofToken: string;
  tenantSlug: string;
  gebiete: ProofGebietOption[];
  vorbelegtRegionId: string | null;
}

type Result =
  | { kind: "idle" }
  | { kind: "success"; verifiedUntil?: string }
  | { kind: "error"; message: string };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

const TYP_LABEL: Record<ProofGebietOption["typ"], string> = {
  gemeinde: "Kommune",
  ortsteil: "Ortsteil",
};

export default function ProofBestaetigen({
  proofToken,
  tenantSlug,
  gebiete,
  vorbelegtRegionId,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const einziges = gebiete.length === 1;
  const [regionId, setRegionId] = useState<string>(
    vorbelegtRegionId ?? (gebiete[0]?.regionId ?? ""),
  );

  function handleConfirm() {
    if (!regionId) {
      setResult({ kind: "error", message: "Bitte wählen Sie ein Gebiet aus." });
      return;
    }
    startTransition(async () => {
      try {
        const r = await verifizierungPerProofBestaetigen(proofToken, regionId);
        if (!r.ok) {
          setResult({ kind: "error", message: r.error ?? "Bestätigung fehlgeschlagen." });
          return;
        }
        setResult({ kind: "success", verifiedUntil: r.verifiedUntil });
      } catch {
        setResult({ kind: "error", message: "Verbindungsfehler — bitte erneut versuchen." });
      }
    });
  }

  if (result.kind === "success") {
    return (
      <div
        className="mt-5 rounded-lg border p-4 text-center"
        style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-brand-soft)" }}
        role="status"
      >
        <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Wohnsitz bestätigt (Stufe 2)
          {result.verifiedUntil ? ` — gültig bis ${formatDate(result.verifiedUntil)}` : ""}.
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--pz-body)" }}>
          Die Person ist jetzt wohnsitz-verifiziert. Der Beleg wurde verbraucht.
        </p>
        <Link
          href={`/${tenantSlug}/verifizieren/bestaetigen`}
          className="mt-3 inline-block text-sm font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Nächste Person bestätigen
        </Link>
      </div>
    );
  }

  if (gebiete.length === 0) {
    return (
      <div className="mt-5 rounded-lg border p-4" style={{ borderColor: "var(--pz-line)" }}>
        <p className="text-sm" style={{ color: "var(--pz-body)" }}>
          Für Ihr Konto ist kein Zuständigkeitsgebiet hinterlegt. Bitte wenden Sie
          sich an Ihre Kommune.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5">
      <label htmlFor="proof-region" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
        Wohnsitz-Gebiet
      </label>
      {einziges ? (
        <p
          id="proof-region"
          className="mt-1 rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)", backgroundColor: "var(--pz-surface)" }}
        >
          {TYP_LABEL[gebiete[0].typ]}: {gebiete[0].label}
        </p>
      ) : (
        <select
          id="proof-region"
          value={regionId}
          onChange={(e) => setRegionId(e.target.value)}
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          style={{ borderColor: "var(--pz-line)" }}
        >
          {gebiete.map((g) => (
            <option key={g.regionId} value={g.regionId}>
              {TYP_LABEL[g.typ]}: {g.label}
            </option>
          ))}
        </select>
      )}
      <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
        Das Gebiet, für das Sie den Wohnsitz bestätigen. Es ist auf Ihr
        Zuständigkeitsgebiet begrenzt.
      </p>

      <button
        type="button"
        onClick={handleConfirm}
        disabled={isPending}
        className="pz-btn pz-btn-primary pz-btn-lg mt-4 w-full"
      >
        {isPending ? "Wird bestätigt…" : "Wohnsitz für dieses Konto bestätigen"}
      </button>

      {result.kind === "error" && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {result.message}
        </div>
      )}
    </div>
  );
}
