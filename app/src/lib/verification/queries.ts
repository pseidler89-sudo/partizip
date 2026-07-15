/**
 * queries.ts — Lese-Queries der QR-Verifizierung (Server-Component-Nutzung).
 *
 * BEWUSST OHNE "use server" (Muster polls/queries.ts, Gate-B MAJOR-G): reine,
 * tenant-scoped Lesezugriffe für Server-Komponenten. Lägen sie in der
 * "use server"-Datei, würde Next.js sie als client-aufrufbare RPC-Endpunkte mit
 * client-kontrolliertem tenantId exponieren.
 *
 * Es wird NIEMALS der tokenHash (oder gar ein raw Token) ausgegeben — der QR-Code
 * ist nur direkt nach der Erstellung sichtbar.
 */

import { and, eq, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { qrCodes, regions } from "@/db/schema";
import type { RegionTyp } from "@/lib/region/ebenen";

export interface QrCodeListItem {
  id: string;
  label: string | null;
  // ADR-024 contract: Gebietsart + Name des QR-Knotens statt scope_level/scope_code.
  regionTyp: RegionTyp;
  regionName: string;
  redemptionCount: number;
  maxRedemptions: number;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * Liste der QR-Codes eines Tenants für die Admin-/Verifier-Übersicht
 * (neu→alt). KEIN tokenHash — nur anzeigbare Metadaten + Status.
 */
export async function qrCodesListe(
  db: Db,
  tenantId: string,
): Promise<QrCodeListItem[]> {
  return db
    .select({
      id: qrCodes.id,
      label: qrCodes.label,
      regionTyp: regions.typ,
      regionName: regions.name,
      redemptionCount: qrCodes.redemptionCount,
      maxRedemptions: qrCodes.maxRedemptions,
      expiresAt: qrCodes.expiresAt,
      revokedAt: qrCodes.revokedAt,
      createdAt: qrCodes.createdAt,
    })
    .from(qrCodes)
    .innerJoin(regions, eq(regions.id, qrCodes.regionId))
    .where(eq(qrCodes.tenantId, tenantId))
    .orderBy(desc(qrCodes.createdAt));
}

export interface QrTokenMeta {
  // ADR-024 contract: Gebietsart + Name des QR-Knotens statt scope_level/scope_code.
  regionTyp: RegionTyp;
  regionName: string;
  label: string | null;
  /** Aggregierter Gültigkeits-Status für die Einlöse-Seite. */
  status: "gueltig" | "abgelaufen" | "widerrufen" | "aufgebraucht";
}

/**
 * Metadaten zu einem RAW-Token für die Einlöse-Seite (tenant-scoped, über den
 * tokenHash). Gibt NUR unsensible Anzeigedaten + einen Status zurück — KEINE
 * Einlösungs-Wirkung (die passiert erst beim Bestätigen via qrEinloesen).
 *
 * Der tokenHash wird hier intern berechnet und NICHT ausgegeben. null, wenn der
 * Token nicht zum Tenant gehört (nicht erratbar — Token ist CSPRNG).
 */
export async function qrTokenMeta(
  db: Db,
  tenantId: string,
  rawToken: string,
): Promise<QrTokenMeta | null> {
  // sha256Hex lokal importiert, damit dieses Lese-Modul keine Krypto-Last für
  // Aufrufer trägt, die nur qrCodesListe brauchen.
  const { sha256Hex } = await import("@/lib/auth/crypto");
  const tokenHash = sha256Hex(rawToken);

  const rows = await db
    .select({
      regionTyp: regions.typ,
      regionName: regions.name,
      label: qrCodes.label,
      expiresAt: qrCodes.expiresAt,
      revokedAt: qrCodes.revokedAt,
      redemptionCount: qrCodes.redemptionCount,
      maxRedemptions: qrCodes.maxRedemptions,
    })
    .from(qrCodes)
    .innerJoin(regions, eq(regions.id, qrCodes.regionId))
    .where(and(eq(qrCodes.tokenHash, tokenHash), eq(qrCodes.tenantId, tenantId)))
    .limit(1);

  const qr = rows[0];
  if (!qr) return null;

  let status: QrTokenMeta["status"] = "gueltig";
  if (qr.revokedAt) status = "widerrufen";
  else if (qr.expiresAt <= new Date()) status = "abgelaufen";
  else if (qr.redemptionCount >= qr.maxRedemptions) status = "aufgebraucht";

  return {
    regionTyp: qr.regionTyp,
    regionName: qr.regionName,
    label: qr.label,
    status,
  };
}
