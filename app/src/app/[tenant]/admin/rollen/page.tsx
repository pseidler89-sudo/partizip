/**
 * [tenant]/admin/rollen/page.tsx — Rollen-Verwaltung (Achse B, Gate B)
 *
 * Admin-only (kommune_admin/super_admin). Gleicher Auth-/Rollen-Guard wie
 * admin/digests/page.tsx. Tenant-Isolation in jeder Query.
 *
 * Zeigt: Liste aller User des Tenants mit ihren Rollen (E-Mail HIER erlaubt —
 * admin-only, tenant-intern; NICHT zu verwechseln mit der PII-freien
 * Audit-Log-Ansicht) + Entzug-Buttons; Formular zum Zuweisen einer Rolle.
 * Block K2: zusätzlich je User die Anzahl aktiver Sitzungen (eine
 * Aggregat-Query) für die Konto-Sicherheits-Aktionen (Sperren/Entsperren,
 * Sitzungen beenden, Offboarding).
 *
 * Die anzubietenden roleTypes werden serverseitig nach der Caller-Rolle
 * gefiltert (manageableRoleTypes) — der Server erzwingt es zusätzlich in der
 * Action (Defense in Depth).
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, asc, count, gt, isNull } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { users, roles, sessions, regions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin, manageableRoleTypes, getUserRoleTypes } from "@/lib/auth/roles";
import { isDemoTenant } from "@/lib/demo/config";
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

  // Caller-Rollen account-status-gefiltert laden (kein Direktzugriff auf `roles`):
  // ein gesperrtes/gelöschtes Konto erhält [] und kann die Rollen-Verwaltung nicht
  // laden — konsistent mit den übrigen Admin-Lese-Sichten.
  const callerRoleTypes = await getUserRoleTypes(db, tenant.id, session.userId);

  if (!isAdmin(callerRoleTypes)) redirect(`/${slugFromPath}/anmelden`);

  // Alle User des Tenants mit ihren Rollen (tenant-scoped LEFT JOIN).
  const userRows = await db
    .select({
      userId: users.id,
      email: users.email,
      accountStatus: users.accountStatus,
      roleId: roles.id,
      roleType: roles.roleType,
      // ADR-024: Gebietsart + Name des Rollen-Knotens (statt scope_level/scope_code).
      regionTyp: regions.typ,
      regionName: regions.name,
    })
    .from(users)
    .leftJoin(roles, and(eq(roles.userId, users.id), eq(roles.tenantId, tenant.id)))
    .leftJoin(regions, eq(regions.id, roles.regionId))
    .where(eq(users.tenantId, tenant.id))
    .orderBy(asc(users.email));

  // Block K2: Anzahl AKTIVER Sitzungen je User — EINE Aggregat-Query (kein N+1),
  // rein informativ für die Konto-Sicherheits-Fläche. „Aktiv" = nicht revoziert
  // und nicht abgelaufen (JS-Date nur als gebundener Drizzle-Parameter).
  const sessionCountRows = await db
    .select({ userId: sessions.userId, n: count() })
    .from(sessions)
    .where(
      and(
        eq(sessions.tenantId, tenant.id),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .groupBy(sessions.userId);
  const sessionCountMap = new Map<string, number>(
    sessionCountRows.map((r: { userId: string; n: number }) => [r.userId, r.n]),
  );

  // Nach User gruppieren.
  type RoleEntry = { roleId: string; roleType: string; regionTyp: string; regionName: string };
  const userMap = new Map<
    string,
    {
      userId: string;
      email: string;
      accountStatus: string;
      aktiveSitzungen: number;
      roles: RoleEntry[];
    }
  >();
  for (const row of userRows) {
    let entry = userMap.get(row.userId);
    if (!entry) {
      entry = {
        userId: row.userId,
        email: row.email,
        accountStatus: row.accountStatus,
        aktiveSitzungen: sessionCountMap.get(row.userId) ?? 0,
        roles: [],
      };
      userMap.set(row.userId, entry);
    }
    if (row.roleId && row.roleType && row.regionTyp) {
      entry.roles.push({
        roleId: row.roleId,
        roleType: row.roleType,
        regionTyp: row.regionTyp,
        regionName: row.regionName ?? "",
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
    regionTyp: e.regionTyp,
    regionName: e.regionName,
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
          className="text-sm text-pz-muted hover:text-pz-body"
        >
          ← Admin-Bereich
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-pz-ink">Rollen verwalten</h1>
        <p className="text-sm text-pz-muted mt-1">
          Rollen zuweisen und entziehen. Jede Änderung wird im Protokoll PII-frei
          erfasst. {tenant.name}
        </p>
      </div>

      <RollenVerwaltung
        tenantSlug={slugFromPath}
        users={tenantUsers}
        erlaubteRollen={erlaubteRollen}
        callerUserId={session.userId}
      />

      <div className="mt-12 border-t border-pz-line pt-10">
        {/* Demo-Spielwiese: das Einladungs-Formular entfällt — die Server-Actions
            lehnen den Versand auf dem Demo-Mandanten ohnehin ab (Side-Effect-
            Fence gegen Spam über den echten SMTP-Server); die UI erklärt es
            freundlich statt einen Fehler zu provozieren. */}
        {isDemoTenant(tenant.slug) ? (
          <div
            className="rounded-lg border p-4 text-sm"
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-muted)" }}
          >
            <strong style={{ color: "var(--pz-ink)" }}>Demo-Spielwiese:</strong>{" "}
            Einladungen sind hier deaktiviert — es werden keine echten E-Mails
            versendet. Die Rollen des Demo-Mandanten sehen Sie oben.
          </div>
        ) : (
          <EinladungenVerwaltung
            erlaubteRollen={erlaubteRollen}
            einladungen={einladungen}
          />
        )}
      </div>
    </main>
  );
}
