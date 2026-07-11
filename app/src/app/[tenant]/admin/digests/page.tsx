/**
 * [tenant]/admin/digests/page.tsx — Admin-Digest-Liste (M7)
 *
 * Zeigt alle Digests des Tenants nach Status.
 * Sichtbar für redakteur, kommune_admin und super_admin (Freigabe nur Admins).
 * Tenant-Isolierung: nur eigene Digests sichtbar.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, desc, sql } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { digests, risMeetings, roles, sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { canRedaktion } from "@/lib/auth/roles";
import Link from "next/link";

async function getAdminDigests(tenantSlug: string) {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== tenantSlug) return null;

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return { tenant, digests: null, isAdmin: false };

  const tokenHash = sha256Hex(rawToken);
  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );

  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) {
    return { tenant, digests: null, isAdmin: false };
  }

  const roleRows = await db
    .select({ roleType: roles.roleType })
    .from(roles)
    .where(and(eq(roles.tenantId, tenant.id), eq(roles.userId, session.userId)));
  const roleTypes = roleRows.map((r: { roleType: string }) => r.roleType);

  // H1: Redakteure dürfen die Liste sehen (prüfen); Freigabe nur Admins (Detailseite).
  if (!canRedaktion(roleTypes)) return { tenant, digests: null, isAdmin: false };

  const digestRows = await db
    .select({
      id: digests.id,
      title: digests.title,
      status: digests.status,
      generator: digests.generator,
      createdAt: digests.createdAt,
      approvedAt: digests.approvedAt,
      publishedAt: digests.publishedAt,
      meetingId: digests.meetingId,
    })
    .from(digests)
    .innerJoin(risMeetings, eq(digests.meetingId, risMeetings.id))
    .where(eq(digests.tenantId, tenant.id))
    // Neueste Sitzung oben: primär Sitzungsdatum (NULLS LAST), dann Erstelldatum.
    .orderBy(sql`${risMeetings.meetingDate} desc nulls last`, desc(digests.createdAt));

  return { tenant, digests: digestRows, isAdmin: true };
}

interface PageProps {
  params: Promise<{ tenant: string }>;
}

export default async function AdminDigestsPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const data = await getAdminDigests(slugFromPath);

  if (!data) notFound();
  if (!data.isAdmin || data.digests === null) {
    redirect(`/${slugFromPath}/anmelden`);
  }

  const statusLabel: Record<string, string> = {
    entwurf: "Entwurf",
    freigegeben: "Freigegeben",
    veroeffentlicht: "Veröffentlicht",
  };

  const statusBadge: Record<string, string> = {
    entwurf: "pz-badge-warning",
    freigegeben: "pz-badge-info",
    veroeffentlicht: "pz-badge-success",
  };

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-900">Digests verwalten</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Alle Sitzungszusammenfassungen — Entwürfe, Freigegebene und Veröffentlichte.
        </p>
      </div>

      {data.digests.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 p-8 text-center text-zinc-500">
          <p>Noch keine Digests vorhanden.</p>
          <p className="text-sm mt-2">
            Importiere zuerst Sitzungen mit{" "}
            <code className="bg-zinc-100 px-1 py-0.5 rounded text-xs">npm run ris:import</code>
            {" "}und erzeuge dann Digests mit{" "}
            <code className="bg-zinc-100 px-1 py-0.5 rounded text-xs">npm run digest:generate</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.digests.map((d: typeof data.digests[number]) => (
            <Link
              key={d.id}
              href={`/${slugFromPath}/admin/digests/${d.id}`}
              className="block rounded-lg border border-zinc-200 px-5 py-4 hover:border-zinc-300 hover:bg-zinc-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 truncate">{d.title}</p>
                  <p className="text-sm text-zinc-500 mt-0.5">
                    Erstellt: {d.createdAt.toLocaleDateString("de-DE")}
                    {d.approvedAt && ` · Freigegeben: ${d.approvedAt.toLocaleDateString("de-DE")}`}
                    {d.publishedAt && ` · Veröffentlicht: ${d.publishedAt.toLocaleDateString("de-DE")}`}
                  </p>
                </div>
                <span
                  className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge[d.status] ?? "bg-zinc-100 text-zinc-800"}`}
                >
                  {statusLabel[d.status] ?? d.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
