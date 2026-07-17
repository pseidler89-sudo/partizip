/**
 * [tenant]/umfrage/[id]/page.tsx — Öffentliche Detail-/Ergebnisseite einer Umfrage.
 *
 * Zeigt die Frage, den (un)verbindlich-Hinweis und das Ergebnis: bei BEENDETER
 * Umfrage die volle Aufschlüsselung (Balken + Gesamt + "davon Y verifiziert",
 * k-Suppression), bei LAUFENDER Umfrage nur Gesamt + Verifiziert mit dem
 * "Ausgezählt wird nach Abstimmungsende"-Hinweis (ADR-022, serverseitig via
 * getPollErgebnis). Bei aktiver, offener Umfrage kann direkt mitgestimmt werden
 * (PollMitmachen). Alles tenant-scoped, ohne Konto erreichbar (Default =
 * unverbindliches Stimmungsbild).
 */

import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { polls, sessions, users, regions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  getPollErgebnis,
  hatBereitsAbgestimmt,
  getDotOptions,
  getDotErgebnis,
  hatBereitsDotAbgestimmt,
  getWiderstandsErgebnis,
  hatBereitsWiderstandAbgestimmt,
} from "@/lib/polls/queries";
import { istBeendet } from "@/lib/polls/ergebnis";
import { getStufe } from "@/lib/eligibility/stufe";
import { istGebietsZustaendig, waehleAnkerRegionId } from "@/lib/polls/gebiet";
import { regionTypLabel } from "@/lib/region/ebenen";
import PollMitmachen from "../../PollMitmachen";
import DotMitmachen from "../../DotMitmachen";
import WiderstandMitmachen from "../../WiderstandMitmachen";
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
      regionId: polls.regionId,
      regionTyp: regions.typ,
      punkteBudget: polls.punkteBudget,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
    })
    .from(polls)
    .innerJoin(regions, eq(regions.id, polls.regionId))
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
    regionTypLabel(poll.regionTyp)
  }). Ergebnis nach Abstimmungsende, mit Gesamt- und verifizierten Stimmen.`;

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

  // Gemeinsame Beendet-Semantik (ADR-022): Beleg-Liste UND Ergebnis-
  // Aufschlüsselung werden nach Poll-Ende öffentlich — deckungsgleich mit
  // getBelegListe / getPollErgebnis / der Stimm-Schlusslogik.
  const beendet = istBeendet(poll);
  const belegeVerfuegbar = beendet;

  const istDot = poll.typ === "dot_voting";
  const istWiderstand = poll.typ === "widerstandsabfrage";
  // Ja/Nein-Ergebnis nur für das binäre Format laden; die Options-Formate haben
  // eigene Aggregate (getDotErgebnis/getWiderstandsErgebnis) + eigene Optionen
  // (getDotOptions ist format-neutral).
  const ergebnis = istDot || istWiderstand ? null : await getPollErgebnis(db, tenant.id, poll.id);
  if (!istDot && !istWiderstand && !ergebnis) notFound();
  const dotOptionen =
    istDot || istWiderstand ? await getDotOptions(db, tenant.id, poll.id) : [];
  const dotErgebnis = istDot ? await getDotErgebnis(db, tenant.id, poll.id) : null;
  if (istDot && !dotErgebnis) notFound();
  const widerstandsErgebnis = istWiderstand
    ? await getWiderstandsErgebnis(db, tenant.id, poll.id)
    : null;
  if (istWiderstand && !widerstandsErgebnis) notFound();

  // Optionale Session für voter_ref / bereits-abgestimmt
  let userId: string | null = null;
  let verifiziert = false;
  // Gebiets-Zuständigkeit (Audit M2): true, solange kein eingeloggter Nutzer als
  // nicht-zuständig erkannt wird (Anonyme sehen ohnehin nur Ergebnis/Login-CTA).
  let gebietsZustaendig = true;
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
          // Gebiets-Anker (Audit M2) — dieselbe Prüfung wie die Abstimm-Action.
          residencyRegionId: users.residencyRegionId,
          homeRegionId: users.homeRegionId,
        })
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
        .limit(1);
      const user = userRows[0];
      userId = user?.id ?? null;
      if (user) {
        verifiziert = getStufe(user) >= 2;
        const ankerRegionId = waehleAnkerRegionId(user, poll.verbindlich);
        gebietsZustaendig = await istGebietsZustaendig(
          db,
          tenant.id,
          poll.regionId,
          ankerRegionId,
        );
      }
    }
  }

  const now = new Date();
  const istOffen =
    poll.status === "aktiv" &&
    (!poll.opensAt || poll.opensAt <= now) &&
    (!poll.closesAt || poll.closesAt > now);

  const bereitsAbgestimmt = istDot
    ? await hatBereitsDotAbgestimmt(db, tenant, poll.id, { userId })
    : istWiderstand
      ? await hatBereitsWiderstandAbgestimmt(db, tenant, poll.id, { userId })
      : await hatBereitsAbgestimmt(db, tenant, poll.id, { userId });

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
          scope={regionTypLabel(poll.regionTyp)}
          typ={poll.typ}
        />
        <h1 className="mt-3 text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          {poll.frage}
        </h1>
      </div>

      <div className="pz-card p-6">
        {/* Bei offener Umfrage: mitstimmen möglich; sonst nur Ergebnis (über
            bereitsAbgestimmt=true erzwingen → zeigt direkt das Ergebnis). */}
        {istDot ? (
          <DotMitmachen
            pollId={poll.id}
            budget={poll.punkteBudget ?? 0}
            optionen={dotOptionen.map((o) => ({ id: o.id, label: o.label }))}
            ergebnis={dotErgebnis!}
            tenantSlug={slugFromPath}
            eingeloggt={userId != null}
            verifiziert={verifiziert}
            verbindlich={poll.verbindlich}
            bereitsAbgestimmt={bereitsAbgestimmt || !istOffen || !gebietsZustaendig}
            demoMode={isDemoTenant(tenant.slug)}
          />
        ) : istWiderstand ? (
          <WiderstandMitmachen
            pollId={poll.id}
            optionen={dotOptionen.map((o) => ({ id: o.id, label: o.label }))}
            ergebnis={widerstandsErgebnis!}
            tenantSlug={slugFromPath}
            eingeloggt={userId != null}
            verifiziert={verifiziert}
            verbindlich={poll.verbindlich}
            bereitsAbgestimmt={bereitsAbgestimmt || !istOffen || !gebietsZustaendig}
            demoMode={isDemoTenant(tenant.slug)}
          />
        ) : (
          <PollMitmachen
            pollId={poll.id}
            verbindlich={poll.verbindlich}
            tenantSlug={slugFromPath}
            eingeloggt={userId != null}
            verifiziert={verifiziert}
            // Nicht-zuständige eingeloggte Nutzer sehen nur das Ergebnis (die
            // Abstimm-Action würde ohnehin ablehnen — Audit M2).
            bereitsAbgestimmt={bereitsAbgestimmt || !istOffen || !gebietsZustaendig}
            ergebnis={ergebnis!}
            demoMode={isDemoTenant(tenant.slug)}
          />
        )}
        {userId != null && !gebietsZustaendig && istOffen && (
          <p className="mt-3 text-sm" style={{ color: "var(--pz-muted)" }}>
            Diese Abstimmung gehört nicht zu Ihrem Gebiet — Sie sehen das Ergebnis,
            können aber nicht mitstimmen.
          </p>
        )}
      </div>

      <div className="mt-4">
        <TeilenButton title={poll.frage} path={`/${slugFromPath}/umfrage/${poll.id}`} />
      </div>

      {!istOffen && (
        <p className="mt-4 text-sm" style={{ color: "var(--pz-muted)" }}>
          {beendet
            ? "Diese Abstimmung ist beendet — Sie sehen das ausgezählte Endergebnis."
            : "Diese Abstimmung ist noch nicht geöffnet — schauen Sie bald wieder vorbei."}
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
