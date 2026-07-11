/**
 * StandortChip.tsx — Standort-Anzeige im Header (Design-System „Partizip Design System").
 *
 * Zeigt die aktuelle Region (Kommune) als antippbaren Chip neben der Wortmarke —
 * ein Ort ist KONTEXT/Filter, nicht die Marke. Tippen führt zur Startseite, wo
 * sich der Ort über den Region-Einstieg/-Banner wechseln lässt. Lucide map-pin +
 * chevron-down, voll-runde Pill (Design-Profil).
 */

import Link from "next/link";
import { MapPin, ChevronDown } from "lucide-react";

export function StandortChip({ slug, label }: { slug: string; label: string }) {
  return (
    <Link
      href={`/${slug}`}
      aria-label="Standort wechseln"
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-[color:var(--pz-line)] bg-[color:var(--pz-surface)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[color:var(--pz-brand)]"
      style={{ color: "var(--pz-ink)" }}
    >
      <MapPin aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
      <span className="truncate">{label}</span>
      <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
    </Link>
  );
}
