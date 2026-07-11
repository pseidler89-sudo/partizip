/**
 * VerifizierenBestaetigen.tsx — Client-Bestätigung der QR-Einlösung (ADR-014 Block 2).
 *
 * Zeigt den Bestätigen-Button. Bei Klick ruft er die Server Action qrEinloesen
 * (die Stufe-1-Pflicht, Cap-Atomarität, Idempotenz, Ablauf/Widerruf serverseitig
 * erzwingt). Zustände:
 *   - Erfolg → „Sie sind jetzt wohnsitz-verifiziert (Stufe 2) bis <Datum>".
 *   - alreadyRedeemed → freundlicher Hinweis, dass schon eingelöst wurde.
 *   - needLogin → Anmelde-CTA (z. B. Session abgelaufen).
 *   - Fehler → freundliche Meldung (aufgebraucht/abgelaufen/…).
 */

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { qrEinloesen } from "@/lib/verification/qr-actions";

interface Props {
  code: string;
  tenantSlug: string;
}

type Result =
  | { kind: "idle" }
  | { kind: "success"; verifiedUntil?: string }
  | { kind: "already" }
  | { kind: "needLogin" }
  | { kind: "error"; message: string };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function VerifizierenBestaetigen({ code, tenantSlug }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<Result>({ kind: "idle" });

  function handleConfirm() {
    startTransition(async () => {
      try {
        const r = await qrEinloesen(code);
        if (r.needLogin) {
          setResult({ kind: "needLogin" });
          return;
        }
        if (!r.ok) {
          setResult({ kind: "error", message: r.error ?? "Verifizierung fehlgeschlagen." });
          return;
        }
        if (r.alreadyRedeemed) {
          setResult({ kind: "already" });
          router.refresh();
          return;
        }
        setResult({ kind: "success", verifiedUntil: r.verifiedUntil });
        router.refresh();
      } catch {
        setResult({ kind: "error", message: "Verbindungsfehler — bitte erneut versuchen." });
      }
    });
  }

  if (result.kind === "success") {
    return (
      <div className="mt-5 rounded-lg border p-4 text-center" style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-brand-soft)" }}>
        <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Sie sind jetzt wohnsitz-verifiziert (Stufe 2)
          {result.verifiedUntil ? ` bis ${formatDate(result.verifiedUntil)}` : ""}.
        </p>
        <Link
          href={`/${tenantSlug}/konto`}
          className="mt-3 inline-block text-sm font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Zum Konto
        </Link>
      </div>
    );
  }

  if (result.kind === "already") {
    return (
      <div className="mt-5 rounded-lg border p-4 text-center" style={{ borderColor: "var(--pz-line)" }}>
        <p className="text-sm" style={{ color: "var(--pz-body)" }}>
          Sie haben sich mit diesem Code bereits verifiziert — es ist nichts weiter
          zu tun.
        </p>
        <Link
          href={`/${tenantSlug}/konto`}
          className="mt-3 inline-block text-sm font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Zum Konto
        </Link>
      </div>
    );
  }

  if (result.kind === "needLogin") {
    return (
      <div className="mt-5 rounded-lg border p-4 text-center" style={{ borderColor: "var(--pz-line)" }}>
        <p className="text-sm" style={{ color: "var(--pz-body)" }}>
          Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an und öffnen
          Sie den Link danach noch einmal.
        </p>
        <Link
          href={`/${tenantSlug}/anmelden`}
          className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
          style={{ backgroundColor: "var(--tenant-primary)" }}
        >
          Anmelden
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={handleConfirm}
        disabled={isPending}
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:opacity-50"
        style={{ backgroundColor: "var(--tenant-primary)" }}
      >
        {isPending ? "Wird bestätigt…" : "Verifizierung bestätigen"}
      </button>

      {result.kind === "error" && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {result.message}
        </div>
      )}
    </div>
  );
}
