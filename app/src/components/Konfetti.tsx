/**
 * Konfetti.tsx — abhängigkeitsfreie Canvas-Konfetti-Animation (Vor-Ort-Befund C).
 *
 * Wird beim Erscheinen des Verifizierungs-Erfolgs-Screens eingeblendet: ein paar
 * Sekunden farbige Partikel in Partizip-Farben (--pz-brand / Salbei / warm),
 * dann automatisch aus. Keine externe Lib.
 *
 * A11y: rein dekorativ → `aria-hidden`; respektiert `prefers-reduced-motion`
 * (dann gar keine Animation — der Erfolgs-Screen kündigt sich selbst per
 * role="status" an, das Konfetti ist reine Zugabe).
 */

"use client";

import { useEffect, useRef } from "react";

interface Partikel {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rot: number;
  vrot: number;
}

/** Liest eine CSS-Custom-Property vom Element, mit Fallback. */
function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

const DAUER_MS = 3500;

export default function Konfetti() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // prefers-reduced-motion: keine Animation.
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const breite = rect.width || canvas.offsetWidth || 320;
    const hoehe = rect.height || canvas.offsetHeight || 240;
    canvas.width = Math.round(breite * dpr);
    canvas.height = Math.round(hoehe * dpr);
    ctx.scale(dpr, dpr);

    // Partizip-Palette (Salbei/Teal + warme Töne) — aus CSS-Vars mit Fallback.
    const farben = [
      cssVar(canvas, "--pz-brand", "#0d6a70"),
      cssVar(canvas, "--pz-brand-strong", "#0a565b"),
      "#7fb69b", // Salbei-Grün
      "#e6a33c", // warmes Gold
      "#d98b5f", // warmes Terrakotta
    ];

    const anzahl = 90;
    const partikel: Partikel[] = Array.from({ length: anzahl }, () => ({
      x: breite / 2 + (Math.random() - 0.5) * breite * 0.4,
      y: hoehe * 0.25 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 6,
      vy: Math.random() * -6 - 2,
      size: Math.random() * 6 + 4,
      color: farben[Math.floor(Math.random() * farben.length)],
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.3,
    }));

    const start = performance.now();
    let raf = 0;
    const schwerkraft = 0.14;

    function frame(now: number) {
      const t = now - start;
      if (!ctx) return;
      ctx.clearRect(0, 0, breite, hoehe);

      // Ausblenden gegen Ende, damit es sanft endet.
      const alpha = t > DAUER_MS - 700 ? Math.max(0, (DAUER_MS - t) / 700) : 1;
      ctx.globalAlpha = alpha;

      for (const p of partikel) {
        p.vy += schwerkraft;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }

      if (t < DAUER_MS) {
        raf = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, breite, hoehe);
      }
    }

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
