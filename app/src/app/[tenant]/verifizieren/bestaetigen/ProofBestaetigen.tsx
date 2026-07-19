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
  // Demo-Mandant: bewusst kein Grant — neutraler Hinweis statt Fehler.
  | { kind: "demo" }
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
  // Verifizierer-Attestierung (rein clientseitige Sorgfalts-Hilfe; die eigentliche
  // Durchsetzung bleibt serverseitig: requireVerifierCtx + Gebiets-Abdeckung
  // fail-closed). Der Bestätigen-Button bleibt gesperrt, bis BEIDE angehakt sind.
  const [ausweisGeprueft, setAusweisGeprueft] = useState(false);
  const [wohnsitzBestaetigt, setWohnsitzBestaetigt] = useState(false);
  const attestiert = ausweisGeprueft && wohnsitzBestaetigt;

  // Getrennte Gruppen für die Auswahl (Kommune vs. Ortsteil), damit der
  // Verifizierer bewusst den feineren Ortsteil-Anker wählen kann, wenn er ihn kennt.
  const gemeinden = gebiete.filter((g) => g.typ === "gemeinde");
  const ortsteile = gebiete.filter((g) => g.typ === "ortsteil");

  function handleConfirm() {
    if (!regionId) {
      setResult({ kind: "error", message: "Bitte wählen Sie ein Gebiet aus." });
      return;
    }
    startTransition(async () => {
      try {
        const r = await verifizierungPerProofBestaetigen(proofToken, regionId);
        if (r.demo) {
          setResult({ kind: "demo" });
          return;
        }
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
          aria-describedby="proof-region-hint"
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          style={{ borderColor: "var(--pz-line)" }}
        >
          {gemeinden.length > 0 && (
            <optgroup label={TYP_LABEL.gemeinde}>
              {gemeinden.map((g) => (
                <option key={g.regionId} value={g.regionId}>
                  {g.label}
                </option>
              ))}
            </optgroup>
          )}
          {ortsteile.length > 0 && (
            <optgroup label="Ortsteile">
              {ortsteile.map((g) => (
                <option key={g.regionId} value={g.regionId}>
                  {g.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
      <p id="proof-region-hint" className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
        Das Gebiet, für das Sie den Wohnsitz bestätigen. Es ist auf Ihr
        Zuständigkeitsgebiet begrenzt. Wählen Sie den Ortsteil, wenn Sie ihn
        kennen — das setzt den verbindlichen Wohnsitz genauer.
      </p>

      {/* Verifizierer-Bestätigungs-Checkliste: beide Häkchen sind Pflicht, bevor
          der Button aktiv wird (clientseitige Sorgfalts-Hilfe; die Sicherheit
          liegt serverseitig). */}
      <fieldset className="mt-4 rounded-lg border p-3" style={{ borderColor: "var(--pz-line)" }}>
        <legend className="px-1 text-xs font-medium" style={{ color: "var(--pz-body)" }}>
          Vor der Bestätigung
        </legend>
        <label htmlFor="chk-ausweis" className="flex items-start gap-2 text-sm" style={{ color: "var(--pz-ink)" }}>
          <input
            id="chk-ausweis"
            type="checkbox"
            checked={ausweisGeprueft}
            onChange={(e) => setAusweisGeprueft(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span>Ausweis geprüft</span>
        </label>
        <label htmlFor="chk-wohnsitz" className="mt-2 flex items-start gap-2 text-sm" style={{ color: "var(--pz-ink)" }}>
          <input
            id="chk-wohnsitz"
            type="checkbox"
            checked={wohnsitzBestaetigt}
            onChange={(e) => setWohnsitzBestaetigt(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span>Wohnsitz im angezeigten Gebiet bestätigt</span>
        </label>
      </fieldset>

      <button
        type="button"
        onClick={handleConfirm}
        disabled={isPending || !attestiert}
        aria-describedby={attestiert ? undefined : "proof-confirm-hint"}
        className="pz-btn pz-btn-primary pz-btn-lg mt-4 w-full"
      >
        {isPending ? "Wird bestätigt…" : "Wohnsitz für dieses Konto bestätigen"}
      </button>
      {!attestiert && (
        <p id="proof-confirm-hint" className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
          Bitte bestätigen Sie beide Punkte, um fortzufahren.
        </p>
      )}

      {result.kind === "demo" && (
        <div className="pz-card mt-4 p-3.5 text-sm" style={{ color: "var(--pz-body)" }}>
          In der Demo bleibt es bei der Vorschau — auf einer echten Kommune
          bestätigt dieser Knopf den Wohnsitz für das gescannte Konto.
        </div>
      )}

      {result.kind === "error" && (
        <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {result.message}
        </div>
      )}
    </div>
  );
}
