/**
 * PollTypBadge — Typ-Kennzeichnung einer Umfrage in der Karten-/Detailüberschrift.
 *
 * Verbindliche Abstimmungen tragen ein eigenes, farblich abgesetztes „Verbindlich"-
 * Badge (Info-Token + ShieldCheck), damit sie auf einen Blick von unverbindlichen
 * Stimmungsbildern unterscheidbar sind (Stufe-2-Gate). Die Ebene (Ortsteil/Kommune/
 * Kreis/Land) steht daneben als gedämpfter Zusatz. Rein präsentational (keine Hooks).
 */

import { ShieldCheck } from "lucide-react";

export function PollTypBadge({
  verbindlich,
  scope,
}: {
  verbindlich: boolean;
  /** Bereits aufgelöster Ebenen-Text (z. B. „Kommune" oder „für Ihre Kommune"). */
  scope: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
      {verbindlich ? (
        <span className="pz-badge-info inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Verbindlich
        </span>
      ) : (
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
        >
          Stimmungsbild
        </span>
      )}
      <span className="text-xs" style={{ color: "var(--pz-muted)" }}>
        {scope}
      </span>
    </span>
  );
}
