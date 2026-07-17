/**
 * [tenant]/admin/protokoll/page.tsx — Audit-Log-Ansicht (Achse B, Gate B)
 *
 * Read-only, admin-only (kommune_admin/super_admin). Listet die letzten N
 * audit_events des Tenants, absteigend nach createdAt.
 *
 * PII-FREIHEIT (nicht verhandelbar):
 *   - KEIN Join auf users.email, KEINE E-Mail-Anzeige.
 *   - actorRef / targetId werden GEKÜRZT angezeigt (erste 8 Zeichen der UUID)
 *     oder „—" wenn null. Roh-UUIDs sind kein PII (kein Klarname), die Kürzung
 *     reduziert zusätzlich die Re-Identifizierbarkeit in Screenshots/Exports.
 *   - metadata wird bewusst NICHT roh gerendert (könnte künftig versehentlich
 *     PII enthalten) — nur whitelist-Felder (roleType, scopeLevel, …).
 *
 * Filter (?filter=privileg): zeigt nur privilegierte Aktionen.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, desc, inArray } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { auditEvents, sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin, getUserRoleTypes } from "@/lib/auth/roles";
import Link from "next/link";

const LIMIT = 200;

/** Privilegierte Aktionen für den optionalen Filter ?filter=privileg. */
const PRIVILEGIERTE_ACTIONS = [
  "role.granted",
  "role.revoked",
  "digest.approved",
  "digest.published",
  "anliegen.status_changed",
  "anliegen.verborgen",
  "anliegen.wiederhergestellt",
  "konto.deleted",
];

/** Menschenlesbare Labels (rein kosmetisch; unbekannte Actions roh anzeigen). */
const ACTION_LABELS: Record<string, string> = {
  "role.granted": "Rolle vergeben",
  "role.revoked": "Rolle entzogen",
  "digest.approved": "Digest freigegeben",
  "digest.published": "Digest veröffentlicht",
  "digest.statements_geprueft": "Aussagen geprüft",
  "anliegen.status_changed": "Anliegen-Status geändert",
  "anliegen.verborgen": "Anliegen verborgen",
  "anliegen.wiederhergestellt": "Anliegen wiederhergestellt",
  "konto.deleted": "Konto gelöscht",
};

/** Kürzt eine UUID/Referenz PII-arm auf die ersten 8 Zeichen (oder „—"). */
function kuerze(ref: string | null): string {
  if (!ref) return "—";
  return ref.length > 8 ? `${ref.slice(0, 8)}…` : ref;
}

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ filter?: string }>;
}

export default async function AdminProtokollPage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const { filter } = await searchParams;
  const nurPrivileg = filter === "privileg";

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
  // ein gesperrtes/gelöschtes Konto erhält [] und kann das Audit-Log nicht laden.
  const callerRoleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  if (!isAdmin(callerRoleTypes)) redirect(`/${slugFromPath}/anmelden`);

  // Tenant-scoped + optional auf privilegierte Aktionen gefiltert.
  // KEIN Join auf users — PII-frei.
  const whereClause = nurPrivileg
    ? and(eq(auditEvents.tenantId, tenant.id), inArray(auditEvents.action, PRIVILEGIERTE_ACTIONS))
    : eq(auditEvents.tenantId, tenant.id);

  const events = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorType: auditEvents.actorType,
      actorRef: auditEvents.actorRef,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(whereClause)
    .orderBy(desc(auditEvents.createdAt))
    .limit(LIMIT);

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      <div className="mb-6">
        <Link href={`/${slugFromPath}/admin`} className="text-sm text-pz-muted hover:text-pz-body">
          ← Admin-Bereich
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-pz-ink">Protokoll</h1>
        <p className="text-sm text-pz-muted mt-1">
          Technisches Audit-Log (PII-frei, ohne E-Mail). Letzte {LIMIT} Ereignisse,
          neueste zuerst.
        </p>
      </div>

      {/* Filter-Umschalter */}
      <div className="mb-5 flex gap-2 text-sm">
        <Link
          href={`/${slugFromPath}/admin/protokoll`}
          className={`rounded-md px-3 py-1 ${
            !nurPrivileg ? "bg-[color:var(--pz-brand)] text-white" : "border border-pz-line text-pz-body hover:bg-pz-brand-soft"
          }`}
        >
          Alle
        </Link>
        <Link
          href={`/${slugFromPath}/admin/protokoll?filter=privileg`}
          className={`rounded-md px-3 py-1 ${
            nurPrivileg ? "bg-[color:var(--pz-brand)] text-white" : "border border-pz-line text-pz-body hover:bg-pz-brand-soft"
          }`}
        >
          Nur privilegierte Aktionen
        </Link>
      </div>

      {events.length === 0 ? (
        <div className="rounded-lg border border-pz-line p-8 text-center text-pz-muted">
          Keine Protokoll-Einträge.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-pz-line">
          <table className="w-full text-sm">
            <thead className="bg-pz-surface text-left text-xs uppercase tracking-wide text-pz-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Zeitpunkt</th>
                <th className="px-4 py-2 font-medium">Aktion</th>
                <th className="px-4 py-2 font-medium">Akteur</th>
                <th className="px-4 py-2 font-medium">Ziel</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-pz-line">
              {events.map((e: typeof events[number]) => (
                <tr key={e.id} className="text-pz-body">
                  <td className="whitespace-nowrap px-4 py-2 text-pz-muted">
                    {e.createdAt.toLocaleString("de-DE")}
                  </td>
                  <td className="px-4 py-2">
                    <span className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</span>
                    <span className="block text-xs text-pz-muted">{e.action}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className="text-pz-muted">{e.actorType}</span>{" "}
                    <span className="font-mono text-xs text-pz-muted">{kuerze(e.actorRef)}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {e.targetType ? (
                      <>
                        <span className="text-pz-muted">{e.targetType}</span>{" "}
                        <span className="font-mono text-xs text-pz-muted">{kuerze(e.targetId)}</span>
                      </>
                    ) : (
                      <span className="text-pz-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
