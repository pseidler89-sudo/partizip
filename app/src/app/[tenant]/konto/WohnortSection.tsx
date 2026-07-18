/**
 * WohnortSection.tsx — Wohnort im Konto anzeigen und ändern (Block J2c, Teil B).
 *
 * Zwei klar getrennte Begriffe:
 *   1. Anzeige-Wohnort (home_region_id) — weich, frei setzbar; bestimmt, WELCHE
 *      Umfragen Sie sehen. Änderbar über die bestehenden, getesteten Region-
 *      Actions (RegionEinstieg variante="eingeloggt" schreibt home_region_id;
 *      Ortsteil-Dropdown via ortsteilSetzen; Zurücksetzen via
 *      wohnortAnzeigeZuruecksetzen).
 *   2. Verbindlicher Wohnsitz (residency_region_id) — HART, nur per QR/Verwaltung.
 *      Hier NUR schreibgeschützt angezeigt; diese Komponente schreibt ihn NIEMALS
 *      (BINDENDE INVARIANTE, ADR-024 / gebiet.ts).
 *
 * Tonalität „Sie"; Design-Profil (pz-card).
 */

"use client";

import { useState, useTransition } from "react";
import { RegionEinstieg } from "../RegionEinstieg";
import { ortsteilSetzen, wohnortAnzeigeZuruecksetzen } from "@/lib/region/actions";
import type { OrtsteilOption } from "@/lib/region/queries";

export function WohnortSection({
  tenantName,
  homeRegionPfad,
  residencyRegionPfad,
  residencyVerifiedUntil,
  ortsteilOptionen,
  homeOrtsteilCode,
  onChanged,
}: {
  tenantName: string;
  homeRegionPfad: string | null;
  residencyRegionPfad: string | null;
  residencyVerifiedUntil: string | null;
  ortsteilOptionen: OrtsteilOption[];
  homeOrtsteilCode: string | null;
  /** Nach jeder Änderung /api/me neu laden (die Konto-Seite holt ihre Daten selbst). */
  onChanged: () => void;
}) {
  const [aendern, setAendern] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleOrtsteilChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const code = e.target.value || null;
    startTransition(async () => {
      await ortsteilSetzen(code);
      onChanged();
    });
  }

  function handleZuruecksetzen() {
    startTransition(async () => {
      await wohnortAnzeigeZuruecksetzen();
      onChanged();
    });
  }

  const bisFormatiert = residencyVerifiedUntil
    ? new Date(residencyVerifiedUntil).toLocaleDateString("de-DE", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--pz-ink)" }}>
        Wohnort
      </h2>
      <div className="pz-card p-4 space-y-4 text-sm">
        {/* Anzeige-Wohnort (home_region_id) */}
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium" style={{ color: "var(--pz-ink)" }}>
                Anzeige-Wohnort
              </p>
              <p className="mt-0.5" style={{ color: "var(--pz-body)" }}>
                {homeRegionPfad ?? "Noch nicht gesetzt"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAendern((v) => !v)}
              className="shrink-0 text-xs font-medium underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              style={{ color: "var(--pz-brand-strong)" }}
              aria-expanded={aendern}
            >
              {aendern ? "Schließen" : "Ändern"}
            </button>
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            Der Anzeige-Wohnort bestimmt, welche Umfragen Sie sehen. Sie können ihn
            jederzeit frei ändern.
          </p>

          {aendern && (
            <div className="mt-3 rounded-lg border border-[color:var(--pz-line)] bg-pz-surface p-3">
              <RegionEinstieg
                tenantName={tenantName}
                variante="eingeloggt"
                onErfolg={onChanged}
              />

              {/* Ortsteil verfeinern — nur, wenn die Gemeinde Ortsteile hat. Schreibt
                  über ortsteilSetzen ausschließlich home_region_id (+ Cookie). */}
              {ortsteilOptionen.length > 0 && (
                <label className="mt-3 block">
                  <span className="text-xs font-medium" style={{ color: "var(--pz-ink)" }}>
                    Ortsteil
                  </span>
                  <select
                    value={homeOrtsteilCode ?? ""}
                    onChange={handleOrtsteilChange}
                    disabled={pending}
                    className="mt-1 w-full rounded-md border border-[color:var(--pz-line)] bg-pz-surface px-2 py-1.5 text-sm disabled:opacity-60"
                    style={{ color: "var(--pz-ink)" }}
                  >
                    <option value="">Ganze Kommune</option>
                    {ortsteilOptionen.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {homeRegionPfad && (
                <button
                  type="button"
                  onClick={handleZuruecksetzen}
                  disabled={pending}
                  className="mt-3 text-xs underline-offset-4 hover:underline disabled:opacity-60"
                  style={{ color: "var(--pz-muted)" }}
                >
                  Anzeige-Wohnort zurücksetzen
                </button>
              )}
            </div>
          )}
        </div>

        {/* Verbindlicher Wohnsitz (residency_region_id) — schreibgeschützt. */}
        <div className="border-t border-pz-line pt-4">
          <p className="font-medium" style={{ color: "var(--pz-ink)" }}>
            Verbindlicher Wohnsitz
          </p>
          {residencyRegionPfad ? (
            <>
              <p className="mt-0.5" style={{ color: "var(--pz-body)" }}>
                Wohnsitz verifiziert für {residencyRegionPfad}
              </p>
              {bisFormatiert && (
                <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                  Verifiziert bis {bisFormatiert}
                </p>
              )}
            </>
          ) : (
            <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
              Noch nicht per QR-Code verifiziert.
            </p>
          )}
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            Der verbindliche Wohnsitz bestimmt, wo Ihre <strong>verbindliche</strong>{" "}
            Stimme zählt. Er ist nur über einen QR-Code Ihrer Kommune änderbar — nicht
            hier im Konto.
          </p>
        </div>
      </div>
    </section>
  );
}
