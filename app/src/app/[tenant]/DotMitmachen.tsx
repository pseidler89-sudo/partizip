"use client";

/**
 * DotMitmachen.tsx — Abstimm-/Ergebnis-UI für Dot-/Budget-Voting (ADR-025).
 *
 * Isoliert vom Ja/Nein-PollMitmachen. Barrierearm (ADR-025): Punkte werden je
 * Option per Stepper/Zahlenfeld verteilt — KEIN Drag&Drop, voll tastatur- und
 * screenreaderbedienbar. Ergebnis = Aggregat-Verteilung (nie ein individuelles
 * Muster), erst nach Ende + ab Mindest-N sichtbar (serverseitig durchgesetzt).
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { dotAbstimmen } from "@/lib/polls/actions";
import type { DotVotingErgebnis } from "@/lib/polls/dot";

const OPEN_LOGIN_EVENT = "pz:open-login";

interface Props {
  pollId: string;
  budget: number;
  optionen: { id: string; label: string }[];
  ergebnis: DotVotingErgebnis;
  tenantSlug: string;
  eingeloggt: boolean;
  verifiziert: boolean;
  verbindlich: boolean;
  bereitsAbgestimmt: boolean;
  demoMode?: boolean;
}

export default function DotMitmachen({
  pollId,
  budget,
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
  const [werte, setWerte] = useState<Record<string, number>>(() =>
    Object.fromEntries(optionen.map((o) => [o.id, 0])),
  );
  const [phase, setPhase] = useState<"frage" | "ergebnis">(bereitsAbgestimmt ? "ergebnis" : "frage");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beleg, setBeleg] = useState<string | null>(null);

  const vergeben = useMemo(() => Object.values(werte).reduce((a, b) => a + b, 0), [werte]);
  const verbleibend = budget - vergeben;

  // Verbindliche Abstimmung ohne Verifizierung: serverseitig gesperrt → Hinweis.
  const gesperrtUnverifiziert = verbindlich && eingeloggt && !verifiziert;
  const kannAbstimmen = eingeloggt && !bereitsAbgestimmt && !gesperrtUnverifiziert && phase === "frage";

  function setWert(id: string, next: number) {
    const clamped = Math.max(0, Math.min(budget, Math.floor(next || 0)));
    setWerte((w) => ({ ...w, [id]: clamped }));
  }

  async function absenden() {
    if (vergeben < 1 || vergeben > budget) return;
    setError(null);
    setSubmitting(true);
    try {
      const allocations = optionen
        .map((o) => ({ optionId: o.id, punkte: werte[o.id] ?? 0 }))
        .filter((a) => a.punkte > 0);
      const res = await dotAbstimmen(pollId, allocations);
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
        <DotErgebnisAnzeige ergebnis={ergebnis} beleg={beleg} />
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
  // Abstimm-Widget (Punkte verteilen)
  // -------------------------------------------------------------------------
  return (
    <div>
      <p className="text-sm" style={{ color: "var(--pz-body)" }}>
        Verteilen Sie <b style={{ color: "var(--pz-ink)" }}>{budget} Punkte</b> auf die Optionen —
        Sie können alles auf eine Option setzen oder aufteilen.
      </p>
      <p aria-live="polite" className="mt-1 text-sm font-medium" style={{ color: verbleibend < 0 ? "#b91c1c" : "var(--pz-brand-strong)" }}>
        Verbleibend: {verbleibend} von {budget}
      </p>

      <ul className="mt-4 space-y-3">
        {optionen.map((o) => {
          const wert = werte[o.id] ?? 0;
          return (
            <li key={o.id} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-sm" style={{ color: "var(--pz-ink)" }}>{o.label}</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setWert(o.id, wert - 1)}
                  disabled={wert <= 0 || submitting}
                  aria-label={`Ein Punkt weniger für ${o.label}`}
                  className="flex h-8 w-8 items-center justify-center rounded-md border text-lg leading-none disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                  style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                >−</button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={budget}
                  value={wert}
                  disabled={submitting}
                  onChange={(e) => setWert(o.id, Number(e.target.value))}
                  aria-label={`Punkte für ${o.label}`}
                  className="w-14 rounded-md border px-2 py-1.5 text-center text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                  style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                />
                <button
                  type="button"
                  onClick={() => setWert(o.id, wert + 1)}
                  disabled={verbleibend <= 0 || submitting}
                  aria-label={`Ein Punkt mehr für ${o.label}`}
                  className="flex h-8 w-8 items-center justify-center rounded-md border text-lg leading-none disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                  style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                >+</button>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {demoMode && (
        <p className="mt-3 text-xs" style={{ color: "var(--pz-muted)" }}>
          Demo-Vereinfachung: Ihre Stimme wird über ein Wegwerf-Demo-Konto gezählt; im Echtbetrieb per E-Mail-Link.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={absenden}
          disabled={vergeben < 1 || vergeben > budget || submitting}
          className="inline-flex items-center rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
          style={{ backgroundColor: "var(--tenant-primary)" }}
        >
          {submitting ? "…" : "Punkte abgeben"}
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

/** Aggregat-Verteilung + Teilnahme (Top-Level, damit keine Komponente im Render entsteht). */
function DotErgebnisAnzeige({
  ergebnis,
  beleg,
}: {
  ergebnis: DotVotingErgebnis;
  beleg: string | null;
}) {
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
            ? "Die Verteilung wird angezeigt, sobald genügend Personen mitgemacht haben (Schutz kleiner Gruppen)."
            : "Die Verteilung der Punkte wird nach Abstimmungsende angezeigt. Die Teilnahme können Sie schon sehen."}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {ergebnis.optionen.map((o) => (
            <li key={o.optionId}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span style={{ color: "var(--pz-ink)" }}>{o.label}</span>
                <span className="tabular-nums" style={{ color: "var(--pz-muted)" }}>
                  {o.maskiert
                    ? "zum Schutz kleiner Gruppen ausgeblendet"
                    : `${o.punkteSumme} Punkte${o.prozent != null ? ` · ${o.prozent}%` : ""}`}
                </span>
              </div>
              <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--pz-line)" }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${o.prozent ?? 0}%`, backgroundColor: "var(--tenant-primary)" }}
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
          — bewahren Sie ihn auf; er beweist, dass Ihre Stimme zählt, verrät aber nicht, wie Sie verteilt haben.
        </p>
      )}
    </div>
  );
}
