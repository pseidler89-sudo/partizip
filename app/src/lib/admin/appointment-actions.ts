/**
 * appointment-actions.ts — Server Actions der Vier-Augen-Verifier-Ernennung
 * (Block K3): vorschlagen, entscheiden (bestätigen/ablehnen), zurückziehen.
 *
 * Dünne "use server"-Wrapper (Muster lib/admin/actions.ts / konto-sicherheit-
 * actions.ts): lösen den Auth-Kontext auf (Session-Cookie → Tenant + Caller-
 * UserId + Caller-Rollen), validieren per zod und delegieren in die testbare
 * Kern-Logik (appointment-core.ts).
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Admin-Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth;
 * die UI-Filterung ist nur Komfort).
 *
 * SoD: `allowSelfApproval` wird AUSSCHLIESSLICH serverseitig über
 * isSelfApprovalAllowed() (lib/digest/freigabe-core.ts, ALLOW_SELF_APPROVAL)
 * bestimmt — NIE vom Client entgegengenommen (fail-closed Vier-Augen-Pflicht).
 *
 * SIDE-EFFECT-FENCE (Muster Block I): auf dem Demo-Mandanten sind Rollen-
 * Mutationen gesperrt — gleicher Wortlaut wie actions.ts. Fail-closed.
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "@/db/client";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes } from "@/lib/auth/roles";
import { isDemoTenant } from "@/lib/demo/config";
import { SCOPE_INPUT_LEVELS } from "@/lib/region/ebenen";
import { isSelfApprovalAllowed } from "@/lib/digest/freigabe-core";
import {
  verifierErnennungVorschlagenCore,
  verifierErnennungEntscheidenCore,
  verifierErnennungZurueckziehenCore,
  type ErnennungResult,
} from "@/lib/admin/appointment-core";

type AdminAuthContext = {
  tenant: { id: string; slug: string };
  userId: string;
  roleTypes: string[];
  db: Db;
};

async function getAdminAuthContext(): Promise<AdminAuthContext | null> {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return null;

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const tokenHash = sha256Hex(rawToken);
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);

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
    tenant: { id: tenant.id, slug: tenant.slug },
    userId: session.userId,
    roleTypes,
    db,
  };
}

/** SIDE-EFFECT-FENCE — gleicher Wortlaut wie die Rollen-Actions (actions.ts). */
const DEMO_ROLLEN_GESPERRT = "Im Demo-Mandanten werden Rollen nicht verändert.";

const vorschlagenSchema = z.object({
  targetEmail: z.string().email("Bitte eine gültige E-Mail-Adresse angeben."),
  scopeLevel: z.enum(SCOPE_INPUT_LEVELS).optional(),
  scopeCode: z.string().trim().max(100).optional().nullable(),
});

const entscheidenSchema = z.object({
  appointmentId: z.string().uuid("Ungültige Vorschlags-ID."),
  entscheidung: z.enum(["bestaetigen", "ablehnen"]),
});

const zurueckziehenSchema = z.object({
  appointmentId: z.string().uuid("Ungültige Vorschlags-ID."),
});

export type ErnennungVorschlagenActionInput = z.input<typeof vorschlagenSchema>;
export type ErnennungEntscheidenActionInput = z.input<typeof entscheidenSchema>;

/** Server Action: Verifier-Ernennung vorschlagen (Schritt 1, auditiert). */
export async function verifierErnennungVorschlagen(
  rawInput: ErnennungVorschlagenActionInput,
): Promise<ErnennungResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  const parsed = vorschlagenSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return verifierErnennungVorschlagenCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, {
    targetEmail: parsed.data.targetEmail,
    scopeLevel: parsed.data.scopeLevel,
    scopeCode: parsed.data.scopeCode ?? null,
  });
}

/**
 * Server Action: Vorschlag bestätigen ODER ablehnen (Schritt 2, auditiert).
 * `allowSelfApproval` kommt NUR aus isSelfApprovalAllowed() — nie vom Client.
 */
export async function verifierErnennungEntscheiden(
  rawInput: ErnennungEntscheidenActionInput,
): Promise<ErnennungResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  const parsed = entscheidenSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return verifierErnennungEntscheidenCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, {
    appointmentId: parsed.data.appointmentId,
    entscheidung: parsed.data.entscheidung,
    allowSelfApproval: isSelfApprovalAllowed(),
  });
}

/** Server Action: offenen Vorschlag zurückziehen (auditiert). */
export async function verifierErnennungZurueckziehen(
  rawInput: { appointmentId: string },
): Promise<ErnennungResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  const parsed = zurueckziehenSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return verifierErnennungZurueckziehenCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, {
    appointmentId: parsed.data.appointmentId,
  });
}
