/**
 * invitation-actions.ts — Server Actions für den Einladungs-Flow (Gate B).
 *
 * Dünne "use server"-Wrapper: lösen den Auth-Kontext auf (Session-Cookie →
 * Tenant + Caller-UserId + Caller-Rollen) und delegieren dann in die testbare
 * Kern-Logik (invitation-core.ts). Der Mailversand (Roh-Token nur in der URL)
 * passiert hier — die Cores geben den Roh-Token GENAU EINMAL zurück.
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth; die
 * UI-Filterung ist nur Komfort).
 *
 * Autorisierung:
 *   - einladen/zurückziehen/erneutSenden: NUR Admin (kommune_admin/super_admin),
 *     serverseitig hart; die konkrete Ziel-Rolle zusätzlich über canManageRole
 *     (Eskalationsgrenze) in den Cores.
 *   - annehmen: der/die Eingeladene, per Magic-Link authentifiziert (Konto muss
 *     existieren + eingeloggt sein); die E-Mail-Bindung erzwingt der Core.
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "@/db/client";
import { sessions } from "@/db/schema";
import { SCOPE_INPUT_LEVELS } from "@/lib/region/ebenen";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes } from "@/lib/auth/roles";
import { getOptionalAuthContext } from "@/lib/auth/action-context";
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

type AdminAuthContext = {
  tenant: { id: string; slug: string; name: string };
  userId: string;
  roleTypes: string[];
  db: Db;
  host: string;
};

async function getAdminAuthContext(): Promise<AdminAuthContext | null> {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return null;

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);

  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
    .limit(1);
  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) return null;

  const roleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  return {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    userId: session.userId,
    roleTypes,
    db,
    host,
  };
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
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

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

  const inviteUrl = buildInviteUrl(ctx.host, ctx.tenant.slug, result.rawToken);
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
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

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
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

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

  const inviteUrl = buildInviteUrl(ctx.host, ctx.tenant.slug, result.rawToken);
  const roleLabel = ROLE_LABELS[result.roleType ?? ""] ?? result.roleType ?? "Mitwirkende:r";
  await sendInvitationEmail(result.email, inviteUrl, roleLabel, ctx.tenant.name);

  return { ok: true, message: "Einladung mit neuem Link erneut versendet." };
}

export interface AnnehmenActionResult {
  ok: boolean;
  /** true ⇒ nicht eingeloggt: die Seite zeigt einen Anmelde-CTA. */
  needLogin?: boolean;
  roleType?: string;
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

  return { ok: result.ok, roleType: result.roleType, error: result.error };
}
