/**
 * actions.ts — Server Actions für die Rollen-Verwaltung (Achse B, Gate B).
 *
 * Dünne "use server"-Wrapper: lösen den Auth-Kontext auf (Session-Cookie →
 * Tenant + Caller-UserId + Caller-Rollen) und rufen dann in die testbare
 * Kern-Logik (assignRoleCore / revokeRoleCore in role-actions.ts).
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Admin-Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth;
 * die UI-Filterung ist nur Komfort).
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes } from "@/lib/auth/roles";
import {
  assignRoleCore,
  revokeRoleCore,
  type AssignRoleInput,
  type RevokeRoleInput,
  type RoleActionResult,
} from "@/lib/admin/role-actions";

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

/** Server Action: Rolle zuweisen (auditiert, eskalationsgeschützt). */
export async function assignRole(input: AssignRoleInput): Promise<RoleActionResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  return assignRoleCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, input);
}

/** Server Action: Rolle entziehen (auditiert, letzter-Admin- + eskalationsgeschützt). */
export async function revokeRole(input: RevokeRoleInput): Promise<RoleActionResult> {
  const ctx = await getAdminAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  return revokeRoleCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, input);
}
