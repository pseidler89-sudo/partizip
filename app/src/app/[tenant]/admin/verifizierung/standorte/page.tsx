/**
 * [tenant]/admin/verifizierung/standorte/page.tsx — Standort- & Sprechzeiten-
 * Verwaltung (Block K1).
 *
 * NUR Admins (kommune_admin/super_admin) — reine Verifier haben hier keinen
 * Zugriff (Guard-Muster admin/rollen/page.tsx); die Server Actions erzwingen
 * requireAdminCtx zusätzlich (Defense in Depth). Tenant-Isolation in jeder Query.
 *
 * Zeigt: alle Standorte (auch deaktivierte) mit Kennzahlen + je Standort die
 * kommenden Sprechzeiten; Formulare zum Anlegen/Bearbeiten/Deaktivieren und
 * zum Einstellen von Sprechzeiten (Einzeltermin oder Wochenserie).
 * Auf dem Demo-Mandanten: Hinweis-Karte statt Formularen (Side-Effect-Fence —
 * die Actions lehnen dort ohnehin ab; die UI erklärt es freundlich).
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
  getSlotsFuerStandortAdmin,
  getStandorteFuerAdmin,
} from "@/lib/verification/standort-queries";
import { formatSlotLabel } from "@/lib/verification/slot-format";
import { StandorteVerwaltung } from "./StandorteVerwaltung";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function AdminStandortePage({ params }: PageProps) {
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
  // verlieren sofort den Zugriff) — konsistent mit den Server Actions.
  // NICHT nur canVerify: Standort-Verwaltung ist Admins vorbehalten.
  const roleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  if (!isAdmin(roleTypes)) redirect(`/${slugFromPath}/anmelden`);

  const demo = isDemoTenant(tenant.slug);

  const standorte = await getStandorteFuerAdmin(db, tenant.id);
  // Kommende Slots je Standort mitschicken (kleine N — ein Tenant hat wenige
  // Standorte; die Slot-Liste selbst ist auf 300 je Standort gedeckelt).
  const slotsJeStandort = await Promise.all(
    standorte.map((s) => getSlotsFuerStandortAdmin(db, tenant.id, s.locationId)),
  );

  const standorteVM = standorte.map((s, i) => ({
    ...s,
    slots: slotsJeStandort[i].slots.map((slot) => ({
      slotId: slot.slotId,
      label: formatSlotLabel(slot.startsAt, slot.endsAt),
      capacity: slot.capacity,
      bookedCount: slot.bookedCount,
    })),
    // Gate-B: Gesamtzahl mitgeben — die UI weist eine gekappte Liste aus,
    // statt weitere (buchbare) Slots still zu verschweigen.
    slotsGesamt: slotsJeStandort[i].gesamt,
  }));

  return (
    <main className="min-h-screen px-6 py-10 max-w-3xl mx-auto">
      <div className="mb-8">
        <Link
          href={`/${slugFromPath}/admin/verifizierung`}
          className="text-sm hover:underline"
          style={{ color: "var(--pz-muted)" }}
        >
          ← Wohnsitz-Verifizierung
        </Link>
        <h1 className="mt-2 text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Standorte &amp; Sprechzeiten
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--pz-muted)" }}>
          Hier legen Sie fest, wo und wann sich Bürger:innen vor Ort verifizieren
          können. Bürger:innen buchen einen freien Termin und zeigen dort ihren
          Ausweis. {tenant.name}
        </p>
      </div>

      {demo ? (
        <div
          className="rounded-lg border p-4 text-sm"
          style={{ borderColor: "var(--pz-line)", color: "var(--pz-muted)" }}
        >
          <strong style={{ color: "var(--pz-ink)" }}>Demo-Spielwiese:</strong>{" "}
          Die Standort-Verwaltung ist hier deaktiviert — in der Demo werden
          keine Standorte oder Sprechzeiten verändert. In einer echten
          Kommune legen Sie hier Bürgerbüros und deren Sprechzeiten an.
        </div>
      ) : (
        <StandorteVerwaltung standorte={standorteVM} />
      )}
    </main>
  );
}
