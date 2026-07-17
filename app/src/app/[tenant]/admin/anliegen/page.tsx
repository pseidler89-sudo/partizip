/**
 * [tenant]/admin/anliegen/page.tsx — Admin-Anliegen-Liste (M8)
 *
 * Nur für kommune_admin und super_admin.
 * Tenant-Isolierung: nur eigene Anliegen sichtbar.
 * Filter nach Status möglich.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, desc } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { anliegen, ortsteile, sessions, anliegenStatusEnum } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin, getUserRoleTypes } from "@/lib/auth/roles";
import Link from "next/link";

const STATUS_LABELS: Record<string, string> = {
  eingegangen: "Eingegangen",
  in_pruefung: "In Prüfung",
  im_gremium: "Im Gremium",
  beantwortet: "Beantwortet",
  umgesetzt: "Umgesetzt",
  abgelehnt: "Abgelehnt",
  zurueckgezogen: "Zurückgezogen",
};

const STATUS_COLORS: Record<string, string> = {
  eingegangen: "pz-badge-info",
  in_pruefung: "pz-badge-warning",
  im_gremium: "pz-badge-warning",
  beantwortet: "pz-badge-success",
  umgesetzt: "pz-badge-success",
  abgelehnt: "pz-badge-neutral",
  zurueckgezogen: "pz-badge-neutral",
};

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ status?: string }>;
}

export default async function AdminAnliegenPage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const { status: filterStatus } = await searchParams;

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
  if (!session || session.revokedAt || session.expiresAt < now) {
    redirect(`/${slugFromPath}/anmelden`);
  }

  // Rollen account-status-gefiltert laden (kein Direktzugriff auf `roles`): ein
  // gesperrtes/gelöschtes Konto erhält [] und kann die Anliegen-Liste (ggf. PII)
  // nicht laden.
  const roleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  if (!isAdmin(roleTypes)) redirect(`/${slugFromPath}/anmelden`);

  // Anliegen laden (tenant-scoped, optional nach Status gefiltert).
  // validStatuses + Typ direkt aus dem Enum abgeleitet → kein Drift, kein `as any`.
  type AnliegenStatus = (typeof anliegenStatusEnum.enumValues)[number];
  const validStatuses = anliegenStatusEnum.enumValues as readonly string[];
  const statusFilter: AnliegenStatus | null =
    filterStatus && validStatuses.includes(filterStatus)
      ? (filterStatus as AnliegenStatus)
      : null;

  type AnliegenRow = {
    id: string;
    trackingCode: string;
    titel: string;
    status: string;
    createdAt: Date;
    ortsteilId: string | null;
    verborgenAt: Date | null;
  };

  let anliegenRows: AnliegenRow[];
  if (statusFilter) {
    anliegenRows = await db
      .select({
        id: anliegen.id,
        trackingCode: anliegen.trackingCode,
        titel: anliegen.titel,
        status: anliegen.status,
        createdAt: anliegen.createdAt,
        ortsteilId: anliegen.ortsteilId,
        verborgenAt: anliegen.verborgenAt,
      })
      .from(anliegen)
      .where(
        and(
          eq(anliegen.tenantId, tenant.id),
          eq(anliegen.status, statusFilter)
        )
      )
      .orderBy(desc(anliegen.createdAt));
  } else {
    anliegenRows = await db
      .select({
        id: anliegen.id,
        trackingCode: anliegen.trackingCode,
        titel: anliegen.titel,
        status: anliegen.status,
        createdAt: anliegen.createdAt,
        ortsteilId: anliegen.ortsteilId,
        verborgenAt: anliegen.verborgenAt,
      })
      .from(anliegen)
      .where(eq(anliegen.tenantId, tenant.id))
      .orderBy(desc(anliegen.createdAt));
  }

  // Ortsteile für Anzeige
  const ortsteilMap = new Map<string, string>();
  const ortsteilRows = await db
    .select({ id: ortsteile.id, name: ortsteile.name })
    .from(ortsteile)
    .where(eq(ortsteile.tenantId, tenant.id));
  for (const o of ortsteilRows) ortsteilMap.set(o.id, o.name);

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-pz-ink">Anliegen verwalten</h1>
          <p className="text-sm text-pz-muted mt-1">
            Alle eingereichten Anliegen — {anliegenRows.length} gesamt.
          </p>
        </div>
        <Link
          href={`/${slugFromPath}/admin`}
          className="text-sm text-pz-muted hover:text-pz-body"
        >
          ← Admin-Bereich
        </Link>
      </div>

      {/* Status-Filter */}
      <div className="mb-6 flex flex-wrap gap-2">
        <Link
          href={`/${slugFromPath}/admin/anliegen`}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            !statusFilter ? "bg-[color:var(--pz-brand)] text-white" : "pz-badge-neutral hover:opacity-80"
          }`}
        >
          Alle
        </Link>
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={`/${slugFromPath}/admin/anliegen?status=${key}`}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === key
                ? "bg-[color:var(--pz-brand)] text-white"
                : `${STATUS_COLORS[key]} hover:opacity-80`
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {anliegenRows.length === 0 ? (
        <div className="rounded-lg border border-pz-line p-8 text-center text-pz-muted">
          <p>Keine Anliegen gefunden.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {anliegenRows.map((a) => (
            <Link
              key={a.id}
              href={`/${slugFromPath}/admin/anliegen/${a.id}`}
              className="block rounded-lg border border-pz-line px-5 py-4 hover:border-pz-line hover:bg-pz-brand-soft transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-pz-ink truncate">{a.titel}</p>
                  <p className="text-sm text-pz-muted mt-0.5 font-mono">{a.trackingCode}</p>
                  <p className="text-xs text-pz-muted mt-0.5">
                    {a.createdAt.toLocaleDateString("de-DE")}
                    {a.ortsteilId && ortsteilMap.has(a.ortsteilId) && (
                      <> · {ortsteilMap.get(a.ortsteilId)}</>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.verborgenAt && (
                    <span className="rounded-full px-2.5 py-0.5 text-xs font-medium bg-red-100 text-red-800">
                      Verborgen
                    </span>
                  )}
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] ?? "pz-badge-neutral"}`}>
                    {STATUS_LABELS[a.status] ?? a.status}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
