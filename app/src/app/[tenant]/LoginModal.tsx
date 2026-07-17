"use client";

/**
 * LoginModal.tsx — globales Login-Overlay (ADR-017).
 *
 * Ersetzt den fragilen `#anmelden`-Anker: öffnet von JEDER Seite dasselbe
 * LoginForm, ohne Seitenwechsel und ohne Kontextverlust. Mobil als Bottom-Sheet,
 * Desktop zentriert. role=dialog + Focus-Trap + Esc + Backdrop-Klick; gibt den
 * Fokus beim Schließen an das auslösende Element zurück. Die /anmelden-Seite
 * bleibt als Deep-Link-/no-JS-Fallback erhalten.
 */

import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { BrandMark } from "@/components/BrandMark";
import { LoginForm } from "./LoginForm";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function LoginModal({
  tenantSlug,
  open,
  onClose,
}: {
  tenantSlug: string;
  open: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  // Fokus beim Öffnen ins Panel (erstes Feld), Body-Scroll sperren, Fokus zurück.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const firstField = panel?.querySelector<HTMLElement>(FOCUSABLE);
    firstField?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  // Portal an document.body: der Header hat backdrop-blur → das erzeugt einen
  // Containing-Block für position:fixed; ohne Portal wäre das Overlay auf die ~60px
  // hohe Kopfzeile geklemmt (nur der obere Rand sichtbar). Im Body bezieht sich
  // fixed wieder aufs gesamte Fenster.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50" aria-hidden={false}>
      {/* Backdrop als vollflächiger Schließen-Button → interaktiv + tastaturbedienbar
          (kein onClick auf nicht-interaktivem Element). */}
      <button
        type="button"
        aria-label="Dialog schließen"
        tabIndex={-1}
        className="fixed inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
      />
      {/* Scroll-Schicht: das GESAMTE Overlay scrollt (nicht nur das Panel) — so bleibt
          der Schließen-Knopf bei jeder Inhalts-/Viewport-Höhe erreichbar (Fix gegen
          „oben abgeschnitten / nicht schließbar"). pointer-events-none lässt Klicks auf
          leere Flächen zum Backdrop durch; nur das Panel ist wieder klickbar. */}
      <div className="pointer-events-none fixed inset-0 overflow-y-auto overscroll-contain">
        <div className="flex min-h-full items-end justify-center p-0 sm:items-center sm:p-4">
          {/* Panel (mobil Bottom-Sheet, Desktop zentriert). onKeyDown am dialog-Container
              ist der kanonische Modal-Focus-Trap (Esc + Tab-Zyklus) — die Regel ist hier
              ein bekannter False-Positive (role="dialog" gilt ihr als nicht-interaktiv). */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-modal-title"
            onKeyDown={handleKeyDown}
            className="pointer-events-auto relative w-full max-w-md rounded-t-2xl bg-pz-surface shadow-xl sm:rounded-2xl"
          >
            {/* Sticky-Kopf: Titel + Schließen bleiben sichtbar, egal wie weit gescrollt. */}
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-2xl border-b border-[color:var(--pz-line)] bg-pz-surface px-6 pb-4 pt-5">
              <div className="flex items-start gap-2.5">
                {/* Bildzeichen: verortet den Dialog als Partizip (bleibt Teal). */}
                <BrandMark className="mt-0.5 h-6 w-6 shrink-0" />
                <div>
                  <h2 id="login-modal-title" className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
                    Anmelden
                  </h2>
                  <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
                    Per E-Mail-Link, ohne Passwort. Mit Konto stimmen Sie mit.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Schließen"
                className="-mr-1 shrink-0 rounded-md p-1.5 text-pz-muted transition-colors hover:bg-pz-brand-soft hover:text-pz-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              >
                <span aria-hidden className="text-xl leading-none">×</span>
              </button>
            </div>
            <div className="px-6 pb-6 pt-5">
              <LoginForm tenantSlug={tenantSlug} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
