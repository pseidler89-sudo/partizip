/**
 * [tenant]/admin/verifizierung/page.tsx — QR-Verifizierung verwalten (ADR-014 Block 2).
 *
 * NUR canVerify (verifier/kommune_admin/super_admin), sonst redirect. Gleicher
 * Session-Guard wie admin/rollen/page.tsx; die Berechtigung wird zusätzlich in
 * den Server Actions hart erzwungen (Defense in Depth, kein Selbst-Hochstufen).
 *
 * Zeigt: Formular zum Erstellen eines QR-Codes (Scope, Label, maxRedemptions,
 * Gültigkeit) → der QR wird als Bild + Link GENAU EINMAL nach Erstellung
 * angezeigt (Token nie erneut abrufbar). Darunter die Liste bestehender QR-Codes
 * mit Status + Widerrufen-Button. KEIN tokenHash wird je ausgegeben.
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
import {
  canVerify,
  erlaubteScopeEbenenFuerVerifier,
  getUserRolesMitScope,
  getUserRoleTypes,
  isAdmin,
} from "@/lib/auth/roles";
import { SCOPE_INPUT_LEVELS } from "@/lib/region/ebenen";
import { qrCodesListe } from "@/lib/verification/queries";
import { getOffeneTermineFuerVerifier } from "@/lib/verification/booking-queries";
import { formatSlotLabel } from "@/lib/verification/slot-format";
import { QrVerwaltung } from "./QrVerwaltung";
import TermineVerwaltung from "./TermineVerwaltung";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function AdminVerifizierungPage({ params }: PageProps) {
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

  // getUserRoleTypes filtert auf account_status='active' (gesperrte Verifier
  // verlieren sofort den Zugriff) — konsistent mit den Server Actions.
  const roleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  if (!canVerify(roleTypes)) redirect(`/${slugFromPath}/anmelden`);

  // Gebietsbindung (Block K1), UI-Komfort: Nicht-Admin-Verifier sehen im
  // Ebenen-Dropdown nur die Ebenen ihres eigenen Knotens und darunter
  // (Gemeinde-Rolle ⇒ „stadt"+„ortsteil"; Ortsteil-Rolle ⇒ nur „ortsteil").
  // Admins sehen alle Ebenen wie bisher. Die eigentliche Durchsetzung liegt
  // serverseitig in qrErstellenCore (ltree-Pfad-Abdeckung, fail-closed).
  const callerIstAdmin = isAdmin(roleTypes);
  const erlaubteEbenen = callerIstAdmin
    ? [...SCOPE_INPUT_LEVELS]
    : erlaubteScopeEbenenFuerVerifier(
        await getUserRolesMitScope(db, tenant.id, session.userId),
      );

  const liste = await qrCodesListe(db, tenant.id);
  const termineRaw = await getOffeneTermineFuerVerifier(db, tenant.id);
  const termine = termineRaw.map((t) => ({
    bookingId: t.bookingId,
    code: t.code,
    label: formatSlotLabel(t.startsAt, t.endsAt),
    locationName: t.locationName,
  }));

  return (
    <main className="min-h-screen px-6 py-10 max-w-3xl mx-auto">
      <div className="mb-8">
        <Link
          href={`/${slugFromPath}/admin`}
          className="text-sm hover:underline"
          style={{ color: "var(--pz-muted)" }}
        >
          ← Admin-Bereich
        </Link>
        <h1 className="mt-2 text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Wohnsitz-Verifizierung
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--pz-muted)" }}>
          Zwei Wege zur Stufe 2: gebuchte Termine vor Ort bestätigen oder einen
          QR-Code erzeugen (Schnellweg). Beide setzen die Person auf
          wohnsitz-verifiziert.
        </p>
      </div>

      {/* Standort-/Sprechzeiten-Verwaltung (Block K1): NUR für Admins sichtbar —
          reine Verifier bestätigen Termine, verwalten aber keine Standorte
          (die Unterseite + Actions erzwingen isAdmin zusätzlich serverseitig). */}
      {callerIstAdmin && (
        <section className="mb-10">
          <Link
            href={`/${slugFromPath}/admin/verifizierung/standorte`}
            className="pz-card block p-5 transition-shadow hover:shadow-md"
          >
            <h2 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
              Standorte &amp; Sprechzeiten verwalten →
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
              Verifizierungs-Standorte anlegen, Sprechzeiten (einzeln oder als
              Wochenserie) einstellen — die Termine, die Bürger:innen buchen können.
            </p>
          </Link>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          Gebuchte Termine
        </h2>
        <p className="mb-3 text-sm" style={{ color: "var(--pz-muted)" }}>
          Der Bürger nennt vor Ort seinen Termin-Code. Prüfen Sie den
          Personalausweis und bestätigen Sie dann mit „Wahrnehmen“ — das
          verifiziert die Person (Stufe 2). Die Liste enthält bewusst keine Namen.
        </p>
        <TermineVerwaltung termine={termine} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          QR-Code (Schnellweg)
        </h2>
        <QrVerwaltung liste={serializeListe(liste)} erlaubteEbenen={erlaubteEbenen} />
      </section>
    </main>
  );
}

/** Date→ISO für die Client-Komponente (Server→Client-Serialisierung). */
function serializeListe(
  liste: Awaited<ReturnType<typeof qrCodesListe>>,
) {
  return liste.map((q) => ({
    id: q.id,
    label: q.label,
    regionTyp: q.regionTyp,
    regionName: q.regionName,
    redemptionCount: q.redemptionCount,
    maxRedemptions: q.maxRedemptions,
    expiresAt: q.expiresAt.toISOString(),
    revokedAt: q.revokedAt ? q.revokedAt.toISOString() : null,
    createdAt: q.createdAt.toISOString(),
  }));
}
