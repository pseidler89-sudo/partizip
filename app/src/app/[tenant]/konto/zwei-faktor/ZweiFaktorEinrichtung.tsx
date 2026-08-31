/**
 * ZweiFaktorEinrichtung.tsx — Ablauf der TOTP-Einrichtung (Client, #59).
 *
 * Drei Schritte in einer Komponente, weil sie einen gemeinsamen Zustand teilen:
 *   1. „start"    — Erklärung + Knopf, ruft starteEinrichtung()
 *   2. „scannen"  — QR-Code, Secret als Text (Geräte ohne Kamera), Code-Eingabe,
 *                   ruft bestaetigeEinrichtung(code)
 *   3. „fertig"   — die zehn Wiederherstellungscodes, EINMALIG sichtbar
 *
 * Der QR wird HIER im Browser aus dem otpauth-URI gerendert (qrcode-Paket, im
 * Repo sonst serverseitig genutzt): Die Server Action liefert URI und Secret,
 * das Bild ist reine Darstellung derselben Daten — ein zusätzlicher
 * Server-Roundtrip nur fürs PNG brächte keinen Sicherheitsgewinn. Schlägt das
 * Rendern fehl, bleibt der Klartext-Schlüssel als vollwertiger Weg stehen.
 *
 * Weder Secret noch Codes werden geloggt oder irgendwo zwischengespeichert.
 */

"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { ShieldCheck, Copy, Download, KeyRound } from "lucide-react";
import { starteEinrichtung, bestaetigeEinrichtung } from "@/lib/auth/totp-actions";

type Schritt =
  | { phase: "start" }
  | { phase: "scannen"; secret: string; qrDataUrl?: string }
  | { phase: "fertig"; codes: string[] };

/** QR aus dem otpauth-URI. Fehler sind nicht tödlich — der Schlüssel steht daneben. */
async function qrAlsDataUrl(uri: string): Promise<string | undefined> {
  try {
    const QRCode = (await import("qrcode")).default;
    return await QRCode.toDataURL(uri, { width: 240, margin: 2 });
  } catch {
    return undefined;
  }
}

/** Base32-Schlüssel in Vierergruppen — deutlich leichter abzutippen. */
function gruppiert(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export default function ZweiFaktorEinrichtung({ tenantSlug }: { tenantSlug: string }) {
  const [schritt, setSchritt] = useState<Schritt>({ phase: "start" });
  const [code, setCode] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);
  const [kopiert, setKopiert] = useState(false);
  const [isPending, startTransition] = useTransition();

  function starten() {
    setFehler(null);
    startTransition(async () => {
      try {
        const r = await starteEinrichtung();
        if (!r.ok) {
          setFehler(r.error);
          return;
        }
        const qrDataUrl = await qrAlsDataUrl(r.uri);
        setSchritt({ phase: "scannen", secret: r.secret, qrDataUrl });
      } catch {
        setFehler("Verbindungsfehler — bitte versuchen Sie es erneut.");
      }
    });
  }

  function bestaetigen(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFehler(null);
    startTransition(async () => {
      try {
        const r = await bestaetigeEinrichtung(code);
        if (!r.ok) {
          setFehler(r.error);
          return;
        }
        setCode("");
        setSchritt({ phase: "fertig", codes: r.wiederherstellungscodes });
      } catch {
        setFehler("Verbindungsfehler — bitte versuchen Sie es erneut.");
      }
    });
  }

  async function kopieren(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2500);
    } catch {
      // Browser ohne Clipboard-API: die Codes stehen sichtbar auf der Seite.
    }
  }

  function herunterladen(codes: string[]) {
    const inhalt = [
      "Partizip — Wiederherstellungscodes für die Zwei-Faktor-Anmeldung",
      `Erstellt am ${new Date().toLocaleDateString("de-DE")}`,
      "",
      ...codes,
      "",
      "Jeder Code lässt sich genau einmal verwenden.",
      "Bewahren Sie diese Datei so sicher auf wie einen Ersatzschlüssel.",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([inhalt], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "partizip-wiederherstellungscodes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  const fehlerZeile = fehler ? (
    <p role="alert" className="mt-3 text-sm" style={{ color: "var(--pz-danger)" }}>
      {fehler}
    </p>
  ) : null;

  // — Schritt 3: Wiederherstellungscodes (einmalig) —
  if (schritt.phase === "fertig") {
    return (
      <div>
        <div className="flex items-start gap-3">
          <ShieldCheck
            aria-hidden
            className="mt-0.5 h-5 w-5 shrink-0"
            style={{ color: "var(--pz-success)" }}
            strokeWidth={2}
          />
          <div>
            <p className="text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
              Zwei-Faktor-Anmeldung ist jetzt aktiv
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
              Ab sofort fragen wir bei der Anmeldung nach dem Code aus Ihrer App.
            </p>
          </div>
        </div>

        <div
          className="mt-5 rounded-xl p-4 text-sm"
          style={{ backgroundColor: "var(--pz-warning-soft)", color: "var(--pz-warning-ink)" }}
        >
          <p className="font-semibold">Diese zehn Codes sehen Sie nur jetzt.</p>
          <p className="mt-1">
            Sie sind Ihr Ersatzweg, falls Sie Ihr Telefon verlieren. Speichern oder drucken Sie
            sie, bevor Sie diese Seite verlassen — danach lassen sie sich nicht erneut anzeigen.
            Jeder Code funktioniert genau einmal.
          </p>
        </div>

        <ul
          className="mt-4 grid grid-cols-1 gap-2 rounded-xl border p-4 sm:grid-cols-2"
          style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-surface)" }}
        >
          {schritt.codes.map((c) => (
            <li
              key={c}
              className="select-all text-center font-mono text-base tracking-wider"
              style={{ color: "var(--pz-ink)" }}
            >
              {c}
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => herunterladen(schritt.codes)}
            className="pz-btn pz-btn-primary"
          >
            <Download aria-hidden className="mr-1.5 h-4 w-4" strokeWidth={2} />
            Als Textdatei speichern
          </button>
          <button
            type="button"
            onClick={() => void kopieren(schritt.codes)}
            className="pz-btn pz-btn-secondary"
          >
            <Copy aria-hidden className="mr-1.5 h-4 w-4" strokeWidth={2} />
            {kopiert ? "Kopiert" : "Codes kopieren"}
          </button>
        </div>
        <p aria-live="polite" className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
          {kopiert ? "Die Codes liegen in der Zwischenablage." : ""}
        </p>

        <p className="mt-5 text-sm">
          <Link href={`/${tenantSlug}/konto`} style={{ color: "var(--pz-brand-strong)" }}>
            Ich habe die Codes gesichert — zurück zum Konto
          </Link>
        </p>
      </div>
    );
  }

  // — Schritt 2: QR scannen und ersten Code bestätigen —
  if (schritt.phase === "scannen") {
    return (
      <div>
        <p className="text-sm" style={{ color: "var(--pz-body)" }}>
          Scannen Sie den QR-Code mit Ihrer Authenticator-App (z. B. Aegis, FreeOTP, Google
          Authenticator) und geben Sie danach den angezeigten sechsstelligen Code ein.
        </p>

        {schritt.qrDataUrl && (
          <div className="mt-4 flex justify-center">
            <Image
              src={schritt.qrDataUrl}
              alt="QR-Code zur Einrichtung Ihrer Authenticator-App"
              width={240}
              height={240}
              unoptimized
              className="rounded-md bg-white p-2"
            />
          </div>
        )}

        <div
          className="mt-4 rounded-lg border border-dashed p-3 text-center"
          style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-brand-soft)" }}
        >
          <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
            Kein Scanner zur Hand? Geben Sie diesen Schlüssel in Ihrer App von Hand ein:
          </p>
          <p
            className="mt-1 select-all break-all font-mono text-sm font-medium"
            style={{ color: "var(--pz-ink)" }}
          >
            {gruppiert(schritt.secret)}
          </p>
        </div>

        <form onSubmit={bestaetigen} className="mt-5">
          <label
            htmlFor="totp-einrichtung-code"
            className="mb-1.5 block text-sm font-medium"
            style={{ color: "var(--pz-ink)" }}
          >
            Sechsstelliger Code aus Ihrer App
          </label>
          <input
            id="totp-einrichtung-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            className="h-12 w-full max-w-[12rem] rounded-md border border-[color:var(--pz-line)] bg-pz-surface px-3 text-center font-mono text-xl tracking-[0.3em] outline-none focus:border-[color:var(--pz-brand)] focus:ring-2 focus:ring-[color:var(--pz-brand)]/30"
            style={{ color: "var(--pz-ink)" }}
          />
          {fehlerZeile}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={isPending || code.length !== 6}
              className="pz-btn pz-btn-primary"
            >
              {isPending ? "Wird geprüft …" : "Bestätigen"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCode("");
                setFehler(null);
                setSchritt({ phase: "start" });
              }}
              className="pz-btn pz-btn-secondary"
            >
              Abbrechen
            </button>
          </div>
        </form>
      </div>
    );
  }

  // — Schritt 1: Erklärung + Start —
  return (
    <div>
      <div className="flex items-start gap-3">
        <KeyRound
          aria-hidden
          className="mt-0.5 h-5 w-5 shrink-0"
          style={{ color: "var(--pz-brand-strong)" }}
          strokeWidth={2}
        />
        <div>
          <p className="text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
            Noch nicht eingerichtet
          </p>
          <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
            Sie brauchen eine Authenticator-App auf Ihrem Telefon. Beim Start zeigen wir Ihnen
            einen QR-Code; Ihre App erzeugt daraus alle 30 Sekunden einen neuen sechsstelligen
            Code. Zum Schluss erhalten Sie zehn Wiederherstellungscodes für den Fall, dass das
            Telefon abhandenkommt.
          </p>
        </div>
      </div>
      {fehlerZeile}
      <button
        type="button"
        onClick={starten}
        disabled={isPending}
        className="pz-btn pz-btn-primary mt-4"
      >
        {isPending ? "Einen Moment …" : "Einrichtung starten"}
      </button>
    </div>
  );
}
