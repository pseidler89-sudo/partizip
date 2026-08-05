/**
 * CodeBestaetigen.tsx — Eingabe des Einmalcodes bzw. eines Wiederherstellungs-
 * codes (Client, #59).
 *
 * `ziel` ist bereits serverseitig durch safeRedirectPath() gelaufen (page.tsx);
 * hier wird nichts mehr aus der URL gelesen.
 *
 * Weitergeleitet wird per window.location.assign, also mit vollem Dokument-Load:
 * Erst dann rendern die Server-Layouts (u. a. das Zwei-Faktor-Gate unter /admin)
 * mit der frisch bestätigten Session neu. Ein Client-Push würde auf eine noch
 * gesperrte, zwischengespeicherte Ansicht laufen.
 */

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { bestaetigeCode, loeseWiederherstellungscodeEin } from "@/lib/auth/totp-actions";

export default function CodeBestaetigen({
  tenantSlug,
  ziel,
}: {
  tenantSlug: string;
  ziel: string;
}) {
  const [code, setCode] = useState("");
  const [rettung, setRettung] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);
  const [verbleibend, setVerbleibend] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  function weiter() {
    window.location.assign(ziel);
  }

  function absendenCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFehler(null);
    startTransition(async () => {
      try {
        const r = await bestaetigeCode(code);
        if (!r.ok) {
          setFehler(r.error);
          return;
        }
        weiter();
      } catch {
        setFehler("Verbindungsfehler — bitte versuchen Sie es erneut.");
      }
    });
  }

  function absendenRettung(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFehler(null);
    startTransition(async () => {
      try {
        const r = await loeseWiederherstellungscodeEin(rettung.trim().toUpperCase());
        if (!r.ok) {
          setFehler(r.error);
          return;
        }
        // Kurz stehen lassen, damit die Restanzahl gelesen werden kann; der
        // Knopf daneben führt sofort weiter.
        setVerbleibend(r.verbleibend);
        setTimeout(weiter, 5000);
      } catch {
        setFehler("Verbindungsfehler — bitte versuchen Sie es erneut.");
      }
    });
  }

  // Eingelöster Wiederherstellungscode: Hinweis auf den Restbestand, dann weiter.
  if (verbleibend !== null) {
    return (
      <div role="status" aria-live="polite">
        <p className="text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
          Bestätigt — Sie werden weitergeleitet …
        </p>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Dieser Wiederherstellungscode ist jetzt verbraucht. Ihnen{" "}
          {verbleibend === 1 ? "bleibt noch 1 Code" : `bleiben noch ${verbleibend} Codes`}.
          {verbleibend <= 2 &&
            " Richten Sie Ihre Authenticator-App zeitnah neu ein, damit Ihnen die Codes nicht ausgehen."}
        </p>
        <button type="button" onClick={weiter} className="pz-btn pz-btn-primary mt-4">
          Weiter
        </button>
      </div>
    );
  }

  return (
    <div>
      <form onSubmit={absendenCode}>
        <label
          htmlFor="totp-code"
          className="mb-1.5 block text-sm font-medium"
          style={{ color: "var(--pz-ink)" }}
        >
          Einmalcode
        </label>
        <input
          id="totp-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          className="h-12 w-full rounded-md border border-[color:var(--pz-line)] bg-pz-surface px-3 text-center font-mono text-xl tracking-[0.3em] outline-none focus:border-[color:var(--pz-brand)] focus:ring-2 focus:ring-[color:var(--pz-brand)]/30"
          style={{ color: "var(--pz-ink)" }}
        />
        <button
          type="submit"
          disabled={isPending || code.length !== 6}
          className="pz-btn pz-btn-primary mt-4 w-full"
        >
          {isPending ? "Wird geprüft …" : "Bestätigen"}
        </button>
      </form>

      {fehler && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "var(--pz-danger)" }}>
          {fehler}
        </p>
      )}

      <details className="mt-6">
        <summary
          className="cursor-pointer text-sm font-medium"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Authenticator nicht zur Hand?
        </summary>
        <div className="mt-3">
          <p className="text-sm" style={{ color: "var(--pz-body)" }}>
            Verwenden Sie einen Ihrer Wiederherstellungscodes aus der Einrichtung. Jeder Code
            funktioniert genau einmal.
          </p>
          <form onSubmit={absendenRettung} className="mt-3">
            <label
              htmlFor="wiederherstellungscode"
              className="mb-1.5 block text-sm font-medium"
              style={{ color: "var(--pz-ink)" }}
            >
              Wiederherstellungscode
            </label>
            <input
              id="wiederherstellungscode"
              name="wiederherstellungscode"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              value={rettung}
              onChange={(e) => setRettung(e.target.value)}
              placeholder="XXXXX-XXXXX"
              className="h-12 w-full rounded-md border border-[color:var(--pz-line)] bg-pz-surface px-3 font-mono text-base tracking-wider outline-none focus:border-[color:var(--pz-brand)] focus:ring-2 focus:ring-[color:var(--pz-brand)]/30"
              style={{ color: "var(--pz-ink)" }}
            />
            <button
              type="submit"
              disabled={isPending || rettung.trim().length === 0}
              className="pz-btn pz-btn-secondary mt-3 w-full"
            >
              {isPending ? "Wird geprüft …" : "Wiederherstellungscode einlösen"}
            </button>
          </form>
          <p className="mt-3 text-xs" style={{ color: "var(--pz-muted)" }}>
            Auch die Codes verloren? Dann kann nur der Betreiber den zweiten Faktor zurücksetzen —
            aus Sicherheitsgründen geht das nicht über diese Seite.
          </p>
        </div>
      </details>

      <p className="mt-6 text-center text-sm">
        <Link href={`/${tenantSlug}/konto`} style={{ color: "var(--pz-brand-strong)" }}>
          Zurück zum Konto
        </Link>
      </p>
    </div>
  );
}
