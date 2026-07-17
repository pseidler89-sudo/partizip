"use client";

/**
 * BestaetigungsDialog — generische, barrierefreie Bestätigung vor irreversiblen
 * 1-Klick-Aktionen (Block E). Ein Klick auf „Schließen"/„Veröffentlichen"/
 * „Entziehen" ist oft nicht rückgängig zu machen (bzw. feuert Benachrichtigungen/
 * Kanal-Posts) — der Dialog macht die Folge sichtbar und verlangt eine bewusste
 * zweite Handlung. Das ist zugleich die Grundlage dafür, dass im Demo-Verwaltungs-
 * Track „keine Fehler passieren" (siehe Onboarding-Spec).
 *
 * Barrierefreiheit (WCAG 2.1 AA, a11y-Gate):
 *   - role="dialog" aria-modal, aria-labelledby/-describedby.
 *   - Fokus wandert beim Öffnen in den Dialog (Standard: Abbrechen — die sichere
 *     Wahl), Fokus-Falle hält Tab im Dialog, Escape bricht ab.
 *   - Fokus kehrt beim Schließen auf das auslösende Element zurück.
 *   - Hintergrund-Scroll gesperrt, Backdrop-Klick = Abbrechen.
 *
 * Optional: `tippBestaetigung` verlangt zusätzlich das Eintippen eines Wortes
 * (wie die Konto-Löschung) — für die schwersten Aktionen.
 */

import { useEffect, useId, useRef, useState } from "react";

type Variante = "gefahr" | "normal";

interface Props {
  offen: boolean;
  titel: string;
  beschreibung?: React.ReactNode;
  bestaetigenLabel: string;
  abbrechenLabel?: string;
  variante?: Variante;
  busy?: boolean;
  /** Wenn gesetzt: Bestätigen erst aktiv, wenn genau dieses Wort getippt wurde. */
  tippBestaetigung?: string;
  onBestaetigen: () => void;
  onAbbrechen: () => void;
}

export default function BestaetigungsDialog({
  offen,
  titel,
  beschreibung,
  bestaetigenLabel,
  abbrechenLabel = "Abbrechen",
  variante = "gefahr",
  busy = false,
  tippBestaetigung,
  onBestaetigen,
  onAbbrechen,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const abbrechenRef = useRef<HTMLButtonElement>(null);
  const zuvorFokussiert = useRef<HTMLElement | null>(null);
  const titelId = useId();
  const beschreibungId = useId();
  const [tippwert, setTippwert] = useState("");
  const [warOffen, setWarOffen] = useState(offen);

  // Reset des Tipp-Feldes beim Öffnen — als guarded State-Update während des
  // Renderns (React-empfohlenes Muster ggü. setState-im-Effect).
  if (offen !== warOffen) {
    setWarOffen(offen);
    if (offen) setTippwert("");
  }

  // Fokus-Management + Body-Scroll-Sperre beim Öffnen/Schließen.
  useEffect(() => {
    if (!offen) return;
    zuvorFokussiert.current = document.activeElement as HTMLElement | null;
    // Standard-Fokus auf „Abbrechen" (sichere Wahl), nicht auf die Gefahr-Aktion.
    const t = window.setTimeout(() => abbrechenRef.current?.focus(), 0);
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = bodyOverflow;
      // Fokus zurück auf das auslösende Element.
      zuvorFokussiert.current?.focus?.();
    };
  }, [offen]);

  if (!offen) return null;

  const tippOk = !tippBestaetigung || tippwert.trim() === tippBestaetigung;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!busy) onAbbrechen();
      return;
    }
    if (e.key !== "Tab") return;
    // Fokus-Falle: Tab zirkuliert nur innerhalb des Panels.
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    // Während der Aktion (busy) sind alle Buttons disabled → 0 fokussierbare
    // Elemente. Fokus trotzdem im Dialog halten, nicht in den (nur scroll-
    // gesperrten) Hintergrund entkommen lassen (Gate-B a11y-MINOR).
    if (!focusable || focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const erstes = focusable[0];
    const letztes = focusable[focusable.length - 1];
    const aktiv = document.activeElement;
    if (e.shiftKey && aktiv === erstes) {
      e.preventDefault();
      letztes.focus();
    } else if (!e.shiftKey && aktiv === letztes) {
      e.preventDefault();
      erstes.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-[2px] sm:items-center"
      onMouseDown={(e) => {
        // Backdrop-Klick (nur direkt auf das Overlay, nicht aufs Panel) = Abbrechen.
        if (e.target === e.currentTarget && !busy) onAbbrechen();
      }}
      onKeyDown={onKeyDown}
    >
      {/* Entrance-Animation via tw-animate-css; prefers-reduced-motion nullt
          Animationen global (globals.css). Dialog-Schatten = Elevation 4. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titelId}
        aria-describedby={beschreibung ? beschreibungId : undefined}
        className="pz-card animate-in fade-in zoom-in-95 w-full max-w-md p-6 duration-150"
        style={{ boxShadow: "var(--pz-shadow-4)" }}
      >
        <h2 id={titelId} className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          {titel}
        </h2>
        {beschreibung && (
          <div id={beschreibungId} className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
            {beschreibung}
          </div>
        )}

        {tippBestaetigung && (
          <div className="mt-4">
            <label htmlFor={`${titelId}-tipp`} className="block text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
              Zur Bestätigung <span className="font-mono">{tippBestaetigung}</span> eingeben
            </label>
            <input
              id={`${titelId}-tipp`}
              type="text"
              autoComplete="off"
              value={tippwert}
              onChange={(e) => setTippwert(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
            />
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={abbrechenRef}
            type="button"
            disabled={busy}
            onClick={onAbbrechen}
            className="pz-btn pz-btn-secondary"
          >
            {abbrechenLabel}
          </button>
          <button
            type="button"
            disabled={busy || !tippOk}
            onClick={onBestaetigen}
            className={`pz-btn ${variante === "gefahr" ? "pz-btn-danger" : "pz-btn-primary"}`}
          >
            {busy ? "…" : bestaetigenLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
