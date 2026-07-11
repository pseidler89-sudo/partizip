/**
 * opengraph-image.tsx — Vorschaubild der Digest-Seite (ADR-021).
 *
 * SOUVERÄNITÄT: Das Bild wird zur Laufzeit im eigenen Server erzeugt (Next.js
 * ImageResponse/Satori) — KEIN externer Bilddienst, kein Canva-Export, keine
 * US-CDN in der Kette. Damit sieht ein geteilter Link auf Mastodon/Bluesky/
 * überall gut aus, ohne das Kernversprechen zu brechen.
 *
 * Inhalt bewusst nüchtern: Marke, Kommune, Digest-Titel, Quellen-Hinweis.
 * Keine Politiker-Gesichter, keine Wertung, keine erfundenen Zahlen.
 * Nur VERÖFFENTLICHTE Digests erzeugen ein Bild (sonst neutraler Fallback).
 */

import { ImageResponse } from "next/og";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { digests, tenants } from "@/db/schema";
import { PLATFORM_NAME, regionDisplayName } from "@/lib/brand";

export const runtime = "nodejs";
export const alt = "Sitzungszusammenfassung auf Partizip";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CANVAS = "#f5f3ee";
const BRAND = "#0d6a70";
const INK = "#22312f";
const MUTED = "#6b7a76";
const SAND = "#9c6b2f";

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function Image({
  params,
}: {
  params: { tenant: string; id: string };
}) {
  let titel = "Sitzungszusammenfassung";
  let kommune = PLATFORM_NAME;

  try {
    const db = createDb(databaseUrl());
    const rows = await db
      .select({ title: digests.title, tenantName: tenants.name })
      .from(digests)
      .innerJoin(tenants, eq(tenants.id, digests.tenantId))
      .where(
        and(
          eq(digests.id, params.id),
          eq(tenants.slug, params.tenant),
          // Nur Veröffentlichtes bekommt ein inhaltliches Vorschaubild.
          eq(digests.status, "veroeffentlicht"),
        ),
      )
      .limit(1);
    if (rows[0]) {
      titel = rows[0].title;
      kommune = regionDisplayName(rows[0].tenantName);
    }
  } catch {
    // Fallback: neutrales Markenbild (nie den Seitenaufruf blockieren).
  }

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
        {/* Kopf: Marke + Kommune */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: BRAND }} />
          <div style={{ fontSize: 34, fontWeight: 700, color: BRAND }}>{PLATFORM_NAME}</div>
          {/* Satori-Regel: >1 Kindknoten erfordert display:flex — deshalb EIN
              Template-String statt Textknoten "· " + Expression (sonst wirft
              Satori bei jedem Render und der Endpoint antwortet 502). */}
          <div style={{ fontSize: 26, color: MUTED }}>{`· ${kommune}`}</div>
        </div>

        {/* Titel des Digests */}
        <div
          style={{
            display: "flex",
            fontSize: titel.length > 90 ? 48 : 60,
            lineHeight: 1.18,
            fontWeight: 700,
            color: INK,
            maxHeight: 340,
            overflow: "hidden",
          }}
        >
          {titel}
        </div>

        {/* Fuß: Vertrauens-Zeile + Sand-Akzentlinie */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ width: 120, height: 5, backgroundColor: SAND, borderRadius: 3 }} />
          <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
            Jede Aussage mit Quellenlink · menschlich freigegeben · überparteilich
          </div>
        </div>
      </div>
    ),
    size,
  );
}
