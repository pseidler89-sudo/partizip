/**
 * [tenant]/admin/anliegen/[id]/page.tsx — Admin-Detail-Seite (M8)
 *
 * Zeigt: Anliegen-Details, Status-Wechsel-Form, Events, Match-Vorschläge
 * Nur für kommune_admin und super_admin.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, asc, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import {
  anliegen,
  anliegenEvents,
  anliegenFollowers,
  anliegenMatches,
  ortsteile,
  risDocuments,
  sessions,
} from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin, getUserRoleTypes } from "@/lib/auth/roles";
import AdminAnliegenDetail from "./AdminAnliegenDetail";

interface PageProps {
  params: Promise<{ tenant: string; id: string }>;
}

export default async function AdminAnliegenDetailPage({ params }: PageProps) {
  const { tenant: slugFromPath, id: anliegenId } = await params;

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
  // gesperrtes/gelöschtes Konto erhält [] und kann die Anliegen-Detailseite nicht
  // laden.
  const roleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  if (!isAdmin(roleTypes)) redirect(`/${slugFromPath}/anmelden`);

  // Anliegen laden (tenant-scoped)
  const anliegenRows = await db
    .select({
      id: anliegen.id,
      trackingCode: anliegen.trackingCode,
      titel: anliegen.titel,
      beschreibung: anliegen.beschreibung,
      status: anliegen.status,
      ortsteilId: anliegen.ortsteilId,
      createdAt: anliegen.createdAt,
      updatedAt: anliegen.updatedAt,
      verborgenAt: anliegen.verborgenAt,
      verborgenGrund: anliegen.verborgenGrund,
    })
    .from(anliegen)
    .where(and(eq(anliegen.id, anliegenId), eq(anliegen.tenantId, tenant.id)))
    .limit(1);

  if (anliegenRows.length === 0) notFound();
  const a = anliegenRows[0];

  // Ortsteil
  let ortsteilName: string | null = null;
  if (a.ortsteilId) {
    const ortsteilRows = await db
      .select({ name: ortsteile.name })
      .from(ortsteile)
      // Audit m6: Tenant-Filter als zweite Verteidigungslinie (Invariante
      // „tenant_id in JEDER Query"; die öffentliche Schwesterseite tut das bereits).
      .where(and(eq(ortsteile.id, a.ortsteilId), eq(ortsteile.tenantId, tenant.id)))
      .limit(1);
    ortsteilName = ortsteilRows[0]?.name ?? null;
  }

  // Events
  const events = await db
    .select()
    .from(anliegenEvents)
    .where(eq(anliegenEvents.anliegenId, anliegenId))
    .orderBy(asc(anliegenEvents.createdAt));

  // Follower-Anzahl (keine E-Mails anzeigen)
  const followerCount = await db
    .select({ userId: anliegenFollowers.userId })
    .from(anliegenFollowers)
    .where(eq(anliegenFollowers.anliegenId, anliegenId));

  // Match-Vorschläge
  type MatchRow = {
    id: string;
    risDocumentId: string;
    confidence: string | null;
    status: string;
    decidedAt: Date | null;
    docTitle: string | null;
    docSourceUrl: string;
  };
  const matchesRaw: MatchRow[] = await db
    .select({
      id: anliegenMatches.id,
      risDocumentId: anliegenMatches.risDocumentId,
      confidence: anliegenMatches.confidence,
      status: anliegenMatches.status,
      decidedAt: anliegenMatches.decidedAt,
      docTitle: risDocuments.title,
      docSourceUrl: risDocuments.sourceUrl,
    })
    .from(anliegenMatches)
    .innerJoin(risDocuments, eq(anliegenMatches.risDocumentId, risDocuments.id))
    .where(eq(anliegenMatches.anliegenId, anliegenId))
    .orderBy(anliegenMatches.confidence);

  // Sortierung: confidence absteigend
  const matches = matchesRaw
    .map((m: MatchRow) => ({
      ...m,
      confidence: Number(m.confidence),
      docTitle: m.docTitle ?? null,
      decidedAt: m.decidedAt ?? null,
    }))
    .sort((ma, mb) => mb.confidence - ma.confidence);

  return (
    <AdminAnliegenDetail
      tenantSlug={slugFromPath}
      anliegenId={anliegenId}
      anliegen={{
        ...a,
        beschreibung: a.beschreibung ?? null,
        ortsteilId: a.ortsteilId ?? null,
        ortsteilName,
        verborgenAt: a.verborgenAt ?? null,
        verborgenGrund: a.verborgenGrund ?? null,
      }}
      events={events}
      followerCount={followerCount.length}
      matches={matches}
    />
  );
}
