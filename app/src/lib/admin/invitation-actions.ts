/**
 * invitation-actions.ts — Server Actions für den Einladungs-Flow (Gate B).
 *
 * Dünne "use server"-Wrapper: lösen den Auth-Kontext über das ZENTRALE Gate auf
 * (@/lib/auth/action-context) und delegieren dann in die testbare Kern-Logik
 * (invitation-core.ts). Der Mailversand (Roh-Token nur in der URL) passiert
 * hier — die Cores geben den Roh-Token GENAU EINMAL zurück.
 *
 * KEIN EIGENER SESSION-RESOLVER (Gate-B 2026-08-06, BLOCKER): Diese Datei hatte
 * eine eigene Kopie des Session-Lookups und kam damit an der Zwei-Faktor-Pflicht
 * (#59) vorbei — ausgerechnet hier, wo `einladen` eine kommune_admin-Rolle über
 * eine zweite Tür vergibt. Der Kontext kommt jetzt ausschließlich aus den
 * require*Ctx-Gates; der Wächter-Test
 * lib/auth/__tests__/kein-eigener-session-resolver.test.ts hält das fest.
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth; die
 * UI-Filterung ist nur Komfort).
 *
 * Autorisierung:
 *   - einladen/zurückziehen/erneutSenden: NUR Admin (kommune_admin/super_admin)
 *     MIT frischer Zwei-Faktor-Bestätigung (requireAdminStepUpCtx), serverseitig
 *     hart; die konkrete Ziel-Rolle zusätzlich über canManageRole
 *     (Eskalationsgrenze) in den Cores.
 *   - annehmen: der/die Eingeladene, per Magic-Link authentifiziert (Konto muss
 *     existieren + eingeloggt sein); die E-Mail-Bindung erzwingt der Core.
 */

"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { SCOPE_INPUT_LEVELS } from "@/lib/region/ebenen";
import { isDemoTenant } from "@/lib/demo/config";
import {
  getOptionalAuthContext,
  requireAdminStepUpCtx,
} from "@/lib/auth/action-context";
import { sendInvitationEmail } from "@/lib/auth/mail";
import {
  einladenCore,
  einladungZurueckziehenCore,
  einladungErneutSendenCore,
  einladungAnnehmenCore,
  type EinladenInput,
} from "@/lib/admin/invitation-core";

const ROLE_LABELS: Record<string, string> = {
  user: "Bürger:in",
  verifier: "Verifizierer:in",
  redakteur: "Redakteur:in",
  beobachter: "Beobachter:in",
  kommune_admin: "Kommune-Admin",
  super_admin: "Super-Admin",
  ortsteil_admin: "Ortsteil-Admin",
  kreis_admin: "Kreis-Admin",
  land_admin: "Land-Admin",
};

/**
 * Request-Host für die Einladungs-URL. BEWUSST kein Auth-Belang: Der Tenant kommt
 * aus dem Gate (dort aus dem Host aufgelöst), hier wird nur der Link gebaut.
 */
async function requestHost(): Promise<string> {
  const headerStore = await headers();
  return headerStore.get("host") ?? "localhost";
}

function buildInviteUrl(host: string, slug: string, rawToken: string): string {
  const proto = host.startsWith("localhost") || host.includes("127.0.0.1") ? "http" : "https";
  return `${proto}://${host}/${slug}/einladung?token=${encodeURIComponent(rawToken)}`;
}

export type InvitationActionResult = { ok: boolean; error?: string; message?: string };

const einladenSchema = z.object({
  email: z.string().email("Bitte eine gültige E-Mail-Adresse angeben."),
  roleType: z.string().min(1),
  // ADR-024 contract: Eingabe-Ebene als TS-Union (kein DB-Enum), zu region_id aufgelöst.
  scopeLevel: z.enum(SCOPE_INPUT_LEVELS).optional(),
  scopeCode: z.string().trim().max(100).optional().nullable(),
});

/** Server Action: Einladung erstellen/erneut versenden (auditiert, eskalationsgeschützt). */
export async function einladen(rawInput: EinladenInput): Promise<InvitationActionResult> {
  // STEP-UP (#59): Die Einladung ist die ZWEITE TÜR zur Rollenvergabe — wer sie
  // ohne frische Bestätigung auslösen könnte, käme über den Umweg „einladen +
  // annehmen" an genau das, wofür assignRole längst Step-up verlangt (bis hin zu
  // kommune_admin). Gleiche Schwelle wie assignRole, sonst wäre sie umgehbar.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  // SIDE-EFFECT-FENCE (Demo-Spielwiese, fail-closed): ephemere Demo-Admins
  // dürfen KEINE echten E-Mails auslösen — sonst wäre der Einladungs-Flow ein
  // offener Spam-Vektor über den echten SMTP-Server. Der Fehler kommt VOR jedem
  // Token-/Mail-Pfad (kein Datensatz, kein Versand).
  if (isDemoTenant(ctx.tenant.slug)) {
    return { ok: false, error: "Im Demo-Mandanten werden keine Einladungen versendet." };
  }

  const parsed = einladenSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }

  const result = await einladenCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, {
    email: parsed.data.email,
    roleType: parsed.data.roleType,
    scopeLevel: parsed.data.scopeLevel,
    scopeCode: parsed.data.scopeCode ?? null,
  });

  if (!result.ok || !result.rawToken || !result.email) {
    return { ok: false, error: result.error ?? "Einladung fehlgeschlagen." };
  }

  const inviteUrl = buildInviteUrl(await requestHost(), ctx.tenant.slug, result.rawToken);
  const roleLabel = ROLE_LABELS[result.roleType ?? ""] ?? result.roleType ?? "Mitwirkende:r";
  await sendInvitationEmail(result.email, inviteUrl, roleLabel, ctx.tenant.name);

  return {
    ok: true,
    message: result.resent
      ? "Es bestand bereits eine offene Einladung — sie wurde mit einem neuen Link erneut versendet."
      : "Einladung versendet.",
  };
}

/** Server Action: offene Einladung zurückziehen. */
export async function einladungZurueckziehen(invitationId: string): Promise<InvitationActionResult> {
  // STEP-UP (#59): Kehrseite der Vergabe (wie revokeRole). Das Zurückziehen
  // entzieht eine bereits zugesagte Rolle, bevor sie angenommen wurde — es kann
  // gezielt die Aufnahme einer zweiten, kontrollierenden Person verhindern.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(invitationId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Einladungs-ID." };

  const result = await einladungZurueckziehenCore(
    ctx.db,
    ctx.tenant.id,
    ctx.roleTypes,
    ctx.userId,
    idParsed.data,
  );
  return result.ok ? { ok: true, message: "Einladung zurückgezogen." } : { ok: false, error: result.error };
}

/** Server Action: offene Einladung mit neuem Link erneut versenden. */
export async function einladungErneutSenden(invitationId: string): Promise<InvitationActionResult> {
  // STEP-UP (#59): prägt einen NEUEN gültigen Rollen-Token und schickt ihn nach
  // außen — beides Step-up-Kriterien (Rollenvergabe + Außenwirkung). Ohne diese
  // Schwelle wäre `einladen` umgehbar: eine alte, offene Einladung ließe sich
  // ohne frische Bestätigung zu einem frischen Link machen.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  // SIDE-EFFECT-FENCE (Demo-Spielwiese): wie einladen() — keine Mail nach außen.
  if (isDemoTenant(ctx.tenant.slug)) {
    return { ok: false, error: "Im Demo-Mandanten werden keine Einladungen versendet." };
  }

  const idParsed = z.string().uuid().safeParse(invitationId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Einladungs-ID." };

  const result = await einladungErneutSendenCore(
    ctx.db,
    ctx.tenant.id,
    ctx.roleTypes,
    ctx.userId,
    idParsed.data,
  );

  if (!result.ok || !result.rawToken || !result.email) {
    return { ok: false, error: result.error ?? "Erneutes Senden fehlgeschlagen." };
  }

  const inviteUrl = buildInviteUrl(await requestHost(), ctx.tenant.slug, result.rawToken);
  const roleLabel = ROLE_LABELS[result.roleType ?? ""] ?? result.roleType ?? "Mitwirkende:r";
  await sendInvitationEmail(result.email, inviteUrl, roleLabel, ctx.tenant.name);

  return { ok: true, message: "Einladung mit neuem Link erneut versendet." };
}

export interface AnnehmenActionResult {
  ok: boolean;
  /** true ⇒ nicht eingeloggt: die Seite zeigt einen Anmelde-CTA. */
  needLogin?: boolean;
  roleType?: string;
  /**
   * Block K3 (Vier-Augen): true ⇒ statt der Rolle wurde ein Ernennungs-
   * Vorschlag angelegt — die Rolle bedarf noch der Bestätigung durch eine
   * zweite Person (die UI erklärt das der annehmenden Person).
   */
  pendingApproval?: boolean;
  error?: string;
}

/**
 * Server Action: Einladung annehmen (bewusster POST/Klick — GET verbraucht nie).
 * Erfordert ein per Magic-Link angemeldetes Konto; die E-Mail-Bindung erzwingt
 * der Core (nur das Konto mit der eingeladenen Adresse kann annehmen).
 */
export async function einladungAnnehmen(rawToken: string): Promise<AnnehmenActionResult> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };

  if (!ctx.userId || !ctx.user) {
    return {
      ok: false,
      needLogin: true,
      error: "Bitte melden Sie sich mit der eingeladenen E-Mail-Adresse an.",
    };
  }

  const tokenParsed = z.string().trim().min(1).max(512).safeParse(rawToken);
  if (!tokenParsed.success) {
    return { ok: false, error: "Diese Einladung ist nicht mehr gültig." };
  }

  const result = await einladungAnnehmenCore(ctx.db, ctx.tenant.id, tokenParsed.data, {
    id: ctx.userId,
    email: ctx.user.email,
  });

  return {
    ok: result.ok,
    roleType: result.roleType,
    pendingApproval: result.pendingApproval,
    error: result.error,
  };
}
