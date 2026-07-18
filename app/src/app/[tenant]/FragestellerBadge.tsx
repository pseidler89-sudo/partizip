/**
 * FragestellerBadge — „Gestellt von: <Institution> — <Funktion> <Klarname>".
 *
 * Zeigt auf jeder Umfrage (Detailseite + Listenkarte), WER sie gestellt hat. Die
 * INSTITUTION (Kommune) ist das primäre Vertrauenssignal und steht IMMER; die
 * Person (Rollenträger mit Klarnamen) ist zweitrangig und erscheint nur, wenn die
 * Ableitung (fragestellerBadge) sie freigibt. Rein präsentational.
 *
 * A11y: der Initialen-Avatar ist `aria-hidden` (Dekoration), der Name steht als
 * Text daneben.
 */

import { InitialenAvatar } from "@/components/InitialenAvatar";
import type { FragestellerBadge as FragestellerBadgeVM } from "@/lib/identity/anzeige";

export function FragestellerBadge({
  badge,
  className = "",
}: {
  badge: FragestellerBadgeVM;
  className?: string;
}) {
  const personText = badge.person
    ? [badge.funktion, badge.person].filter(Boolean).join(" ")
    : null;

  return (
    <div
      className={`flex items-center gap-2 text-xs ${className}`}
      style={{ color: "var(--pz-muted)" }}
    >
      {badge.person && <InitialenAvatar name={badge.person} size={24} />}
      <span className="min-w-0">
        <span className="text-pz-muted">Gestellt von: </span>
        <span className="font-medium" style={{ color: "var(--pz-body)" }}>
          {badge.institution}
        </span>
        {personText && (
          <>
            <span className="text-pz-muted"> — </span>
            <span style={{ color: "var(--pz-body)" }}>{personText}</span>
          </>
        )}
      </span>
    </div>
  );
}
