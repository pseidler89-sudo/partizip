/**
 * [tenant]/auth/verify/page.tsx — Magic-Link-Einlösung
 *
 * Liest ?token=... aus der URL, sendet POST /api/auth/verify.
 * Zeigt Statusmeldung + ggf. Link für neuen Request.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

type VerifyState =
  | { status: "loading" }
  | { status: "success" }
  | { status: "error"; code: string; message: string }
  | { status: "no-token" };

export default function VerifyPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<VerifyState>({ status: "loading" });
  const didVerify = useRef(false);

  useEffect(() => {
    if (didVerify.current) return;
    didVerify.current = true;

    const token = searchParams.get("token");
    if (!token) {
      // Defer state update to next tick to avoid synchronous setState in effect
      Promise.resolve().then(() => setState({ status: "no-token" }));
      return;
    }

    fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          setState({ status: "success" });
          // Absoluter Pfad: "./konto" löste relativ zu /auth/verify auf
          // (→ /auth/konto, existiert nicht → 404 nach erfolgreichem Login)
          setTimeout(() => router.push("/konto"), 1500);
        } else {
          const data = await res.json() as { error?: { code?: string; message?: string } };
          setState({
            status: "error",
            code: data?.error?.code ?? "UNKNOWN",
            message: data?.error?.message ?? "Ein unbekannter Fehler ist aufgetreten.",
          });
        }
      })
      .catch(() => {
        setState({
          status: "error",
          code: "NETWORK_ERROR",
          message: "Verbindungsfehler. Bitte versuchen Sie es erneut.",
        });
      });
  }, [searchParams, router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm text-center">
        {state.status === "loading" && (
          <>
            <div className="mb-4 text-4xl">⟳</div>
            <h1 className="text-xl font-semibold text-zinc-900">Link wird geprüft…</h1>
          </>
        )}

        {state.status === "success" && (
          <>
            <div className="mb-4 text-4xl">✓</div>
            <h1 className="text-xl font-semibold text-zinc-900">Anmeldung erfolgreich!</h1>
            <p className="mt-2 text-zinc-500 text-sm">Sie werden weitergeleitet…</p>
          </>
        )}

        {state.status === "no-token" && (
          <>
            <div className="mb-4 text-4xl">⚠</div>
            <h1 className="text-xl font-semibold text-zinc-900">Kein Link gefunden</h1>
            <p className="mt-2 text-zinc-500 text-sm">
              Dieser Link ist ungültig. Bitte fordern Sie einen neuen Anmeldelink an.
            </p>
            <Link href="/" className="mt-4 inline-block text-sm text-[color:var(--pz-brand-strong)] underline">
              Zur Anmeldeseite
            </Link>
          </>
        )}

        {state.status === "error" && (
          <>
            <div className="mb-4 text-4xl">✗</div>
            <h1 className="text-xl font-semibold text-zinc-900">
              {state.code === "TOKEN_EXPIRED" && "Link abgelaufen"}
              {state.code === "TOKEN_USED" && "Link bereits verwendet"}
              {state.code === "TOKEN_INVALID" && "Ungültiger Link"}
              {state.code === "FORBIDDEN" && "Kein Zugang"}
              {!["TOKEN_EXPIRED", "TOKEN_USED", "TOKEN_INVALID", "FORBIDDEN"].includes(state.code) &&
                "Fehler beim Anmelden"}
            </h1>
            <p className="mt-2 text-zinc-500 text-sm">{state.message}</p>
            <Link
              href="/"
              className="mt-4 inline-block rounded-md px-4 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
            >
              Neuen Link anfordern
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
