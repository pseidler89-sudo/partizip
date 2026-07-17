/**
 * qr-actions.ts — Server Actions für die QR-Verifizierung (ADR-014 Block 2).
 *
 * Gate-B: Server Actions sind eigenständige Endpoints — Auth/Validierung/Tenant
 * werden serverseitig erzwungen, nie dem Client vertraut.
 *
 * Diese Datei löst NUR Auth/Tenant/IP aus dem Request-Kontext auf und delegiert
 * die DB-Logik an @/lib/verification/qr-core (die als ECHTE Funktion getestet
 * wird). Lese-Queries liegen bewusst in @/lib/verification/queries (OHNE
 * "use server"), damit sie nicht als client-aufrufbare RPC mit
 * client-kontrolliertem tenantId exponiert werden (Gate-B MAJOR-G).
 *
 * SICHERHEITS-KERN:
 *   - qrErstellen/qrWiderrufen: NUR canVerify (verifier/kommune_admin/super_admin),
 *     serverseitig hart. Kein Selbst-Hochstufen.
 *   - qrEinloesen: NUR eingeloggt (Stufe ≥ 1). Kein anonymes Einlösen.
 *   - Token nur gehasht gespeichert; RAW-Token GENAU EINMAL bei Erstellung zurück.
 *   - Cap atomar, Idempotenz, Ablauf/Widerruf → in qr-core (race-frei).
 *   - Tenant-Isolation überall; Audit PII-frei.
 */

"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { SCOPE_INPUT_LEVELS } from "@/lib/region/ebenen";
import { getStufe } from "@/lib/eligibility/stufe";
import {
  getOptionalAuthContext,
  getClientIp,
  requireVerifierCtx,
} from "@/lib/auth/action-context";
import {
  qrErstellenCore,
  qrWiderrufenCore,
  qrEinloesenCore,
  QrGebietError,
  QR_LIMITS,
} from "@/lib/verification/qr-core";
import { getUserRoleTypes, getUserRolesMitScope, isAdmin } from "@/lib/auth/roles";
import { checkQrRedeemRateLimit } from "@/lib/verification/rate-limit";

// ---------------------------------------------------------------------------
// qrErstellen — QR-Code anlegen (NUR canVerify). RAW-Token GENAU EINMAL zurück.
// ---------------------------------------------------------------------------

const qrErstellenSchema = z.object({
  // ADR-024 contract: Eingabe-Ebene als TS-Union (kein DB-Enum), zu region_id aufgelöst.
  scopeLevel: z.enum(SCOPE_INPUT_LEVELS),
  scopeCode: z.string().trim().max(100).optional().nullable(),
  label: z.string().trim().max(200).optional().nullable(),
  maxRedemptions: z
    .number()
    .int()
    .min(QR_LIMITS.MAX_REDEMPTIONS_MIN, "Mindestens 1 Einlösung.")
    .max(QR_LIMITS.MAX_REDEMPTIONS_MAX, "Höchstens 10000 Einlösungen."),
  gueltigkeitStunden: z
    .number()
    .int()
    .min(QR_LIMITS.GUELTIGKEIT_STUNDEN_MIN, "Mindestens 1 Stunde.")
    .max(QR_LIMITS.GUELTIGKEIT_STUNDEN_MAX, "Höchstens 720 Stunden (30 Tage)."),
});

export interface QrErstellenActionResult {
  ok: boolean;
  qrId?: string;
  /** Einlöse-URL mit RAW-Token — nur EINMAL nach Erstellung sichtbar. */
  redeemUrl?: string;
  /** QR-Code als PNG-Data-URL (serverseitig aus der Einlöse-URL erzeugt). */
  qrDataUrl?: string;
  expiresAt?: string;
  error?: string;
}

export async function qrErstellen(
  rawData: unknown,
): Promise<QrErstellenActionResult> {
  const auth = await requireVerifierCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const parsed = qrErstellenSchema.safeParse(rawData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  const { scopeLevel, scopeCode, label, maxRedemptions, gueltigkeitStunden } = parsed.data;

  // GEBIETSBINDUNG (Block K1): Admin-Status + Rollen-Gebiete SERVERSEITIG laden
  // (beide tenant-scoped + account_status-gefiltert) und an den Core durchreichen
  // — der erzwingt fail-closed, dass Nicht-Admin-Verifier nur im eigenen
  // Zuständigkeitsgebiet QRs erstellen. Die UI filtert das Dropdown nur als Komfort.
  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  const scopes = await getUserRolesMitScope(ctx.db, ctx.tenant.id, ctx.userId);

  let result;
  try {
    result = await qrErstellenCore(
      ctx.db,
      ctx.tenant.id,
      ctx.userId,
      {
        scopeLevel,
        scopeCode: scopeCode ?? null,
        label: label ?? null,
        maxRedemptions,
        gueltigkeitStunden,
      },
      { isAdmin: isAdmin(roleTypes), scopes },
    );
  } catch (err) {
    if (err instanceof QrGebietError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  // Einlöse-URL bauen: https://<host>/<slug>/verifizieren?code=<rawToken>.
  // Host aus dem Request-Header (Tenant-Subdomain); Schema = https außer auf
  // localhost. Der RAW-Token wird hier GENAU EINMAL in die URL eingebettet und
  // danach nie wieder ausgegeben (nur tokenHash in der DB).
  const headerStore = await headers();
  const host = headerStore.get("host") ?? `${ctx.tenant.slug}.localhost`;
  const proto = host.startsWith("localhost") || host.includes("127.0.0.1") ? "http" : "https";
  const redeemUrl = `${proto}://${host}/${ctx.tenant.slug}/verifizieren?code=${encodeURIComponent(result.rawToken)}`;

  // QR-Code serverseitig als PNG-Data-URL (qrcode-Paket). Fehler hier dürfen die
  // Erstellung nicht versenken — der Link funktioniert auch ohne Bild.
  let qrDataUrl: string | undefined;
  try {
    const QRCode = (await import("qrcode")).default;
    qrDataUrl = await QRCode.toDataURL(redeemUrl, { width: 320, margin: 2 });
  } catch {
    qrDataUrl = undefined;
  }

  return {
    ok: true,
    qrId: result.qrId,
    redeemUrl,
    qrDataUrl,
    expiresAt: result.expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// qrWiderrufen — QR-Code widerrufen (NUR canVerify, tenant-scoped).
// ---------------------------------------------------------------------------

export async function qrWiderrufen(
  qrId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireVerifierCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(qrId);
  if (!idParsed.success) return { ok: false, error: "Ungültige QR-ID." };

  return qrWiderrufenCore(ctx.db, ctx.tenant.id, ctx.userId, idParsed.data);
}

// ---------------------------------------------------------------------------
// qrEinloesen — QR einlösen (NUR eingeloggt, Stufe ≥ 1). Kein anonymes Einlösen.
// ---------------------------------------------------------------------------

export interface QrEinloesenActionResult {
  ok: boolean;
  alreadyRedeemed?: boolean;
  verifiedUntil?: string;
  /** true ⇒ nicht eingeloggt: Client zeigt freundlichen Anmelde-CTA. */
  needLogin?: boolean;
  error?: string;
}

export async function qrEinloesen(
  rawToken: string,
): Promise<QrEinloesenActionResult> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };

  // Einlösen NUR eingeloggt (Stufe ≥ 1). Kein anonymes Einlösen.
  if (!ctx.userId || !ctx.user) {
    return {
      ok: false,
      needLogin: true,
      error: "Bitte melden Sie sich an, um sich zu verifizieren.",
    };
  }
  // Stufe-1-Pflicht hart (aktiver Account + bestätigtes Mindestalter).
  if (getStufe(ctx.user) < 1) {
    return {
      ok: false,
      needLogin: true,
      error: "Bitte melden Sie sich an, um sich zu verifizieren.",
    };
  }

  const tokenParsed = z.string().trim().min(1).max(512).safeParse(rawToken);
  if (!tokenParsed.success) {
    return { ok: false, error: "Dieser Code ist ungültig." };
  }

  // Leichtes IP-Rate-Limit gegen Einlöse-Spam (nicht kritisch).
  const ip = await getClientIp();
  const rl = await checkQrRedeemRateLimit(ctx.db, { tenantId: ctx.tenant.id, ipAddress: ip });
  if (!rl.allowed) {
    return {
      ok: false,
      error: "Zu viele Versuche in kurzer Zeit. Bitte später erneut versuchen.",
    };
  }

  const result = await qrEinloesenCore(
    ctx.db,
    ctx.tenant.id,
    ctx.userId,
    tokenParsed.data,
  );

  return {
    ok: result.ok,
    alreadyRedeemed: result.alreadyRedeemed,
    verifiedUntil: result.verifiedUntil?.toISOString(),
    error: result.error,
  };
}
