/**
 * [tenant]/admin/abstimmungen/page.tsx — Composer & Verwaltung der Abstimmungen (M5).
 *
 * Nur für Admins (kommune_admin / super_admin). Auth-/Rollen-Guard identisch zu
 * admin/digests/page.tsx: Tenant aus Host, Session aus Cookie, Rollen aus der DB;
 * fehlt die Berechtigung → redirect auf /anmelden.
 *
 * Zeigt:
 *   - das Erstellen-Formular (Client) → legt einen Entwurf an,
 *   - die Übersicht aller Umfragen des Tenants, gruppiert nach Status
 *     (Entwurf / Aktiv / Geschlossen), je Karte mit Scope, Verbindlich-Badge,
 *     Stimmenzählern, Daten und den passenden Lebenszyklus-Aktionen.
 *
 * Alles tenant-scoped; die Lebenszyklus-Actions erzwingen Berechtigung + Status
 * zusätzlich serverseitig (atomare Guards).
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, asc } from "drizzle-orm";
import Link from "next/link";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { ortsteile as ortsteileTable, roles, sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/roles";
import { getAllPollsForAdmin, type PollAdminItem } from "@/lib/polls/queries";
import PollComposerForm from "./PollComposerForm";
import PollAdminActions from "./PollAdminActions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

const SCOPE_LABELS: Record<string, string> = {
  ortsteil: "Ortsteil",
  stadt: "Kommune",
  kreis: "Kreis",
  land: "Land",
};

const STATUS_TITLES: { key: "entwurf" | "aktiv" | "geschlossen"; titel: string; hint: string }[] = [
  { key: "entwurf", titel: "Entwürfe", hint: "Noch nicht veröffentlicht — aktivieren oder löschen." },
  { key: "aktiv", titel: "Aktive Abstimmungen", hint: "Bürger:innen stimmen mit." },
  { key: "geschlossen", titel: "Geschlossene Abstimmungen", hint: "Beendet — Ergebnis bleibt erhalten." },
];

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

function fmtDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scopeLabel(p: PollAdminItem): string {
  const base = SCOPE_LABELS[p.scopeLevel] ?? p.scopeLevel;
  return p.scopeLevel === "ortsteil" && p.scopeCode ? `${base}: ${p.scopeCode}` : base;
}

export default async function AdminAbstimmungenPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) redirect(`/${slugFromPath}/anmelden`);

  const db = createDb(databaseUrl());
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

  const roleRows = await db
    .select({ roleType: roles.roleType })
    .from(roles)
    .where(and(eq(roles.tenantId, tenant.id), eq(roles.userId, session.userId)));
  const roleTypes = roleRows.map((r: { roleType: string }) => r.roleType);

  if (!isAdmin(roleTypes)) redirect(`/${slugFromPath}/anmelden`);

  // Ortsteile (für das Ortsteil-Dropdown) + alle Umfragen mit Zählern.
  const ortsteilRows = await db
    .select({ code: ortsteileTable.code, name: ortsteileTable.name })
    .from(ortsteileTable)
    .where(eq(ortsteileTable.tenantId, tenant.id))
    .orderBy(asc(ortsteileTable.name));

  const allPolls = await getAllPollsForAdmin(db, tenant.id);
  const byStatus = (s: string) => allPolls.filter((p) => p.status === s);

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Abstimmungen verwalten
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
          Hier erstellen Sie Abstimmungen für Ihre Kommune oder einen Ortsteil —
          Bürger:innen stimmen ab Stufe 1 (angemeldet) mit. Verbindliche
          Abstimmungen sind wohnsitz-verifizierten Bürger:innen vorbehalten.
        </p>
      </div>

      {/* Erstellen-Formular */}
      <PollComposerForm ortsteile={ortsteilRows} />

      {/* Übersicht, gruppiert nach Status */}
      <div className="mt-10 space-y-10">
        {STATUS_TITLES.map(({ key, titel, hint }) => {
          const items = byStatus(key);
          return (
            <section key={key}>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
                  {titel}
                  <span className="ml-2 text-sm font-normal" style={{ color: "var(--pz-muted)" }}>
                    ({items.length})
                  </span>
                </h2>
                <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
                  {hint}
                </p>
              </div>

              {items.length === 0 ? (
                <p
                  className="rounded-lg border border-dashed px-4 py-6 text-center text-sm"
                  style={{ borderColor: "var(--pz-line)", color: "var(--pz-muted)" }}
                >
                  Keine Abstimmungen in diesem Status.
                </p>
              ) : (
                <ul className="space-y-3">
                  {items.map((p) => {
                    const opens = fmtDate(p.opensAt);
                    const closes = fmtDate(p.closesAt);
                    const created = fmtDate(p.createdAt);
                    return (
                      <li key={p.id} className="pz-card p-5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                            style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
                          >
                            {scopeLabel(p)}
                          </span>
                          {p.verbindlich ? (
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                              Verbindlich (nur verifiziert)
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                              style={{ backgroundColor: "var(--pz-line)", color: "var(--pz-body)" }}
                            >
                              Stimmungsbild
                            </span>
                          )}
                        </div>

                        <p className="mt-2 font-medium" style={{ color: "var(--pz-ink)" }}>
                          {p.frage}
                        </p>

                        <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
                          <strong>{p.stimmenGesamt}</strong>{" "}
                          {p.stimmenGesamt === 1 ? "Stimme" : "Stimmen"}, davon{" "}
                          <strong>{p.stimmenVerifiziert}</strong> verifiziert
                        </p>

                        <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
                          {created && <>Erstellt: {created}</>}
                          {opens && <> · Start: {opens}</>}
                          {closes && <> · Ende: {closes}</>}
                        </p>

                        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                          <PollAdminActions pollId={p.id} status={p.status} />

                          {p.status === "aktiv" && (
                            <Link
                              href={`/${slugFromPath}/umfrage/${p.id}`}
                              className="text-sm font-medium underline-offset-2 hover:underline"
                              style={{ color: "var(--tenant-primary)" }}
                            >
                              Öffentliche Ansicht / Ergebnis →
                            </Link>
                          )}
                          {p.status === "geschlossen" && (
                            <Link
                              href={`/${slugFromPath}/umfrage/${p.id}`}
                              className="text-sm font-medium underline-offset-2 hover:underline"
                              style={{ color: "var(--tenant-primary)" }}
                            >
                              Ergebnis ansehen →
                            </Link>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
