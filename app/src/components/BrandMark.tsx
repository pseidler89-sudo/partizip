/**
 * BrandMark — Partizip-Bildzeichen (Sprechblase + Haken) als Inline-SVG.
 *
 * Pfade exakt aus public/brand/partizip-mark.svg übernommen (eine Quelle für
 * die Form; hier inline, damit kein zusätzlicher Request nötig ist und das
 * Zeichen scharf in jeder Größe rendert).
 *
 * WICHTIG (Marken-Regel): Die Plattform-Marke bleibt IMMER Teal (--pz-brand,
 * Fallback #0d6a70) — auch bei Tenant-Branding. Nur der Standort-Chip trägt
 * die Tenant-Farbe. Deshalb bewusst KEIN currentColor/--tenant-primary.
 *
 * Reine Server-Component-taugliche Darstellung (kein "use client").
 * Dekorativ (ohne `title`) → aria-hidden; mit `title` → role="img".
 */

interface BrandMarkProps {
  className?: string;
  title?: string;
}

export function BrandMark({ className, title }: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="256" cy="256" r="256" fill="var(--pz-brand, #0d6a70)" />
      <path d="M176 320 L150 392 L258 330 Z" fill="#fffdf8" />
      <rect x="126" y="150" width="260" height="180" rx="52" fill="#fffdf8" />
      <polyline
        points="196,242 240,286 322,198"
        fill="none"
        stroke="var(--pz-brand, #0d6a70)"
        strokeWidth="34"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
