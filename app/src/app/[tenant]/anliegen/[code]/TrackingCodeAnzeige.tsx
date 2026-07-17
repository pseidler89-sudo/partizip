/**
 * TrackingCodeAnzeige.tsx — Client-Komponente für prominente Code-Anzeige
 * bei ?neu=1 (direkt nach Einreichung)
 *
 * Zeigt: großer monospaced Code-Block, Copy-Button, Datenschutz-Hinweis.
 * Wird nur gerendert wenn isNeu=true (Query-Parameter ?neu=1).
 */

"use client";

import { useState } from "react";

interface Props {
  trackingCode: string;
}

export function TrackingCodeAnzeige({ trackingCode }: Props) {
  const [kopiert, setKopiert] = useState(false);

  async function handleKopieren() {
    try {
      await navigator.clipboard.writeText(trackingCode);
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2500);
    } catch {
      // Fallback: nichts tun, Browser ohne Clipboard-API
    }
  }

  return (
    <div className="mb-8 rounded-lg border-2 border-amber-300 bg-amber-50 p-5">
      <p className="text-sm font-semibold text-amber-900 mb-3">
        Ihr Anliegen wurde eingereicht
      </p>

      {/* Code-Block */}
      <div className="flex items-center gap-3 mb-3">
        <code className="flex-1 rounded-md bg-white border border-amber-200 px-4 py-3 text-2xl font-mono font-bold tracking-widest text-zinc-900 text-center select-all">
          {trackingCode}
        </code>
        <button
          type="button"
          onClick={handleKopieren}
          className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1 transition-colors"
          aria-label="Code kopieren"
        >
          {kopiert ? "✓ Kopiert" : "Kopieren"}
        </button>
      </div>

      {/* Wichtiger Hinweis */}
      <div className="pz-badge-warning rounded-md border border-[color:var(--pz-warning)]/30 px-4 py-3 text-xs leading-relaxed">
        <strong>Wichtig: Notieren Sie diesen Code jetzt.</strong>{" "}
        Aus Datenschutzgründen ist Ihr Anliegen nicht mit Ihrem Konto verknüpft — der Code wird nur dieses eine Mal angezeigt und kann nicht wiederhergestellt werden.
      </div>
    </div>
  );
}
