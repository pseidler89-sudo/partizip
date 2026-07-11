/**
 * gruppierung.ts — Polls nach geografischer Ebene gruppieren (ADR-015).
 *
 * Reine Funktion (kein DB/IO): macht „nach Ebene gekennzeichnet" konkret —
 * Ortsteil ⊂ Stadt/Kommune ⊂ Kreis ⊂ Land. Genutzt von Landing + /umfragen.
 */

import { scopeLevelEnum } from "@/db/schema";

export type ScopeLevel = (typeof scopeLevelEnum.enumValues)[number];

/** Anzeige-Reihenfolge: am lokalsten zuerst (Ortsteil → Stadt → Kreis → Land). */
export const SCOPE_ORDER: readonly ScopeLevel[] = ["ortsteil", "stadt", "kreis", "land"];

/** Menschliche Ebenen-Bezeichnung (Singular). */
export const SCOPE_LABEL: Record<ScopeLevel, string> = {
  ortsteil: "Ortsteil",
  stadt: "Kommune",
  kreis: "Kreis",
  land: "Land",
};

export interface PollGruppe<T> {
  level: ScopeLevel;
  label: string;
  polls: T[];
}

/**
 * Gruppiert Polls nach scopeLevel in fester Reihenfolge; leere Ebenen entfallen.
 * Generisch über alles, was ein `scopeLevel` trägt (PollListItem, PollMitErgebnis).
 */
export function gruppiereNachEbene<T extends { scopeLevel: ScopeLevel }>(
  polls: T[]
): PollGruppe<T>[] {
  return SCOPE_ORDER.map((level) => ({
    level,
    label: SCOPE_LABEL[level],
    polls: polls.filter((p) => p.scopeLevel === level),
  })).filter((g) => g.polls.length > 0);
}
