/**
 * DemoBanner — nicht schließbare Kennzeichnung der Akquise-Spielwiese.
 *
 * Wird vom Tenant-Layout NUR auf dem Demo-Mandanten gerendert (isDemoTenant).
 * Bewusst ohne Schließen-Knopf: die Kennzeichnung „keine echten Daten" ist Teil
 * der Ehrlichkeits-Leitplanke (kein Overclaiming) und muss immer sichtbar sein.
 * Rein präsentational, Server-Component-tauglich (keine Hooks).
 */

import { FlaskConical } from "lucide-react";

export function DemoBanner() {
  return (
    <div
      role="note"
      className="px-4 py-2 text-center text-xs font-medium sm:text-sm"
      style={{ backgroundColor: "var(--pz-info-soft)", color: "var(--pz-info-ink)" }}
    >
      <span className="inline-flex items-center gap-1.5">
        <FlaskConical aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        <span>
          <strong>Demo-Spielwiese</strong> — Musterstadt ist fiktiv, keine echten
          Daten. Stimmen werden nächtlich zurückgesetzt.
        </span>
      </span>
    </div>
  );
}
