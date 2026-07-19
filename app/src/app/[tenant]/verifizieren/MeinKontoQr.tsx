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
 *
 * Vor-Ort-Befund C: sobald der QR sichtbar ist, pollt der Client GET /api/me alle
 * 3 s. Bestätigt der Verifizierer, springt die Stufe auf 2 → hier erscheint ein
 * freundlicher Erfolgs-Screen mit Konfetti (statt dass der Bürger ratlos vor dem
 * QR wartet). Polling stoppt bei Erfolg, bei Unmount und nach einer Obergrenze.
 */

"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { QrCode, RefreshCw, ShieldCheck, PartyPopper } from "lucide-react";
import { meinVerifizierungsProofErzeugen } from "@/lib/verification/proof-actions";
import { istVerifiziert, type MeStatusResponse } from "@/lib/verification/me-status";
import Konfetti from "@/components/Konfetti";

interface ProofState {
  code: string;
  proofUrl: string;
  qrDataUrl?: string;
  expiresAt: string;
}

// Polling: alle 3 s, Obergrenze ~100 Versuche (≈ 5 min, deckt den Proof-Ablauf
// ab) — danach still stoppen, damit keine Endlos-Schleife läuft.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_VERSUCHE = 100;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export default function MeinKontoQr({ tenantSlug }: { tenantSlug: string }) {
  const [isPending, startTransition] = useTransition();
  const [proof, setProof] = useState<ProofState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Demo-Mandant: die Vor-Ort-Verifizierung ist bewusst gefenced (kein echter
  // Beleg). Das ist KEIN Fehler — darum getrennt vom `error`-State geführt und
  // als neutraler Info-Hinweis (nicht rot, kein role="alert") gerendert.
  const [demoHinweis, setDemoHinweis] = useState(false);
  // Vor-Ort-Befund C: true, sobald der Verifizierer bestätigt hat (Stufe ≥ 2).
  const [verifiziert, setVerifiziert] = useState(false);

  function erzeugen() {
    setError(null);
    setDemoHinweis(false);
    startTransition(async () => {
      try {
        const r = await meinVerifizierungsProofErzeugen();
        if (r.demo) {
          setDemoHinweis(true);
          return;
        }
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

  // Live-Bestätigung: nur solange ein Beleg sichtbar UND noch nicht verifiziert.
  // Startet KEIN Polling im Demo-Fence (kein proof) oder nicht eingeloggten Zustand
  // (Komponente wird dort gar nicht gerendert).
  useEffect(() => {
    if (!proof || verifiziert) return;

    let versuche = 0;
    let abgebrochen = false;

    const timer = setInterval(async () => {
      versuche += 1;
      if (versuche > POLL_MAX_VERSUCHE) {
        clearInterval(timer);
        return;
      }
      try {
        const res = await fetch("/api/me", {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) return; // z. B. Session weg — tolerant, weiterversuchen
        const data = (await res.json()) as MeStatusResponse;
        if (!abgebrochen && istVerifiziert(data)) {
          setVerifiziert(true);
          clearInterval(timer);
        }
      } catch {
        // Netzfehler beim Poll: tolerant ignorieren, nächster Tick versucht erneut.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      abgebrochen = true;
      clearInterval(timer);
    };
  }, [proof, verifiziert]);

  // Erfolgs-Screen (Vor-Ort-Befund C): löst den QR ab, sobald bestätigt.
  if (verifiziert) {
    return (
      <div className="pz-card relative overflow-hidden p-6 text-center" role="status">
        <Konfetti />
        <div className="relative">
          <PartyPopper
            aria-hidden
            className="mx-auto h-9 w-9"
            style={{ color: "var(--pz-brand-strong)" }}
            strokeWidth={2}
          />
          <h3 className="mt-3 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
            Geschafft — danke fürs Mitmachen!
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
            Ihr Wohnsitz ist jetzt bestätigt (Stufe 2). Sie können bei
            verbindlichen Abstimmungen mitentscheiden.
          </p>
          <Link href={`/${tenantSlug}/umfragen`} className="pz-btn pz-btn-primary mt-4">
            Zu den Abstimmungen
          </Link>
        </div>
      </div>
    );
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
        {demoHinweis && (
          <div
            className="pz-card mt-3 p-3.5 text-sm"
            style={{ color: "var(--pz-body)" }}
          >
            In der Demo bleibt es bei der Vorschau — auf einer echten Kommune
            erzeugt dieser Knopf Ihren persönlichen QR, den die verifizierende
            Stelle scannt.
          </div>
        )}
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

      {/* Live-Hinweis: der QR bleibt stehen, bis der Verifizierer bestätigt —
          dann wechselt diese Ansicht automatisch zum Erfolgs-Screen. */}
      <p aria-live="polite" className="mt-3 text-center text-xs" style={{ color: "var(--pz-muted)" }}>
        Sobald bestätigt wurde, geht es hier automatisch weiter …
      </p>

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
