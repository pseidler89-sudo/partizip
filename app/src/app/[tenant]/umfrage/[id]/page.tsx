/**
 * [tenant]/umfrage/[id]/page.tsx — Öffentliche Detail-/Ergebnisseite einer Umfrage.
 *
 * Zeigt die Frage, den (un)verbindlich-Hinweis und das aktuelle Ergebnis
 * (Balken + Gesamt + "davon Y verifiziert"). Bei aktiver, offener Umfrage kann
 * direkt mitgestimmt werden (PollMitmachen). Alles tenant-scoped, ohne Konto
 * erreichbar (Default = unverbindliches Stimmungsbild).
 */

import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { polls, sessions, users } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getPollErgebnis, hatBereitsAbgestimmt } from "@/lib/polls/queries";
import { getStufe } from "@/lib/eligibility/stufe";
import { SCOPE_LABEL, type ScopeLevel } from "@/lib/polls/gruppierung";
import PollMitmachen from "../../PollMitmachen";
import { TeilenButton } from "../../TeilenButton";
import { PollTypBadge } from "../../PollTypBadge";
import { isDemoTenant } from "@/lib/demo/config";
import type { Metadata } from "next";
import { kuerzen } from "@/lib/channels/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string; id: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

/**
 * Lädt die Umfrage tenant-scoped — gemeinsame Sichtbarkeitslogik für Seite UND
 * Metadata (Muster der Digest-Seite): Entwürfe sind nicht öffentlich und dürfen
 * auch über generateMetadata nichts leaken.
 */
async function getPublicPoll(tenantSlug: string, pollId: string) {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== tenantSlug) return null;

  const db = createDb(databaseUrl());

  // Umfrage tenant-scoped laden
  const pollRows = await db
    .select({
      id: polls.id,
      frage: polls.frage,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      scopeLevel: polls.scopeLevel,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
    })
    .from(polls)
    .where(and(eq(polls.id, pollId), eq(polls.tenantId, tenant.id)))
    .limit(1);

  const poll = pollRows[0];
  // Entwürfe sind nicht öffentlich.
  if (!poll || poll.status === "entwurf") return null;

  return { tenant, db, poll };
}

/**
 * OpenGraph-Metadaten (ADR-021): Ein geteilter Umfrage-Link soll überall —
 * Mastodon, Messenger, Mail — mit Frage und neutraler Beschreibung als Karte
 * erscheinen (bisher gab es nur den generischen Titel). Dieselbe
 * Sichtbarkeitslogik wie die Seite selbst: nicht gefundene oder nicht
 * öffentliche Polls liefern nur generische Metadata.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tenant: tenantSlug, id } = await params;
  const data = await getPublicPoll(tenantSlug, id);
  // Kein eigener "— Partizip"-Zusatz: das Layout-Template (%s · Partizip)
  // haengt die Marke bereits an — sonst steht sie doppelt im Tab-Titel.
  if (!data) return { title: "Umfrage" };

  const { poll } = data;
  const frage = kuerzen(poll.frage.trim(), 70);
  const beschreibung = `Stimmungsbild auf Partizip (Ebene: ${
    SCOPE_LABEL[poll.scopeLevel as ScopeLevel]
  }). Ergebnis zeigt Gesamt- und verifizierte Stimmen.`;

  return {
    title: frage,
    description: beschreibung,
    openGraph: {
      type: "website",
      locale: "de_DE",
      siteName: "Partizip",
      title: frage,
      description: beschreibung,
    },
  };
}

export default async function UmfrageDetailPage({ params }: PageProps) {
  const { tenant: slugFromPath, id } = await params;
  const data = await getPublicPoll(slugFromPath, id);

  if (!data) notFound();

  const { tenant, db, poll } = data;

  // D4: Beleg-Liste wird nach Poll-Ende öffentlich — hart geschlossen ODER
  // Schlusszeit erreicht (deckungsgleich mit getBelegListe / der Stimm-Schlusslogik).
  const belegeVerfuegbar =
    poll.status === "geschlossen" ||
    (poll.closesAt != null && poll.closesAt <= new Date());

  const ergebnis = await getPollErgebnis(db, tenant.id, poll.id);
  if (!ergebnis) notFound();

  // Optionale Session für voter_ref / bereits-abgestimmt
  let userId: string | null = null;
  let verifiziert = false;
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    const tokenHash = sha256Hex(rawToken);
    const now = new Date();
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
      .limit(1);
    const session = sessionRows[0];
    if (session && !session.revokedAt && session.expiresAt >= now) {
      const userRows = await db
        .select({
          id: users.id,
          // Eligibility-Felder für getStufe (Stufe-2-Gate, P1) — datensparsam, keine PII.
          verificationStatus: users.verificationStatus,
          residencyVerifiedAt: users.residencyVerifiedAt,
          residencyVerifiedUntil: users.residencyVerifiedUntil,
          accountStatus: users.accountStatus,
          minAgeConfirmedAt: users.minAgeConfirmedAt,
        })
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
        .limit(1);
      const user = userRows[0];
      userId = user?.id ?? null;
      if (user) verifiziert = getStufe(user) >= 2;
    }
  }

  const now = new Date();
  const istOffen =
    poll.status === "aktiv" &&
    (!poll.opensAt || poll.opensAt <= now) &&
    (!poll.closesAt || poll.closesAt > now);

  const bereitsAbgestimmt = await hatBereitsAbgestimmt(db, tenant, poll.id, { userId });

  return (
    <main className="min-h-screen px-4 py-10 max-w-lg mx-auto">
      <Link
        href={`/${slugFromPath}`}
        className="text-sm hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
        style={{ color: "var(--pz-muted)" }}
      >
        ← Zur Startseite
      </Link>

      <div className="mt-3 mb-6">
        <PollTypBadge
          verbindlich={poll.verbindlich}
          scope={SCOPE_LABEL[poll.scopeLevel as ScopeLevel]}
        />
        <h1 className="mt-3 text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          {poll.frage}
        </h1>
      </div>

      <div className="pz-card p-6">
        {/* Bei offener Umfrage: mitstimmen möglich; sonst nur Ergebnis (über
            bereitsAbgestimmt=true erzwingen → PollMitmachen zeigt direkt Ergebnis). */}
        <PollMitmachen
          pollId={poll.id}
          verbindlich={poll.verbindlich}
          tenantSlug={slugFromPath}
          eingeloggt={userId != null}
          verifiziert={verifiziert}
          bereitsAbgestimmt={bereitsAbgestimmt || !istOffen}
          ergebnis={ergebnis}
          demoMode={isDemoTenant(tenant.slug)}
        />
      </div>

      <div className="mt-4">
        <TeilenButton title={poll.frage} path={`/${slugFromPath}/umfrage/${poll.id}`} />
      </div>

      {!istOffen && (
        <p className="mt-4 text-sm" style={{ color: "var(--pz-muted)" }}>
          Diese Abstimmung ist derzeit nicht offen — Sie sehen das bisherige Ergebnis.
        </p>
      )}

      {belegeVerfuegbar && (
        <p className="mt-2 text-sm">
          <Link
            href={`/${slugFromPath}/umfrage/${poll.id}/belege`}
            className="font-medium underline-offset-2 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
            style={{ color: "var(--pz-brand-strong)" }}
          >
            Belege prüfen — ist Ihre Stimme im Ergebnis enthalten?
          </Link>
        </p>
      )}
    </main>
  );
}
