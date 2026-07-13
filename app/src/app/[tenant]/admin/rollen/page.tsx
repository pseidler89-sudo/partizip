/**
 * [tenant]/admin/rollen/page.tsx — Rollen-Verwaltung (Achse B, Gate B)
 *
 * Admin-only (kommune_admin/super_admin). Gleicher Auth-/Rollen-Guard wie
 * admin/digests/page.tsx. Tenant-Isolation in jeder Query.
 *
 * Zeigt: Liste aller User des Tenants mit ihren Rollen (E-Mail HIER erlaubt —
 * admin-only, tenant-intern; NICHT zu verwechseln mit der PII-freien
 * Audit-Log-Ansicht) + Entzug-Buttons; Formular zum Zuweisen einer Rolle.
 *
 * Die anzubietenden roleTypes werden serverseitig nach der Caller-Rolle
 * gefiltert (manageableRoleTypes) — der Server erzwingt es zusätzlich in der
 * Action (Defense in Depth).
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, asc } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { users, roles, sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin, manageableRoleTypes } from "@/lib/auth/roles";
import { einladungenListeCore } from "@/lib/admin/invitation-core";
import Link from "next/link";
import { RollenVerwaltung } from "./RollenVerwaltung";
import { EinladungenVerwaltung } from "./EinladungenVerwaltung";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

export default async function AdminRollenPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) redirect(`/${slugFromPath}/anmelden`);

  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();

  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) redirect(`/${slugFromPath}/anmelden`);

  const callerRoleRows = await db
    .select({ roleType: roles.roleType })
    .from(roles)
    .where(and(eq(roles.tenantId, tenant.id), eq(roles.userId, session.userId)));
  const callerRoleTypes = callerRoleRows.map((r: { roleType: string }) => r.roleType);

  if (!isAdmin(callerRoleTypes)) redirect(`/${slugFromPath}/anmelden`);

  // Alle User des Tenants mit ihren Rollen (tenant-scoped LEFT JOIN).
  const userRows = await db
    .select({
      userId: users.id,
      email: users.email,
      accountStatus: users.accountStatus,
      roleId: roles.id,
      roleType: roles.roleType,
      scopeLevel: roles.scopeLevel,
      scopeCode: roles.scopeCode,
    })
    .from(users)
    .leftJoin(roles, and(eq(roles.userId, users.id), eq(roles.tenantId, tenant.id)))
    .where(eq(users.tenantId, tenant.id))
    .orderBy(asc(users.email));

  // Nach User gruppieren.
  type RoleEntry = { roleId: string; roleType: string; scopeLevel: string; scopeCode: string | null };
  const userMap = new Map<
    string,
    { userId: string; email: string; accountStatus: string; roles: RoleEntry[] }
  >();
  for (const row of userRows) {
    let entry = userMap.get(row.userId);
    if (!entry) {
      entry = {
        userId: row.userId,
        email: row.email,
        accountStatus: row.accountStatus,
        roles: [],
      };
      userMap.set(row.userId, entry);
    }
    if (row.roleId && row.roleType && row.scopeLevel) {
      entry.roles.push({
        roleId: row.roleId,
        roleType: row.roleType,
        scopeLevel: row.scopeLevel,
        scopeCode: row.scopeCode,
      });
    }
  }
  const tenantUsers = Array.from(userMap.values());

  // Nur die für den Caller erlaubten roleTypes anbieten (Server erzwingt zusätzlich).
  const erlaubteRollen = manageableRoleTypes(callerRoleTypes);

  // Einladungen (neueste zuerst) — für den Einladungs-Bereich. Kein token_hash.
  const einladungen = (await einladungenListeCore(db, tenant.id)).map((e) => ({
    id: e.id,
    email: e.email,
    roleType: e.roleType,
    scopeLevel: e.scopeLevel,
    scopeCode: e.scopeCode,
    status: e.status,
    resendCount: e.resendCount,
    expiresAt: e.expiresAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
  }));

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      <div className="mb-8">
        <Link
          href={`/${slugFromPath}/admin`}
          className="text-sm text-zinc-500 hover:text-zinc-700"
        >
          ← Admin-Bereich
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900">Rollen verwalten</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Rollen zuweisen und entziehen. Jede Änderung wird im Protokoll PII-frei
          erfasst. {tenant.name}
        </p>
      </div>

      <RollenVerwaltung
        tenantSlug={slugFromPath}
        users={tenantUsers}
        erlaubteRollen={erlaubteRollen}
      />

      <div className="mt-12 border-t border-zinc-200 pt-10">
        <EinladungenVerwaltung
          erlaubteRollen={erlaubteRollen}
          einladungen={einladungen}
        />
      </div>
    </main>
  );
}
