"use client";

/**
 * WiderstandMitmachen.tsx — Abstimm-/Ergebnis-UI für die Widerstandsabfrage /
 * Systemisches Konsensieren (ADR-025).
 *
 * Isoliert vom Ja/Nein-PollMitmachen und DotMitmachen. Barrierearm (ADR-025):
 * je Option ein beschrifteter Slider 0–10 mit sichtbarem Zahlenwert — KEIN
 * Drag&Drop-Zwang, voll tastatur- und screenreaderbedienbar (range = Pfeiltasten).
 * Vollständige Abgabe: ALLE Optionen werden mitgesendet (Default 0 = „keine
 * Einwände" ist eine legitime Aussage — keine Pflicht-Interaktion je Slider).
 * Ergebnis = Aggregat (Gesamtwiderstand + Ø je Option), erst nach Ende + ab
 * Mindest-N sichtbar (serverseitig durchgesetzt); geringster Widerstand gewinnt.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { widerstandAbstimmen } from "@/lib/polls/actions";
import type { WiderstandsErgebnis } from "@/lib/polls/widerstand";

const OPEN_LOGIN_EVENT = "pz:open-login";

interface Props {
  pollId: string;
  optionen: { id: string; label: string }[];
  ergebnis: WiderstandsErgebnis;
  tenantSlug: string;
  eingeloggt: boolean;
  verifiziert: boolean;
  verbindlich: boolean;
  bereitsAbgestimmt: boolean;
  demoMode?: boolean;
}

/**
 * Sprechende Slider-Ansage für Screenreader (aria-valuetext). Benannt sind NUR
 * die Endpunkte — exakt wie die sichtbare Legende („0 keine Einwände / 10
 * starker Widerstand"), damit sehende und nicht-sehende Nutzer dieselbe
 * Skalen-Semantik bekommen (Gate-B-A11y-Fund: 8–9 klangen sonst wie 10).
 */
function wertAnsage(wert: number): string {
  const endpunkt =
    wert === 0 ? " — keine Einwände" : wert === 10 ? " — starker Widerstand" : "";
  return `Widerstand ${wert} von 10${endpunkt}`;
}

export default function WiderstandMitmachen({
  pollId,
  optionen,
  ergebnis,
  tenantSlug,
  eingeloggt,
  verifiziert,
  verbindlich,
  bereitsAbgestimmt,
  demoMode = false,
}: Props) {
  const router = useRouter();
  // Default 0 je Option = „keine Einwände" — eine legitime, vollständige Abgabe.
  const [werte, setWerte] = useState<Record<string, number>>(() =>
    Object.fromEntries(optionen.map((o) => [o.id, 0])),
  );
  const [phase, setPhase] = useState<"frage" | "ergebnis">(bereitsAbgestimmt ? "ergebnis" : "frage");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beleg, setBeleg] = useState<string | null>(null);

  // Verbindliche Abstimmung ohne Verifizierung: serverseitig gesperrt → Hinweis.
  const gesperrtUnverifiziert = verbindlich && eingeloggt && !verifiziert;
  const kannAbstimmen = eingeloggt && !bereitsAbgestimmt && !gesperrtUnverifiziert && phase === "frage";

  async function absenden() {
    setError(null);
    setSubmitting(true);
    try {
      // Vollständige Abgabe: ALLE Optionen mitsenden (auch wert=0).
      const abgabe = optionen.map((o) => ({ optionId: o.id, wert: werte[o.id] ?? 0 }));
      const res = await widerstandAbstimmen(pollId, abgabe);
      if (res.needLogin) {
        window.dispatchEvent(new Event(OPEN_LOGIN_EVENT));
        return;
      }
      if (!res.ok) {
        setError(res.error ?? "Die Abstimmung ist fehlgeschlagen.");
        return;
      }
      if (res.beleg) setBeleg(res.beleg);
      setPhase("ergebnis");
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Nicht mitstimm-berechtigt → nur Ergebnis
  // -------------------------------------------------------------------------
  if (!kannAbstimmen) {
    return (
      <div>
        {gesperrtUnverifiziert && (
          <p className="mb-3 rounded-lg p-3 text-sm" style={{ backgroundColor: "var(--pz-warning-soft, #fff7ed)", color: "var(--pz-ink)" }}>
            Diese verbindliche Abstimmung ist wohnsitz-verifizierten Bürger:innen vorbehalten.
          </p>
        )}
        <WiderstandsErgebnisAnzeige ergebnis={ergebnis} beleg={beleg} />
        {!eingeloggt && (
          <div className="mt-5 border-t border-[color:var(--pz-line)] pt-5 text-center">
            <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>Möchten Sie mitstimmen?</p>
            <p className="mx-auto mt-1 max-w-sm text-xs" style={{ color: "var(--pz-muted)" }}>
              Mitstimmen geht nur mit Konto (E-Mail-Link, ohne Passwort). Das Ergebnis wird nach Ende für alle sichtbar.
            </p>
            <Link
              href={`/${tenantSlug}/anmelden`}
              onClick={(e) => { e.preventDefault(); window.dispatchEvent(new Event(OPEN_LOGIN_EVENT)); }}
              className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
              style={{ backgroundColor: "var(--tenant-primary)" }}
            >
              Zum Mitstimmen anmelden
            </Link>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Abstimm-Widget (Widerstandswerte vergeben)
  // -------------------------------------------------------------------------
  return (
    <div>
      <p className="text-sm" style={{ color: "var(--pz-body)" }}>
        Geben Sie für jede Option an, wie stark Ihr Widerstand ist —{" "}
        <b style={{ color: "var(--pz-ink)" }}>0 = keine Einwände, 10 = starker Widerstand</b>.
        Es gewinnt die Option mit dem geringsten Gesamtwiderstand.
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
        Skala: 0 keine Einwände / 10 starker Widerstand
      </p>

      <ul className="mt-4 space-y-4">
        {optionen.map((o) => {
          const wert = werte[o.id] ?? 0;
          const sliderId = `widerstand-${o.id}`;
          return (
            <li key={o.id}>
              <label htmlFor={sliderId} className="text-sm" style={{ color: "var(--pz-ink)" }}>
                {o.label}
              </label>
              <div className="mt-1 flex items-center gap-3">
                <input
                  id={sliderId}
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={wert}
                  disabled={submitting}
                  onChange={(e) => setWerte((w) => ({ ...w, [o.id]: Number(e.target.value) }))}
                  aria-label={`Widerstand für ${o.label}`}
                  aria-valuetext={wertAnsage(wert)}
                  className="w-full accent-[color:var(--tenant-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                />
                {/* Sichtbarer Zahlenwert neben dem Slider (output-artig). */}
                <span className="w-14 shrink-0 text-right text-sm tabular-nums" style={{ color: "var(--pz-ink)" }}>
                  {wert} / 10
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {/* role="alert": Screenreader erfahren die Ablehnung sofort (ADR-025). */}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {demoMode && (
        <p className="mt-3 text-xs" style={{ color: "var(--pz-muted)" }}>
          Demo-Vereinfachung: Ihre Stimme wird über ein Wegwerf-Demo-Konto gezählt; im Echtbetrieb per E-Mail-Link.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {/* Direkt aktiv: 0 überall ist eine gültige, vollständige Abgabe —
            keine Pflicht-Interaktion je Slider. */}
        <button
          type="button"
          onClick={absenden}
          disabled={submitting}
          className="inline-flex items-center rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
          style={{ backgroundColor: "var(--tenant-primary)" }}
        >
          {submitting ? "…" : "Bewertung abgeben"}
        </button>
        <button
          type="button"
          onClick={() => setPhase("ergebnis")}
          className="text-sm underline-offset-4 hover:underline"
          style={{ color: "var(--pz-muted)" }}
        >
          Nur Ergebnis ansehen
        </button>
      </div>
    </div>
  );
}

/** Aggregat + Teilnahme (Top-Level, damit keine Komponente im Render entsteht). */
function WiderstandsErgebnisAnzeige({
  ergebnis,
  beleg,
}: {
  ergebnis: WiderstandsErgebnis;
  beleg: string | null;
}) {
  // Balken relativ zur größten Summe (größter Widerstand = voller Balken);
  // maxSumme 0 (überall „keine Einwände") → alle Balken leer.
  const maxSumme = Math.max(0, ...ergebnis.optionen.map((o) => o.widerstandsSumme ?? 0));
  return (
    <div>
      <p className="text-sm" style={{ color: "var(--pz-body)" }}>
        {ergebnis.gesamtWaehler}{" "}
        {ergebnis.gesamtWaehler === 1 ? "Teilnehmende:r" : "Teilnehmende"}
        {ergebnis.verifizierteWaehler > 0 && (
          <span style={{ color: "var(--pz-muted)" }}> · davon {ergebnis.verifizierteWaehler} verifiziert</span>
        )}
      </p>

      {ergebnis.aufschluesselungZurueckgehalten ? (
        <p className="mt-3 rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: "var(--pz-line)", color: "var(--pz-muted)" }}>
          {ergebnis.zurueckhaltungsGrund === "zu_wenige_teilnehmende"
            ? // Tritt nur NACH Abstimmungsende auf — kein „sobald genügend
              // mitmachen"-Versprechen, das niemand mehr einlösen kann (Gate-B).
              "Es haben zu wenige Personen teilgenommen — die Auswertung bleibt zum Schutz kleiner Gruppen ausgeblendet."
            : "Die Auswertung wird nach Abstimmungsende angezeigt. Die Teilnahme können Sie schon sehen."}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {ergebnis.optionen.map((o) => (
            <li key={o.optionId}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0" style={{ color: "var(--pz-ink)" }}>
                  {o.label}
                  {o.geringsterWiderstand && (
                    <span className="pz-badge-success ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium align-middle">
                      Geringster Widerstand
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--pz-muted)" }}>
                  {o.maskiert ? (
                    "zum Schutz kleiner Gruppen ausgeblendet"
                  ) : (
                    <>Gesamtwiderstand {o.widerstandsSumme} · Ø {o.mittelwert}</>
                  )}
                </span>
              </div>
              <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--pz-neutral-soft)" }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${maxSumme > 0 ? ((o.widerstandsSumme ?? 0) / maxSumme) * 100 : 0}%`,
                    // Gewinner (geringster Widerstand) in Tenant-Farbe, Rest neutral —
                    // der Balken misst Widerstand, nicht Zustimmung.
                    backgroundColor: o.geringsterWiderstand ? "var(--tenant-primary)" : "var(--pz-muted)",
                  }}
                  aria-hidden
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {beleg && (
        <p className="mt-4 rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: "var(--pz-line)", color: "var(--pz-body)" }}>
          Ihr Beleg-Code: <span className="font-mono font-semibold" style={{ color: "var(--pz-ink)" }}>{beleg}</span>{" "}
          — bewahren Sie ihn auf; er beweist, dass Ihre Stimme zählt, verrät aber nicht, wie Sie bewertet haben.
        </p>
      )}
    </div>
  );
}
