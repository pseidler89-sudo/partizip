/**
 * proof-actions.ts — Server Actions für die umgekehrte QR-Verifizierung (V3).
 *
 * Gate-B: Server Actions sind eigenständige Endpoints — Auth/Validierung/Tenant
 * werden serverseitig erzwungen, nie dem Client vertraut. Diese Datei löst nur
 * Auth/Tenant/IP aus dem Request-Kontext auf und delegiert die DB-Logik an
 * @/lib/verification/proof-core (die als ECHTE Funktion getestet wird).
 *
 * SICHERHEITS-KERN:
 *   - meinVerifizierungsProofErzeugen: NUR eingeloggt (Stufe ≥ 1). Demo-Fence
 *     fail-closed (Demo erzeugt KEINEN Beleg). Vorher offene Belege invalidiert.
 *   - verifizierungPerProofBestaetigen: NUR canVerify (verifier/kommune_admin/
 *     super_admin). Gebiets-Autorität + Single-Use + Kein-Selbst-Grant im Core.
 *   - Token nur gehasht gespeichert; RAW-Token GENAU EINMAL beim Erzeugen zurück.
 *   - Tenant-Isolation überall; Audit PII-frei.
 */

"use server";

import { headers } from "next/headers";
import { z } from "zod";
import {
  requireStufe1Ctx,
  requireVerifierCtx,
} from "@/lib/auth/action-context";
import {
  meinProofErzeugenCore,
  verifizierungPerProofBestaetigenCore,
  ProofGebietError,
} from "@/lib/verification/proof-core";
import { checkProofCreateRateLimit } from "@/lib/verification/rate-limit";
import { getUserRoleTypes, getUserRolesMitScope, isAdmin } from "@/lib/auth/roles";
import { isDemoTenant } from "@/lib/demo/config";

// ---------------------------------------------------------------------------
// meinVerifizierungsProofErzeugen — Konto-Beleg (QR + Klartext-Code) erzeugen.
// ---------------------------------------------------------------------------

export interface ProofErzeugenActionResult {
  ok: boolean;
  /** RAW-Token als Klartext-Code (Fallback, falls QR nicht scannbar). Einmalig. */
  code?: string;
  /** Deep-Link mit RAW-Token für den QR (Verifizierer scannt ihn). Einmalig. */
  proofUrl?: string;
  /** QR-Code als PNG-Data-URL (serverseitig aus dem Deep-Link erzeugt). */
  qrDataUrl?: string;
  expiresAt?: string;
  /** true ⇒ nicht eingeloggt: Client zeigt Anmelde-CTA. */
  needLogin?: boolean;
  /** true ⇒ Demo-Mandant: bewusst KEIN Beleg erzeugt. */
  demo?: boolean;
  error?: string;
}

export async function meinVerifizierungsProofErzeugen(): Promise<ProofErzeugenActionResult> {
  const auth = await requireStufe1Ctx();
  if (!auth.ok) return { ok: false, needLogin: auth.needLogin, error: auth.error };
  const { ctx } = auth;

  // Demo-Fence fail-closed: auf dem Demo-Mandanten wird KEIN echter Beleg
  // erzeugt (die Verifizierung ist dort nicht Teil der Spielwiese).
  if (isDemoTenant(ctx.tenant.slug)) {
    return {
      ok: false,
      demo: true,
      error: "In der Demo ist die Vor-Ort-Verifizierung nicht verfügbar.",
    };
  }

  // Eigener Rate-Limit-Scope (proof_create) gegen Erzeugungs-Spam — nach Konto
  // dimensioniert (siehe checkProofCreateRateLimit: geteilte IPs sperren sonst
  // echte Bürger im Bürgerbüro-WLAN gegenseitig aus).
  const rl = await checkProofCreateRateLimit(ctx.db, {
    tenantId: ctx.tenant.id,
    userId: ctx.userId,
  });
  if (!rl.allowed) {
    return {
      ok: false,
      error: "Zu viele Versuche in kurzer Zeit. Bitte später erneut versuchen.",
    };
  }

  const result = await meinProofErzeugenCore(ctx.db, ctx.tenant.id, ctx.userId);

  // Deep-Link bauen: https://<host>/<slug>/verifizieren/bestaetigen?proof=<rawToken>.
  // Host aus dem Request-Header (Tenant-Subdomain); Schema = https außer localhost.
  const headerStore = await headers();
  const host = headerStore.get("host") ?? `${ctx.tenant.slug}.localhost`;
  const proto = host.startsWith("localhost") || host.includes("127.0.0.1") ? "http" : "https";
  const proofUrl = `${proto}://${host}/${ctx.tenant.slug}/verifizieren/bestaetigen?proof=${encodeURIComponent(result.rawToken)}`;

  // QR-Code serverseitig als PNG-Data-URL (qrcode-Paket). Fehler hier dürfen die
  // Erzeugung nicht versenken — der Klartext-Code funktioniert auch ohne Bild.
  let qrDataUrl: string | undefined;
  try {
    const QRCode = (await import("qrcode")).default;
    qrDataUrl = await QRCode.toDataURL(proofUrl, { width: 320, margin: 2 });
  } catch {
    qrDataUrl = undefined;
  }

  return {
    ok: true,
    code: result.rawToken,
    proofUrl,
    qrDataUrl,
    expiresAt: result.expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// verifizierungPerProofBestaetigen — Konto-QR vor Ort bestätigen (NUR canVerify).
// ---------------------------------------------------------------------------

export interface ProofBestaetigenActionResult {
  ok: boolean;
  verifiedUntil?: string;
  /** true ⇒ Demo-Mandant: bewusst KEIN Grant (Client zeigt neutralen Hinweis, kein Fehler). */
  demo?: boolean;
  error?: string;
}

export async function verifizierungPerProofBestaetigen(
  rawToken: string,
  zielRegionId: string,
): Promise<ProofBestaetigenActionResult> {
  const auth = await requireVerifierCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  // Demo-Fence fail-closed, spiegelbildlich zur Erzeugung: auf dem Demo-Mandanten
  // wird NIE ein echter Grant erteilt. Heute schon durch Absenz gesichert (Demo
  // erzeugt keinen Beleg), aber explizit gefenced, falls je ein Demo-Beleg
  // entsteht (Seed/Reset) — sonst könnte ein Demo-Verifizierer Stufe 2 vergeben.
  if (isDemoTenant(ctx.tenant.slug)) {
    return { ok: false, demo: true, error: "In der Demo ist die Vor-Ort-Verifizierung nicht verfügbar." };
  }

  const tokenParsed = z.string().trim().min(1).max(512).safeParse(rawToken);
  if (!tokenParsed.success) return { ok: false, error: "Dieser Beleg ist ungültig." };
  const regionParsed = z.string().uuid().safeParse(zielRegionId);
  if (!regionParsed.success) return { ok: false, error: "Bitte wählen Sie ein Gebiet aus." };

  // Admin-Status + Rollen-Gebiete SERVERSEITIG laden (tenant-scoped +
  // account_status-gefiltert) und an den Core durchreichen — der erzwingt
  // fail-closed die Gebiets-Abdeckung (kein Vertrauen in Client-Daten).
  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  const scopes = await getUserRolesMitScope(ctx.db, ctx.tenant.id, ctx.userId);

  try {
    const result = await verifizierungPerProofBestaetigenCore(
      ctx.db,
      ctx.tenant.id,
      ctx.userId,
      tokenParsed.data,
      regionParsed.data,
      { isAdmin: isAdmin(roleTypes), scopes },
    );
    return {
      ok: result.ok,
      verifiedUntil: result.verifiedUntil?.toISOString(),
      error: result.error,
    };
  } catch (err) {
    if (err instanceof ProofGebietError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
