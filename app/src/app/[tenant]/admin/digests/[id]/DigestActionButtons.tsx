/**
 * DigestActionButtons.tsx — Client-Komponente für Freigabe- und Prüf-Aktionen (M7 + Prüf-Gate)
 *
 * Drei Verwendungsmodi:
 *   1. showNurAlleGeprueftButton=true: zeigt nur den „Alle als geprüft markieren"-Button (Fortschritts-Box)
 *   2. statementId gesetzt: zeigt Prüf- und Highlight-Toggles für eine einzelne Aussage
 *   3. Standard: zeigt Freigabe-/Veröffentlichen-Button mit Hinweis wenn nicht alle geprüft
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  freigeben,
  veroeffentlichen,
  setStatementGeprueft,
  setAlleStatementsGeprueft,
  setStatementHighlight,
} from "@/lib/digest/actions";

interface Props {
  digestId: string;
  status: string;
  tenantSlug: string;
  alleGeprueft: boolean;
  geprueftAnzahl: number;
  gesamtAnzahl: number;
  showNurAlleGeprueftButton: boolean;
  // H1: darf der aktuelle Nutzer freigeben/veröffentlichen? (Redakteur: false)
  canFreigeben?: boolean;
  // Für Statement-Toggles (Modus 2)
  statementId?: string;
  statementGeprueft?: boolean;
  statementGeprueftAt?: string | null;
  statementHighlight?: boolean;
}

export function DigestActionButtons({
  digestId,
  status,
  tenantSlug: _tenantSlug,
  alleGeprueft,
  geprueftAnzahl,
  gesamtAnzahl,
  showNurAlleGeprueftButton,
  canFreigeben = true,
  statementId,
  statementGeprueft,
  statementGeprueftAt: _statementGeprueftAt,
  statementHighlight,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // ---------------------------------------------------------------------------
  // Modus 2: Statement-Toggles (Prüfen + Highlight)
  // ---------------------------------------------------------------------------
  if (statementId !== undefined) {
    async function handleToggleGeprueft() {
      setError(null);
      startTransition(async () => {
        const result = await setStatementGeprueft(statementId!, !(statementGeprueft ?? false));
        if (result.ok) {
          router.refresh();
        } else {
          setError(result.error ?? "Unbekannter Fehler");
        }
      });
    }

    async function handleToggleHighlight() {
      setError(null);
      startTransition(async () => {
        const result = await setStatementHighlight(statementId!, !(statementHighlight ?? false));
        if (result.ok) {
          router.refresh();
        } else {
          setError(result.error ?? "Unbekannter Fehler");
        }
      });
    }

    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={handleToggleGeprueft}
          disabled={isPending}
          title={statementGeprueft ? "Als ungeprüft markieren" : "Als quellen-geprüft markieren"}
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            statementGeprueft
              ? "bg-green-100 text-green-800 hover:bg-green-200"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
          }`}
        >
          ✓ {statementGeprueft ? "Geprüft" : "Prüfen"}
        </button>
        <button
          onClick={handleToggleHighlight}
          disabled={isPending}
          title={statementHighlight ? "Highlight entfernen" : "Als Highlight markieren"}
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            statementHighlight
              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
          }`}
        >
          {statementHighlight ? "★ Highlight" : "☆ Als Highlight"}
        </button>
        {error && <span className="text-xs text-red-600 ml-1">{error}</span>}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Modus 1: Nur „Alle als geprüft markieren"-Button (Fortschritts-Box)
  // ---------------------------------------------------------------------------
  if (showNurAlleGeprueftButton) {
    if (status !== "entwurf") return null;

    async function handleAlleGeprueft() {
      setError(null);
      startTransition(async () => {
        const result = await setAlleStatementsGeprueft(digestId);
        if (result.ok) {
          router.refresh();
        } else {
          setError(result.error ?? "Unbekannter Fehler");
        }
      });
    }

    return (
      <div className="flex items-center gap-2">
        {!alleGeprueft && (
          <button
            onClick={handleAlleGeprueft}
            disabled={isPending}
            className="rounded-md bg-zinc-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors"
          >
            {isPending ? "Wird gespeichert…" : "Alle als geprüft markieren"}
          </button>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Modus 3: Freigabe-/Veröffentlichen-Button (Standard)
  // ---------------------------------------------------------------------------
  async function handleFreigeben() {
    setError(null);
    startTransition(async () => {
      const result = await freigeben(digestId);
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.error ?? "Unbekannter Fehler");
      }
    });
  }

  async function handleVeroeffentlichen() {
    setError(null);
    startTransition(async () => {
      const result = await veroeffentlichen(digestId);
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.error ?? "Unbekannter Fehler");
      }
    });
  }

  if (status === "veroeffentlicht") {
    return (
      <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-800">
        Dieser Digest ist veröffentlicht.
      </div>
    );
  }

  // H1: Redakteure dürfen prüfen/markieren, aber nicht freigeben/veröffentlichen.
  if (!canFreigeben) {
    return (
      <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3 text-sm text-zinc-600">
        Als Redakteur:in kannst du Aussagen quellen-prüfen und als Highlight markieren.
        Die <strong>Freigabe und Veröffentlichung</strong> übernimmt ein:e Administrator:in
        (Vier-Augen-Prinzip).
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {status === "entwurf" && (
        <>
          <button
            onClick={handleFreigeben}
            disabled={isPending || !alleGeprueft}
            title={
              !alleGeprueft
                ? `Freigabe erst möglich, wenn alle Aussagen geprüft sind (${geprueftAnzahl} von ${gesamtAnzahl} geprüft)`
                : "Digest freigeben"
            }
            className="rounded-md bg-[color:var(--pz-brand)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--pz-brand-strong)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? "Wird gespeichert…" : "Freigeben"}
          </button>
          {!alleGeprueft && gesamtAnzahl > 0 && (
            <p className="text-xs text-amber-700">
              Freigabe erst möglich, wenn alle Aussagen quellen-geprüft sind ({geprueftAnzahl} von {gesamtAnzahl} geprüft).
            </p>
          )}
        </>
      )}

      {status === "freigegeben" && (
        <button
          onClick={handleVeroeffentlichen}
          disabled={isPending}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Wird gespeichert…" : "Veröffentlichen"}
        </button>
      )}

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
