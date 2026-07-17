/**
 * konto-sicherheit-actions.ts — Server Actions der Konto-Sicherheit (Block K2):
 * Sitzungen beenden, Konto sperren/entsperren, Offboarding, Sperren per E-Mail.
 *
 * Dünne "use server"-Wrapper (Muster lib/admin/actions.ts): lösen den
 * Auth-Kontext auf (Session-Cookie → Tenant + Caller-UserId + Caller-Rollen),
 * validieren per zod und delegieren in die testbare Kern-Logik
 * (konto-sicherheit-core.ts).
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Admin-Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth;
 * die UI-Filterung ist nur Komfort).
 *
 * SIDE-EFFECT-FENCE (Muster Block I): auf dem Demo-Mandanten sind alle
 * Konto-Mutationen gesperrt — der ephemere Demo-Admin darf keine persistenten
 * Konten sperren/offboarden oder deren Sitzungen beenden. Fail-closed.
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
import {
  sessionsBeendenCore,
  kontoSperrenCore,
  kontoEntsperrenCore,
  offboardingCore,
  kontoSperrenPerEmailCore,
  type KontoSicherheitResult,
} from "@/lib/admin/konto-sicherheit-core";

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

/**
 * SIDE-EFFECT-FENCE (analog DEMO_ROLLEN_GESPERRT in actions.ts): Konto-
 * Mutationen sind auf dem Demo-Mandanten gesperrt — der ephemere Demo-Admin
 * dürfte sonst PERSISTENTE Konten sperren oder deren Sitzungen beenden.
 * Fail-closed.
 */
const DEMO_KONTO_GESPERRT = "Im Demo-Mandanten werden Konten nicht verändert.";

const targetSchema = z.object({ targetUserId: z.string().uuid("Ungültige Konto-ID.") });

export type KontoSicherheitInput = { targetUserId: string };

/** Server Action: alle aktiven Sitzungen eines Kontos beenden (auditiert). */
export async function sessionsBeenden(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return sessionsBeendenCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/** Server Action: Konto sperren + alle Sitzungen beenden (auditiert, umkehrbar). */
export async function kontoSperren(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return kontoSperrenCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/** Server Action: gesperrtes Konto entsperren (auditiert). */
export async function kontoEntsperren(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return kontoEntsperrenCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/** Server Action: Offboarding — alle Rollen + Sitzungen entfernen, Konto bleibt aktiv. */
export async function offboarding(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return offboardingCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/**
 * Server Action: Konto per E-Mail sperren (IR-Notfall — Bürger:in ohne Rolle,
 * die nicht in der Rollen-Liste steht). E-Mail-Auflösung tenant-scoped und
 * normalisiert im Core; nicht gefunden ⇒ generisch „Konto nicht gefunden.".
 */
export async function kontoSperrenPerEmail(
  targetEmail: string,
): Promise<KontoSicherheitResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = z.string().trim().min(1, "Bitte eine E-Mail-Adresse angeben.").max(320)
    .safeParse(targetEmail);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return kontoSperrenPerEmailCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data,
  );
}
