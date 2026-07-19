/**
 * MeinKontoQr.tsx — Bürger-Ansicht „Mein Verifizierungs-QR" (V3, umgekehrte Richtung).
 *
 * Der eingeloggte Bürger erzeugt hier seinen kurzlebigen, EINMALIGEN Konto-Beleg
 * und zeigt dessen QR (oder den Klartext-Code) vor Ort. Der Verifizierer scannt/
 * bestätigt ihn nach Ausweis-Prüfung. Die eigentliche Verifizierung passiert
 * serverseitig über die Bestätigungs-Seite des Verifizierers — hier wird NUR der
 * Beleg erzeugt und angezeigt.
 *
 * Der QR/Code ist bewusst kurzlebig; nach Ablauf einfach „neu erzeugen".
 */

"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import { QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import { meinVerifizierungsProofErzeugen } from "@/lib/verification/proof-actions";

interface ProofState {
  code: string;
  proofUrl: string;
  qrDataUrl?: string;
  expiresAt: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export default function MeinKontoQr() {
  const [isPending, startTransition] = useTransition();
  const [proof, setProof] = useState<ProofState | null>(null);
  const [error, setError] = useState<string | null>(null);

  function erzeugen() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await meinVerifizierungsProofErzeugen();
        if (!r.ok || !r.code || !r.proofUrl) {
          setError(r.error ?? "QR-Code konnte nicht erzeugt werden.");
          return;
        }
        setProof({
          code: r.code,
          proofUrl: r.proofUrl,
          qrDataUrl: r.qrDataUrl,
          expiresAt: r.expiresAt ?? "",
        });
      } catch {
        setError("Verbindungsfehler — bitte erneut versuchen.");
      }
    });
  }

  if (!proof) {
    return (
      <div>
        <button
          type="button"
          onClick={erzeugen}
          disabled={isPending}
          className="pz-btn pz-btn-primary"
        >
          <QrCode aria-hidden className="mr-1.5 h-4 w-4" strokeWidth={2} />
          {isPending ? "Wird erzeugt…" : "Meinen Verifizierungs-QR anzeigen"}
        </button>
        {error && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-surface)" }}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="h-5 w-5 shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
        <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Zeigen Sie diesen Code der verifizierenden Person
        </p>
      </div>

      {proof.qrDataUrl && (
        <div className="mt-4 flex justify-center">
          <Image
            src={proof.qrDataUrl}
            alt="Ihr persönlicher Verifizierungs-QR-Code"
            width={240}
            height={240}
            unoptimized
            className="rounded-md bg-white p-2"
          />
        </div>
      )}

      {/* Klartext-Code als Fallback, falls der QR nicht scannbar ist. */}
      <div
        className="mt-4 rounded-lg border border-dashed p-2.5 text-center"
        style={{ borderColor: "var(--pz-line-strong, var(--pz-line))", backgroundColor: "var(--pz-brand-soft)" }}
      >
        <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
          Falls der QR nicht scannbar ist — dieser Code (vorlesen/eintippen lassen):
        </p>
        <p className="mt-0.5 break-all font-mono text-xs font-medium" style={{ color: "var(--pz-ink)" }}>
          {proof.code}
        </p>
      </div>

      {proof.expiresAt && (
        <p className="mt-3 text-center text-xs" style={{ color: "var(--pz-muted)" }}>
          Gültig bis {formatTime(proof.expiresAt)} Uhr. Danach einfach neu erzeugen.
        </p>
      )}

      <button
        type="button"
        onClick={erzeugen}
        disabled={isPending}
        className="pz-btn pz-btn-secondary pz-btn-sm mt-3 w-full"
        style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
      >
        <RefreshCw aria-hidden className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
        {isPending ? "…" : "Neu erzeugen"}
      </button>

      {error && (
        <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
