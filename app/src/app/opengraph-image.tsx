/**
 * opengraph-image.tsx (Root) — Vorschaubild für geteilte Links auf die
 * Plattform selbst (Landing, partizip.online ohne Pfad).
 *
 * SOUVERÄNITÄT wie beim Digest-Bild (ADR-021): zur Laufzeit im eigenen Server
 * erzeugt (Next.js ImageResponse/Satori), kein externer Bilddienst.
 *
 * Inhalt: Bildzeichen (Sprechblase + Haken, Satori-kompatibles Inline-SVG),
 * Marke, Claim, Domain. Farben = Civic-Salbei-Konstanten (Satori kann keine
 * CSS-Variablen — Werte wie im Digest-Bild fest verdrahtet, Quelle globals.css).
 */

import { ImageResponse } from "next/og";
import { PLATFORM_NAME } from "@/lib/brand";

export const runtime = "nodejs";
export const alt = "Partizip — überparteiliche kommunale Beteiligung";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CANVAS = "#f5f3ee";
const BRAND = "#0d6a70";
const INK = "#22312f";
const MUTED = "#6b7a76";
const SAND = "#9c6b2f";
const SURFACE = "#fffdf8";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: CANVAS,
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Kopf: Bildzeichen + Wortmarke */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* Sprechblase + Haken — Pfade aus public/brand/partizip-mark.svg */}
          <svg width="72" height="72" viewBox="0 0 512 512">
            <circle cx="256" cy="256" r="256" fill={BRAND} />
            <path d="M176 320 L150 392 L258 330 Z" fill={SURFACE} />
            <rect x="126" y="150" width="260" height="180" rx="52" fill={SURFACE} />
            <polyline
              points="196,242 240,286 322,198"
              fill="none"
              stroke={BRAND}
              strokeWidth="34"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div style={{ fontSize: 44, fontWeight: 700, color: BRAND }}>{PLATFORM_NAME}</div>
        </div>

        {/* Claim */}
        <div
          style={{
            display: "flex",
            fontSize: 64,
            lineHeight: 1.15,
            fontWeight: 700,
            color: INK,
            maxWidth: 980,
          }}
        >
          Überparteiliche kommunale Beteiligung
        </div>

        {/* Fuß: Sand-Akzentlinie + Domain */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ width: 120, height: 5, backgroundColor: SAND, borderRadius: 3 }} />
          <div style={{ display: "flex", fontSize: 28, color: MUTED }}>partizip.online</div>
        </div>
      </div>
    ),
    size,
  );
}
