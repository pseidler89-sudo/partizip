/**
 * [tenant]/admin/verifizierung/aktivitaet/page.tsx — Team-Aktivität &
 * Verifier-Anomalie-Kennzahlen (Block K4, rein lesend).
 *
 * NUR Admins (kommune_admin/super_admin) — reine Verifier haben hier keinen
 * Zugriff (Guard-Muster admin/verifizierung/standorte/page.tsx): Session →
 * Tenant → getUserRoleTypes (account_status-gefiltert) → isAdmin, sonst
 * redirect anmelden. Tenant-Isolation in jeder Query. KEINE Mutationen.
 *
 * Auf dem Demo-Mandanten: Hinweis-Karte statt Inhalt (Muster K1) — die Demo
 * trägt keine echten Verifizierungs-Daten und die Fläche wäre leer/irreführend.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin, getUserRoleTypes } from "@/lib/auth/roles";
import { isDemoTenant } from "@/lib/demo/config";
import {
  getEinloesungenJeVerifier,
  getQrAusschoepfung,
  getTermineJeStandort,
  getAuffaelligkeiten,
} from "@/lib/verification/aktivitaet-queries";
import { AktivitaetsSicht } from "./AktivitaetsSicht";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function AdminAktivitaetPage({ params }: PageProps) {
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
  if (!session || session.revokedAt || session.expiresAt < now) redirect(`/${slugFromPath}/anmelden`);

  // getUserRoleTypes filtert auf account_status='active' (gesperrte Admins
  // verlieren sofort den Zugriff). NICHT nur canVerify: die Aktivitäts-/
  // Anomalie-Sicht ist Admins vorbehalten.
  const roleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  if (!isAdmin(roleTypes)) redirect(`/${slugFromPath}/anmelden`);

  const demo = isDemoTenant(tenant.slug);

  const kopf = (
    <div className="mb-8">
      <Link
        href={`/${slugFromPath}/admin/verifizierung`}
        className="text-sm hover:underline"
        style={{ color: "var(--pz-muted)" }}
      >
        ← Wohnsitz-Verifizierung
      </Link>
      <h1 className="mt-2 text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Aktivität &amp; Auffälligkeiten
      </h1>
      <p className="text-sm mt-1" style={{ color: "var(--pz-muted)" }}>
        Diese Sicht macht möglichen Missbrauch der Verifizierung sichtbar, statt
        auf Scheinprüfung zu vertrauen. Sie zeigt ausschließlich Aggregate
        (QR-Codes, Einlösungen, Termine) — niemals das Stimmverhalten und nie,
        wer was gewählt hat. Die geheime Wahl bleibt unangetastet. {tenant.name}
      </p>
    </div>
  );

  if (demo) {
    return (
      <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
        {kopf}
        <div
          className="rounded-lg border p-4 text-sm"
          style={{ borderColor: "var(--pz-line)", color: "var(--pz-muted)" }}
        >
          <strong style={{ color: "var(--pz-ink)" }}>Demo-Spielwiese:</strong>{" "}
          Diese Auswertung ist hier deaktiviert — die Demo trägt keine echten
          Verifizierungs-Daten. In einer echten Kommune sehen Sie hier die
          Aktivität Ihrer Verifizierer:innen und mögliche Auffälligkeiten.
        </div>
      </main>
    );
  }

  // Jede Aggregat-Query läuft GENAU EINMAL (Gate-B MINOR): die Auffälligkeits-
  // Ableitung erhält die bereits geladenen Listen als Parameter und führt nur
  // ihre eigene Tages-Spitzen-Query zusätzlich aus.
  const [verifier, ausschoepfung, standorte] = await Promise.all([
    getEinloesungenJeVerifier(db, tenant.id),
    getQrAusschoepfung(db, tenant.id),
    getTermineJeStandort(db, tenant.id),
  ]);
  const auffaelligkeiten = await getAuffaelligkeiten(db, tenant.id, {
    verifier,
    ausschoepfung,
  });

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      {kopf}
      <AktivitaetsSicht
        verifier={verifier.map((v) => ({
          email: v.email,
          hatVerifierRolle: v.hatVerifierRolle,
          qrGesamt: v.qrGesamt,
          qrAktiv: v.qrAktiv,
          einloesungen7d: v.einloesungen7d,
          einloesungen30d: v.einloesungen30d,
          einloesungenGesamt: v.einloesungenGesamt,
          letzteEinloesung: v.letzteEinloesung ? v.letzteEinloesung.toISOString() : null,
        }))}
        ausschoepfung={ausschoepfung}
        standorte={standorte}
        auffaelligkeiten={auffaelligkeiten}
      />
    </main>
  );
}
