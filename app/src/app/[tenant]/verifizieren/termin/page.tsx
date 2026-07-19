/**
 * [tenant]/verifizieren/termin/page.tsx — Termin buchen (D6 Verify-Hub Schritt 2/3).
 *
 * Server-Komponente: löst Stufe + offenen Termin auf, lädt frei buchbare Slots
 * (server-seitig formatiert) und übergibt sie an den Client-Flow TerminBuchen.
 * Stufe-1-Pflicht: ohne Konto → Anmelde-CTA. Wer schon einen offenen Termin hat →
 * zurück zur Übersicht (dort steht der Status). QR bleibt unabhängiger Fallback.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions, users } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getStufe } from "@/lib/eligibility/stufe";
import {
  getStandorteMitFreienSlots,
  getMeinOffenerTermin,
} from "@/lib/verification/booking-queries";
import { formatSlotLabel } from "@/lib/verification/slot-format";
import TerminBuchen from "./TerminBuchen";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

function Schale({ children, slug }: { children: React.ReactNode; slug: string }) {
  return (
    <main className="mx-auto min-h-screen max-w-lg px-4 py-10">
      <Link
        href={`/${slug}/verifizieren`}
        className="rounded-sm text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
        style={{ color: "var(--pz-muted)" }}
      >
        ← Zur Verifizierungs-Übersicht
      </Link>
      <div className="mt-3">{children}</div>
    </main>
  );
}

export default async function TerminPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const db = createDb(databaseUrl());

  // Session OPTIONAL → Stufe bestimmen.
  let userId: string | null = null;
  let stufe = 0;
  const cookieStore = await cookies();
  const rawSession = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawSession) {
    const now = new Date();
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256Hex(rawSession)), eq(sessions.tenantId, tenant.id)))
      .limit(1);
    const session = sessionRows[0];
    if (session && !session.revokedAt && session.expiresAt >= now) {
      const userRows = await db
        .select()
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
        .limit(1);
      if (userRows[0]) {
        userId = userRows[0].id;
        stufe = getStufe(userRows[0]);
      }
    }
  }

  // Nicht eingeloggt → Anmelde-CTA (Code-/QR-frei).
  if (stufe < 1 || !userId) {
    return (
      <Schale slug={slugFromPath}>
        <div className="pz-card p-6 text-center">
          <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Zum Buchen bitte anmelden
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
            Für einen Termin ist eine kurze Anmeldung per E-Mail-Link nötig — so
            hängt die Verifizierung an einer bestätigten Person.
          </p>
          <Link
            href={`/${slugFromPath}/anmelden`}
            className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--tenant-primary)" }}
          >
            Jetzt anmelden
          </Link>
        </div>
      </Schale>
    );
  }

  // Schon ein offener Termin → zurück zur Übersicht (dort steht der Status).
  const offen = await getMeinOffenerTermin(db, tenant.id, userId);
  if (offen) redirect(`/${slugFromPath}/verifizieren`);

  const standorteRaw = await getStandorteMitFreienSlots(db, tenant.id);
  const standorte = standorteRaw.map((s) => ({
    locationId: s.locationId,
    name: s.name,
    address: s.address,
    hinweise: s.hinweise,
    slots: s.slots.map((sl) => ({
      slotId: sl.slotId,
      label: formatSlotLabel(sl.startsAt, sl.endsAt),
      frei: sl.frei,
    })),
  }));

  const hatFreie = standorte.some((s) => s.slots.length > 0);

  return (
    <Schale slug={slugFromPath}>
      <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Termin buchen
      </h1>
      <p className="mb-5 mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
        Wählen Sie einen Standort und einen freien Termin. Vor Ort weisen Sie sich
        kurz mit dem Personalausweis aus — fertig.
      </p>

      {standorte.length === 0 || !hatFreie ? (
        <div className="pz-card p-6">
          <p className="text-sm" style={{ color: "var(--pz-body)" }}>
            Derzeit sind keine freien Termine verfügbar. Bitte versuchen Sie es
            später erneut — oder besuchen Sie eine Verifizierungsstelle in Ihrer
            Nähe während der Öffnungszeiten; viele Stellen verifizieren Sie auch
            ohne Termin.
          </p>
        </div>
      ) : (
        <TerminBuchen standorte={standorte} tenantSlug={slugFromPath} />
      )}
    </Schale>
  );
}
