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
import { qrCodes, scopeLevelEnum } from "@/db/schema";

export type ScopeLevel = (typeof scopeLevelEnum.enumValues)[number];

export interface QrCodeListItem {
  id: string;
  label: string | null;
  scopeLevel: ScopeLevel;
  scopeCode: string | null;
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
      scopeLevel: qrCodes.scopeLevel,
      scopeCode: qrCodes.scopeCode,
      redemptionCount: qrCodes.redemptionCount,
      maxRedemptions: qrCodes.maxRedemptions,
      expiresAt: qrCodes.expiresAt,
      revokedAt: qrCodes.revokedAt,
      createdAt: qrCodes.createdAt,
    })
    .from(qrCodes)
    .where(eq(qrCodes.tenantId, tenantId))
    .orderBy(desc(qrCodes.createdAt));
}

export interface QrTokenMeta {
  scopeLevel: ScopeLevel;
  scopeCode: string | null;
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
      scopeLevel: qrCodes.scopeLevel,
      scopeCode: qrCodes.scopeCode,
      label: qrCodes.label,
      expiresAt: qrCodes.expiresAt,
      revokedAt: qrCodes.revokedAt,
      redemptionCount: qrCodes.redemptionCount,
      maxRedemptions: qrCodes.maxRedemptions,
    })
    .from(qrCodes)
    .where(and(eq(qrCodes.tokenHash, tokenHash), eq(qrCodes.tenantId, tenantId)))
    .limit(1);

  const qr = rows[0];
  if (!qr) return null;

  let status: QrTokenMeta["status"] = "gueltig";
  if (qr.revokedAt) status = "widerrufen";
  else if (qr.expiresAt <= new Date()) status = "abgelaufen";
  else if (qr.redemptionCount >= qr.maxRedemptions) status = "aufgebraucht";

  return {
    scopeLevel: qr.scopeLevel,
    scopeCode: qr.scopeCode,
    label: qr.label,
    status,
  };
}
