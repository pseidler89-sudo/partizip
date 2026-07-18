/**
 * InitialenAvatar — deterministischer Initialen-Avatar für ROLLENTRÄGER
 * (Block J1). Reines präsentationales Div, KEIN Bild-Upload (bewusst: Bürger
 * bleiben ohnehin ohne Avatar; Rollenträger tragen nur Initialen aus ihrem
 * Klarnamen). `aria-hidden`, weil der Name direkt daneben als Text steht — der
 * Avatar ist reine Dekoration und darf Screenreader nicht doppelt beschäftigen.
 *
 * Die Hintergrundfarbe wird DETERMINISTISCH aus dem Namen abgeleitet (gleicher
 * Name → gleiche Farbe), aus einer kleinen, zum pz-System passenden Palette.
 */

import { initialen as computeInitialen } from "@/lib/identity/anzeige";

/**
 * Kleine, gedämpfte Palette (HSL-Basispaare Hintergrund/Text). Bewusst ruhig,
 * damit die Avatare neben dem Salbei-Grün des Produkts nicht schreien.
 */
const PALETTE: { bg: string; fg: string }[] = [
  { bg: "#e2e8e6", fg: "#2f4a44" }, // salbei
  { bg: "#e5e7eb", fg: "#374151" }, // zinc
  { bg: "#e7e5e4", fg: "#44403c" }, // stone
  { bg: "#e0e7ef", fg: "#334155" }, // slate-blau
  { bg: "#eae6e1", fg: "#4a4038" }, // warm
];

/** Stabiler, vorzeichenfreier Hash über die Code-Points (kein Math.random). */
function farbIndex(seed: string): number {
  let h = 0;
  for (const ch of seed) {
    h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  }
  return h % PALETTE.length;
}

export function InitialenAvatar({
  name,
  size = 28,
  className = "",
}: {
  /** Klarname, aus dem Initialen + Farbe abgeleitet werden. */
  name: string;
  /** Kantenlänge in px (Quadrat). */
  size?: number;
  className?: string;
}) {
  const text = computeInitialen(name);
  const { bg, fg } = PALETTE[farbIndex(name)];
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        backgroundColor: bg,
        color: fg,
        lineHeight: 1,
      }}
    >
      {text}
    </span>
  );
}
