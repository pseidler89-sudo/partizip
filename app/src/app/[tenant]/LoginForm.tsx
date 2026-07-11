/**
 * LoginForm.tsx — Magic-Link-Anmeldeformular (Client-Komponente).
 *
 * An das „Partizip Design System" (claude.ai/design) angeglichen: Mail-Icon im
 * Feld, „Anmeldelink senden", Trust-Zeilen (kein Passwort / anonym), und ein
 * ruhiger Bestätigungs-Screen mit immer gleicher Antwort (kein Enumeration-Leak)
 * + Hinweis, dass man angemeldet bleibt. Logik unverändert:
 *   - E-Mail + Pflicht-Checkbox „≥16" (nur bei Erstregistrierung relevant)
 *   - kein Enumeration-Leak (Checkbox immer sichtbar; Bestätigung immer gleich)
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, ArrowRight, MailCheck, KeyRound, ShieldCheck, Clock, Pencil, Info } from "lucide-react";

export function LoginForm({ tenantSlug }: { tenantSlug: string }) {
  const [email, setEmail] = useState("");
  const [minAgeConfirmed, setMinAgeConfirmed] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    setStatus("loading");
    setErrorMessage("");

    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, minAgeConfirmed }),
      });

      if (res.ok) {
        setStatus("sent");
      } else {
        const data = (await res.json()) as { error?: { message?: string } };
        setErrorMessage(data?.error?.message ?? "Ein Fehler ist aufgetreten.");
        setStatus("error");
      }
    } catch {
      setErrorMessage("Verbindungsfehler. Bitte versuchen Sie es erneut.");
      setStatus("error");
    }
  }

  // — Bestätigungs-Screen (immer gleich, datenschutzkonform) —
  if (status === "sent") {
    return (
      <div role="status" aria-live="polite" className="mx-auto w-full max-w-sm">
        <span
          className="mb-5 flex h-[60px] w-[60px] items-center justify-center rounded-full"
          style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
        >
          <MailCheck aria-hidden className="h-[30px] w-[30px]" strokeWidth={2} />
        </span>
        <h3 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          E-Mail ist unterwegs
        </h3>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Wenn ein Konto existiert, haben wir Ihnen einen Anmeldelink geschickt. Bitte öffnen Sie die
          E-Mail auf diesem Gerät und tippen Sie auf den Link. Schauen Sie ggf. auch im Spam-Ordner.
        </p>

        <div
          className="mt-4 flex items-start gap-2.5 rounded-xl border border-[color:var(--pz-line)] p-3.5"
          style={{ backgroundColor: "var(--pz-surface)" }}
        >
          <Clock aria-hidden className="mt-0.5 h-[17px] w-[17px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
          <p className="text-sm" style={{ color: "var(--pz-body)" }}>
            <b style={{ color: "var(--pz-ink)" }}>Nach dem ersten Login bleiben Sie angemeldet.</b> Sie
            müssen sich nicht jedes Mal neu anmelden.
          </p>
        </div>

        <button
          onClick={() => {
            setStatus("idle");
            setEmail("");
            setMinAgeConfirmed(false);
          }}
          className="mt-3.5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--pz-line)] px-4 py-3 text-sm font-semibold"
          style={{ backgroundColor: "var(--pz-surface)", color: "var(--pz-ink)" }}
        >
          <Pencil aria-hidden className="h-4 w-4" strokeWidth={2} /> Andere E-Mail verwenden
        </button>

        <div className="mt-3.5 flex items-start gap-2 text-xs" style={{ color: "var(--pz-muted)" }}>
          <Info aria-hidden className="mt-0.5 h-[14px] w-[14px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
          <span>
            Aus Datenschutzgründen erhalten Sie immer dieselbe Bestätigung — unabhängig davon, ob die
            Adresse bei uns hinterlegt ist.
          </span>
        </div>
      </div>
    );
  }

  // — Anmelde-Screen —
  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-sm space-y-4">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
          E-Mail-Adresse
        </label>
        <div className="flex items-center gap-2.5 rounded-md border border-[color:var(--pz-line)] bg-white px-3 transition-colors focus-within:border-[color:var(--pz-brand)] focus-within:ring-2 focus-within:ring-[color:var(--pz-brand)]/30">
          <Mail aria-hidden className="h-[18px] w-[18px] shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ihre@email.de"
            className="h-12 w-full border-0 bg-transparent text-base outline-none placeholder:text-zinc-400"
            style={{ color: "var(--pz-ink)" }}
          />
        </div>
        <p className="mt-1.5 text-xs" style={{ color: "var(--pz-muted)" }}>
          Wir nutzen Ihre Adresse nur für den Anmeldelink — kein Passwort nötig.
        </p>
      </div>

      <div className="flex items-start gap-3">
        <input
          id="minAge"
          type="checkbox"
          checked={minAgeConfirmed}
          onChange={(e) => setMinAgeConfirmed(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-[color:var(--pz-brand)] accent-[color:var(--pz-brand)] focus:ring-[color:var(--pz-brand)]"
        />
        <label htmlFor="minAge" className="text-sm" style={{ color: "var(--pz-body)" }}>
          Ich bestätige, dass ich mindestens 16 Jahre alt bin. (Erforderlich bei der Erstregistrierung)
        </label>
      </div>

      {status === "error" && <p role="alert" className="text-sm text-red-600">{errorMessage}</p>}

      <button
        type="submit"
        disabled={status === "loading"}
        style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3.5 text-base font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "loading" ? "Sende Link…" : "Anmeldelink senden"}
        {status !== "loading" && <ArrowRight aria-hidden className="h-[18px] w-[18px]" strokeWidth={2} />}
      </button>

      <div className="space-y-2 pt-1">
        <div className="flex items-start gap-2.5 text-xs" style={{ color: "var(--pz-muted)" }}>
          <KeyRound aria-hidden className="mt-0.5 h-[15px] w-[15px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
          <span>Kein Passwort — ein Tipp auf den Link in der E-Mail genügt.</span>
        </div>
        <div className="flex items-start gap-2.5 text-xs" style={{ color: "var(--pz-muted)" }}>
          <ShieldCheck aria-hidden className="mt-0.5 h-[15px] w-[15px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
          <span>Ihre Stimme bleibt anonym; die Anmeldung dient nur dem Schutz vor Mehrfachabstimmung.</span>
        </div>
      </div>

      <p className="text-center text-xs" style={{ color: "var(--pz-muted)" }}>
        <Link href={`/${tenantSlug}/datenschutz`} className="underline hover:opacity-80">
          Datenschutzhinweise
        </Link>
      </p>
    </form>
  );
}
