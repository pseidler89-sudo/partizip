/**
 * [tenant]/admin/digests/[id]/page.tsx — Digest-Detailansicht + Freigabe-Gate (M7)
 *
 * Zeigt alle Aussagen mit Quellenlink und Prüf-/Highlight-Toggles.
 * Aktionen:
 *   - „Alle als geprüft markieren": alle Statements auf geprueft_at=now()
 *   - „Freigeben": entwurf → freigegeben (nur wenn x==y Aussagen geprüft)
 *   - „Veröffentlichen": freigegeben → veroeffentlicht
 *
 * Freigabe-Gate ist NICHT verhandelbar (Konzept Kap. 10).
 * Kein Pfad entwurf → veroeffentlicht.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { digests, digestStatements, roles, sessions, risDocuments } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { canRedaktion, canFreigeben } from "@/lib/auth/roles";
import Link from "next/link";
import { DigestActionButtons } from "./DigestActionButtons";
import { decodeHtmlEntities } from "@/lib/text/html-entities";

async function getDigestData(tenantSlug: string, digestId: string) {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== tenantSlug) return null;

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return { tenant, digest: null, isAdmin: false, canFreigeben: false };

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
    return { tenant, digest: null, isAdmin: false, canFreigeben: false };
  }

  const roleRows = await db
    .select({ roleType: roles.roleType })
    .from(roles)
    .where(and(eq(roles.tenantId, tenant.id), eq(roles.userId, session.userId)));
  const roleTypes = roleRows.map((r: { roleType: string }) => r.roleType);

  // H1: Redakteure dürfen die Detailansicht sehen + prüfen; Freigabe nur Admins.
  // `isAdmin` heißt hier „hat redaktionellen Zugang"; canFreigeben trennt die Freigabe-Rechte.
  if (!canRedaktion(roleTypes)) return { tenant, digest: null, isAdmin: false, canFreigeben: false };
  const canFreigebenFlag = canFreigeben(roleTypes);

  // Digest + Tenant-Isolierung
  const digestRows = await db
    .select()
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenant.id)))
    .limit(1);

  if (digestRows.length === 0) return { tenant, digest: null, isAdmin: true, canFreigeben: canFreigebenFlag };

  const digest = digestRows[0];

  // Aussagen mit Quelldokument-Info, geprueft_at und ist_highlight laden
  const stmtRows = await db
    .select({
      id: digestStatements.id,
      position: digestStatements.position,
      text: digestStatements.text,
      sourceUrl: digestStatements.sourceUrl,
      docTitle: risDocuments.title,
      docType: risDocuments.docType,
      geprueftAt: digestStatements.geprueftAt,
      istHighlight: digestStatements.istHighlight,
    })
    .from(digestStatements)
    .leftJoin(risDocuments, eq(digestStatements.sourceDocumentId, risDocuments.id))
    .where(eq(digestStatements.digestId, digestId))
    .orderBy(digestStatements.position);

  return { tenant, digest, statements: stmtRows, isAdmin: true, canFreigeben: canFreigebenFlag };
}

interface PageProps {
  params: Promise<{ tenant: string; id: string }>;
}

export default async function AdminDigestDetailPage({ params }: PageProps) {
  const { tenant: slugFromPath, id: digestId } = await params;
  const data = await getDigestData(slugFromPath, digestId);

  if (!data) notFound();
  if (!data.isAdmin) redirect(`/${slugFromPath}/anmelden`);
  if (!data.digest) notFound();

  const { digest, statements, canFreigeben: canFreigebenFlag } = data;

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

  const gesamtAnzahl = statements?.length ?? 0;
  const geprueftAnzahl = statements?.filter((s: { geprueftAt: Date | null }) => s.geprueftAt !== null).length ?? 0;
  const alleGeprueft = gesamtAnzahl > 0 && geprueftAnzahl === gesamtAnzahl;

  return (
    <main className="min-h-screen px-6 py-10 max-w-3xl mx-auto">
      <div className="mb-2">
        <Link href={`/${slugFromPath}/admin/digests`} className="text-sm text-zinc-500 hover:text-zinc-700">
          ← Alle Digests
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">{digest.title}</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Generator: {digest.generator}
            {digest.approvedAt && ` · Freigegeben: ${digest.approvedAt.toLocaleDateString("de-DE")}`}
            {digest.publishedAt && ` · Veröffentlicht: ${digest.publishedAt.toLocaleDateString("de-DE")}`}
          </p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge[digest.status] ?? "bg-zinc-100 text-zinc-800"}`}
        >
          {statusLabel[digest.status] ?? digest.status}
        </span>
      </div>

      {/* M-2b: KI-Hinweiskasten für llm_v2- und assisted_v1-Entwürfe — Quellenbezug muss vor Freigabe geprüft werden */}
      {(digest.generator === "llm_v2" || digest.generator === "assisted_v1") && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>KI-generierter Entwurf:</strong> Vor der Freigabe den Quellenbezug{" "}
          <strong>JEDER</strong> Aussage gegen das verlinkte Dokument prüfen — KI kann Aussagen
          falschen Quellen zuschreiben.
        </div>
      )}

      {/* Prüffortschritt */}
      {gesamtAnzahl > 0 && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-zinc-700">
              <span className={alleGeprueft ? "text-green-700 font-medium" : "text-zinc-700"}>
                {geprueftAnzahl} von {gesamtAnzahl} Aussagen quellen-geprüft
              </span>
              {alleGeprueft && (
                <span className="ml-2 text-green-600">✓ Alle geprüft</span>
              )}
            </p>
            {digest.status === "entwurf" && (
              <DigestActionButtons
                digestId={digest.id}
                status={digest.status}
                tenantSlug={slugFromPath}
                alleGeprueft={alleGeprueft}
                geprueftAnzahl={geprueftAnzahl}
                gesamtAnzahl={gesamtAnzahl}
                showNurAlleGeprueftButton={true}
              />
            )}
          </div>
          {/* Fortschrittsbalken */}
          <div className="mt-2 h-2 w-full rounded-full bg-zinc-200">
            <div
              className={`h-2 rounded-full transition-all ${alleGeprueft ? "bg-[var(--pz-success)]" : "bg-[var(--pz-info)]"}`}
              style={{ width: gesamtAnzahl > 0 ? `${Math.round((geprueftAnzahl / gesamtAnzahl) * 100)}%` : "0%" }}
            />
          </div>
        </div>
      )}

      {/* Freigabe-Gate Aktionen */}
      <DigestActionButtons
        digestId={digest.id}
        status={digest.status}
        tenantSlug={slugFromPath}
        alleGeprueft={alleGeprueft}
        geprueftAnzahl={geprueftAnzahl}
        gesamtAnzahl={gesamtAnzahl}
        showNurAlleGeprueftButton={false}
        canFreigeben={canFreigebenFlag}
      />

      {/* Aussagen */}
      <section className="mt-8">
        <h2 className="text-lg font-medium text-zinc-900 mb-4">
          Aussagen ({statements?.length ?? 0})
        </h2>

        {!statements || statements.length === 0 ? (
          <p className="text-zinc-500 text-sm">Keine Aussagen vorhanden.</p>
        ) : (
          <ol className="space-y-4">
            {statements.map((stmt: typeof statements[number]) => (
              <li
                key={stmt.id}
                className={`rounded-lg border p-4 ${stmt.geprueftAt ? "border-green-200 bg-green-50/30" : "border-zinc-200"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-zinc-900 text-sm leading-relaxed flex-1">{stmt.text}</p>
                  {/* Toggle-Buttons: nur im Entwurf aktiv */}
                  {digest.status === "entwurf" ? (
                    <DigestActionButtons
                      digestId={digest.id}
                      status={digest.status}
                      tenantSlug={slugFromPath}
                      alleGeprueft={alleGeprueft}
                      geprueftAnzahl={geprueftAnzahl}
                      gesamtAnzahl={gesamtAnzahl}
                      showNurAlleGeprueftButton={false}
                      statementId={stmt.id}
                      statementGeprueft={stmt.geprueftAt !== null}
                      statementGeprueftAt={stmt.geprueftAt?.toISOString() ?? null}
                      statementHighlight={stmt.istHighlight}
                    />
                  ) : (
                    /* Read-only Anzeige bei Status != 'entwurf' */
                    <div className="flex items-center gap-2 shrink-0">
                      {stmt.geprueftAt && (
                        <span className="inline-flex items-center gap-1 rounded-full pz-badge-success px-2 py-0.5 text-xs">
                          ✓ Geprüft
                        </span>
                      )}
                      {stmt.istHighlight && (
                        <span className="inline-flex items-center gap-1 rounded-full pz-badge-warning px-2 py-0.5 text-xs">
                          ★ Highlight
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                  <span>{stmt.docType ?? "Dokument"}{stmt.docTitle ? `: ${decodeHtmlEntities(stmt.docTitle)}` : ""}</span>
                  <span>·</span>
                  <a
                    href={stmt.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-zinc-700"
                  >
                    Quelldokument öffnen
                  </a>
                  {stmt.geprueftAt && (
                    <>
                      <span>·</span>
                      <span className="text-green-600">
                        geprüft {new Date(stmt.geprueftAt).toLocaleDateString("de-DE")}
                      </span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {digest.status === "veroeffentlicht" && (
        <div className="mt-6">
          <Link
            href={`/${slugFromPath}/digest/${digest.id}`}
            className="text-sm text-[color:var(--pz-brand-strong)] hover:opacity-80 underline"
          >
            → Öffentliche Ansicht
          </Link>
        </div>
      )}
    </main>
  );
}
