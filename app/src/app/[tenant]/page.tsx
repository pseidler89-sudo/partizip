/**
 * [tenant]/page.tsx — Bürger-Startseite. Front-Door = PLZ-/Standort-Einstieg
 * (ADR-015) + Mitmach-Schleife (M3).
 *
 * Ablauf:
 *   1. Noch keine Region gemerkt → „Haustür": PLZ eingeben / Standort freigeben.
 *   2. Region gemerkt → Region-Banner + (a) die neueste aktive Frage als Hero
 *      mit Abstimm-Buttons (Mitmach-Schleife) und (b) ALLE aktiven Abstimmungen
 *      für mich, NACH EBENE gekennzeichnet (Ortsteil/Kommune/Kreis/Land).
 *
 * Scope-Sicht: eingeloggt = echter user.ortsteilId; anonym = Ortsteil aus dem
 * Region-Cookie (reine Personalisierung). stadt/kreis/land sind tenant-weit.
 *
 * Server-Komponente: Tenant + optionale Session serverseitig; Queries tenant-scoped.
 */

import { headers, cookies } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions, users, ortsteile } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { resolveOrtsteilRegionId } from "@/lib/region/scope";
import {
  getAktivePolls,
  hatBereitsAbgestimmt,
  hatBereitsAbgestimmtBatch,
  hatBereitsDotAbgestimmt,
  hatBereitsWiderstandAbgestimmt,
  mitErgebnissen,
  type PollMitErgebnis,
} from "@/lib/polls/queries";
import { gruppiereNachEbene } from "@/lib/polls/gruppierung";
import { REGION_TYP_LABEL, type RegionTyp } from "@/lib/region/ebenen";
import type { PollErgebnis } from "@/lib/polls/ergebnis";
import { REGION_COOKIE_NAME, parseRegionCookie } from "@/lib/region/core";
import { getOrtsteileForTenant } from "@/lib/region/queries";
import PollMitmachen from "./PollMitmachen";
import { KurzErgebnisTeilnahme } from "./KurzErgebnisTeilnahme";
import NaechsterSchritt from "./NaechsterSchritt";
import PollStatusChip from "./PollStatusChip";
import { PollTypBadge } from "./PollTypBadge";
import { getStufe } from "@/lib/eligibility/stufe";
import {
  getEinrichtungsStatus,
  naechsterSchritt,
  type EinrichtungsSchritt,
} from "@/lib/konto/einrichtung";
import { EINRICHTUNG_SPAETER_COOKIE } from "@/lib/konto/constants";
import { TeilenButton } from "./TeilenButton";
import { LoginForm } from "./LoginForm";
import { RegionBanner } from "./RegionBanner";
import { Landing } from "./Landing";
import { isDemoTenant } from "@/lib/demo/config";
import { regionDisplayName } from "@/lib/brand";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

// Prosa-Variante für den Hero-Satz (NICHT die kanonischen Kurz-Labels aus
// REGION_TYP_LABEL). Exhaustiv über die Gebietsart (regions.typ) → kein
// hängender Fallback (ADR-024 contract).
const SCOPE_PHRASE: Record<RegionTyp, string> = {
  ortsteil: "in Ihrem Ortsteil",
  gemeinde: "in Ihrer Kommune",
  kreis: "in Ihrem Kreis",
  land: "in Ihrem Land",
  bund: "bundesweit",
};

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

/** Kompakte Ergebnis-Zeile für die Übersichts-Karten. */
function KurzErgebnis({ ergebnis }: { ergebnis: PollErgebnis }) {
  const ja = ergebnis.optionen.find((o) => o.choice === "ja");
  const nein = ergebnis.optionen.find((o) => o.choice === "nein");
  // k-Anonymität: maskierte Optionen kommen ohne Zahlen vom Server —
  // dann keine (falschen) Prozente zeigen, nur die Gesamtzahl.
  const maskiert = ja?.maskiert || nein?.maskiert;
  return (
    <div className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
      {ergebnis.gesamt === 0 ? (
        <span>Noch keine Stimmen.</span>
      ) : ergebnis.aufschluesselungNachSchluss ? (
        // ADR-022: laufende Umfrage — Aufschlüsselung erst nach Abstimmungsende.
        <span>
          <strong>{ergebnis.gesamt}</strong>{" "}
          {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"} · Ausgezählt wird nach
          Abstimmungsende
        </span>
      ) : maskiert ? (
        <span>
          <strong>{ergebnis.gesamt}</strong> {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"} ·
          Aufschlüsselung zum Schutz kleiner Gruppen ausgeblendet
        </span>
      ) : (
        <span>
          Ja {ja?.prozent ?? 0}% · Nein {nein?.prozent ?? 0}% ·{" "}
          <strong>{ergebnis.gesamt}</strong> {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"}
        </span>
      )}
    </div>
  );
}

function PollKarte({
  slug,
  poll,
  abgestimmt,
}: {
  slug: string;
  poll: PollMitErgebnis;
  /** Teilnahme-Chip (nur eingeloggt → definiert): true=abgestimmt, false=offen. */
  abgestimmt?: boolean;
}) {
  return (
    <Link
      href={`/${slug}/umfrage/${poll.id}`}
      className="pz-card pz-card-hover block p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <PollTypBadge
          verbindlich={poll.verbindlich}
          scope={REGION_TYP_LABEL[poll.regionTyp]}
          typ={poll.typ}
        />
        {abgestimmt !== undefined && <PollStatusChip abgestimmt={abgestimmt} />}
      </div>
      <h4 className="mt-2 text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
        {poll.frage}
      </h4>
      {/* Options-Formate haben kein Ja/Nein-Aggregat — Teilnahme-Zeile aus dem
          Format-Ergebnis (M1-Nachzug Block F) statt fälschlich „Noch keine Stimmen". */}
      {poll.typ === "dot_voting" ? (
        poll.dot ? (
          <KurzErgebnisTeilnahme ergebnis={poll.dot} />
        ) : (
          <div className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            Punkte-Voting — verteilen Sie Ihre Punkte auf die Optionen
          </div>
        )
      ) : poll.typ === "widerstandsabfrage" ? (
        poll.widerstand ? (
          <KurzErgebnisTeilnahme ergebnis={poll.widerstand} />
        ) : (
          <div className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            Widerstandsabfrage — bewerten Sie jede Option von 0 bis 10
          </div>
        )
      ) : (
        <KurzErgebnis ergebnis={poll.ergebnis} />
      )}
    </Link>
  );
}

export default async function TenantLandingPage({ params }: PageProps) {
  const { tenant: slug } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  // Defense-in-Depth (konsistent mit allen anderen [tenant]-Seiten): existiert ein
  // Tenant, MUSS sein Slug dem Pfad-Slug entsprechen. Auf der Haupt-Domain stellt
  // die Middleware pathSlug === Pilot-Slug sicher; greift dieser Schutz nie,
  // härtet er dennoch gegen künftige Routing-Änderungen.
  if (tenant && tenant.slug !== slug) notFound();

  // Region-Anzeigename ohne interne Suffixe („Taunusstein (Staging)" → „Taunusstein").
  const name = regionDisplayName(tenant?.name ?? "Partizip");
  const intro =
    tenant?.welcomeText ??
    "Verständliche Ratsinfos und mitbekommen, was in Ihrer Kommune entschieden wird — überparteilich und transparent.";

  const db = createDb(databaseUrl());

  // Region-Cookie lesen (Haustür-Gate).
  const cookieStore = await cookies();
  const region = parseRegionCookie(cookieStore.get(REGION_COOKIE_NAME)?.value);

  // Optionale Session → userId + Ortsteil (für Scope-Filter bei Eingeloggten).
  let userId: string | null = null;
  let userOrtsteilCode: string | null = null;
  let userHomeRegionId: string | null = null;
  let verifiziert = false;
  // Ein-Schritt-Nudge (Einrichtungs-Checkliste Fläche B): der eine nächste
  // offene Schritt — null = nichts zeigen (alles erledigt / „Später" / Demo).
  let einrichtungsSchritt: EinrichtungsSchritt | null = null;
  if (tenant) {
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
            ortsteilId: users.ortsteilId,
            // ADR-024 (ETAPPE 2): weich ermittelter Wohnort-Knoten (viewer_path der
            // Standard-Sicht). Fällt auf ortsteilId zurück, falls noch nicht gesetzt.
            homeRegionId: users.homeRegionId,
            // Felder für getStufe (Stufe-2-Gate, P1 Stufen-Fortschritt) — datensparsam,
            // nur die Eligibility-Felder, keine PII wie E-Mail.
            verificationStatus: users.verificationStatus,
            residencyVerifiedAt: users.residencyVerifiedAt,
            residencyVerifiedUntil: users.residencyVerifiedUntil,
            accountStatus: users.accountStatus,
            minAgeConfirmedAt: users.minAgeConfirmedAt,
            // Einrichtungs-Checkliste (Fläche B): Benachrichtigungs-Opt-in.
            notifyNewPolls: users.notifyNewPolls,
          })
          .from(users)
          .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
          .limit(1);
        const user = userRows[0];
        if (user) {
          userId = user.id;
          verifiziert = getStufe(user) >= 2;
          userHomeRegionId = user.homeRegionId ?? null;
          if (user.ortsteilId) {
            const otRows = await db
              .select({ code: ortsteile.code })
              .from(ortsteile)
              .where(and(eq(ortsteile.id, user.ortsteilId), eq(ortsteile.tenantId, tenant.id)))
              .limit(1);
            userOrtsteilCode = otRows[0]?.code ?? null;
          }
          // Einrichtungs-Nudge nur berechnen, wenn er überhaupt gezeigt würde:
          // nicht nach „Später" (Cookie) und nicht auf dem Demo-Mandanten
          // (Demo-Konten erfüllen die Schritte nie — RegionEinstieg-Gate-B-Lehre).
          const spaeter =
            cookieStore.get(EINRICHTUNG_SPAETER_COOKIE)?.value === "1";
          if (!spaeter && !isDemoTenant(tenant.slug)) {
            einrichtungsSchritt = naechsterSchritt(
              await getEinrichtungsStatus(db, tenant, user, user.id)
            );
          }
        }
      }
    }
  }
  const eingeloggt = userId != null;

  // Kein Tenant (Fremd-Host ohne Pilot-Mapping) → neutrale Minimal-Seite.
  if (!tenant) {
    return (
      <main className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight" style={{ color: "var(--pz-ink)" }}>
          Partizip
        </h1>
        <p className="mt-3 text-base" style={{ color: "var(--pz-muted)" }}>
          Plattform für kommunale Beteiligung.
        </p>
      </main>
    );
  }

  // ----- Haustür: anonym + noch keine Region gemerkt -----------------------
  // Eingeloggte überspringen die Haustür — Tenant kommt aus dem Host, der
  // Ortsteil aus dem Konto (user.ortsteilId). Nur anonyme Erstbesucher wählen
  // hier ihre Region. Demo-Mandant: Haustür überspringen — Besucher der
  // Akquise-Spielwiese landen ohne Formular-Hindernis direkt in der Sicht
  // (Ortsteil-Filter bleibt aus → alle Beispiel-Fragen sichtbar).
  const demo = isDemoTenant(tenant.slug);
  if (region == null && !eingeloggt && !demo) {
    return <Landing tenantName={name} slug={slug} />;
  }

  // ----- Region gemerkt ODER eingeloggt: Mitmach-Schleife + nach Ebene -------
  // ADR-024 (ETAPPE 2): viewer_path der Standard-Sicht = Wohnort-Knoten.
  //   Eingeloggt → home_region_id (Fallback: Ortsteil-Knoten aus dem Konto-Ortsteil,
  //     falls home_region_id noch nicht gesetzt ist — bewahrt die alte Sicht).
  //   Anonym    → Ortsteil-Knoten aus dem Region-Cookie; ohne Ortsteil null →
  //     obere Ebenen tenant-weit (wie bisher).
  const cookieOrtsteilCode = region?.ortsteilCode ?? null;
  const viewerRegionId = eingeloggt
    ? userHomeRegionId ??
      (userOrtsteilCode ? await resolveOrtsteilRegionId(db, tenant.id, userOrtsteilCode) : null)
    : cookieOrtsteilCode
      ? await resolveOrtsteilRegionId(db, tenant.id, cookieOrtsteilCode)
      : null;

  // Alle aktiven Polls für mich (vertikale Scheibe, neu→alt), mit Ergebnis
  // (Ja/Nein-Aggregat + Dot-Aggregat für dot_voting — M1-Nachzug Block F).
  const aktive = await getAktivePolls(db, tenant.id, { viewerRegionId });
  const alleMitErgebnis: PollMitErgebnis[] = await mitErgebnissen(db, tenant.id, aktive);
  // Featured = neueste SICHTBARE Abstimmung (scope-konsistent — kein separater
  // ungescopter Query; Gate-B ADR-015). Verhindert, dass eine Ortsteil-Frage als
  // Hero erscheint, die in der gruppierten Sicht ausgeblendet wäre.
  const featured = alleMitErgebnis[0] ?? null;
  const featuredErgebnis = featured?.ergebnis ?? null;
  // Teilnahme-Signal fürs Hero: Options-Format-Polls zählen Teilnehmende
  // (distinct Wähler), Ja/Nein-Polls Stimmen — alle laut ADR-022/-025 immer sichtbar.
  const featuredTeilnahmen =
    featured?.typ === "dot_voting"
      ? featured.dot?.gesamtWaehler ?? 0
      : featured?.typ === "widerstandsabfrage"
        ? featured.widerstand?.gesamtWaehler ?? 0
        : featuredErgebnis?.gesamt ?? 0;
  // Teilnahme-Prüfung typ-abhängig: Dot-/Widerstands-Teilnahmen liegen NUR in
  // vote_allocations bzw. vote_resistances — die votes-Query wäre dort
  // systematisch falsch-negativ (Gate-B MINOR). Alle Queries liefern nur das
  // OB (Secret Ballot).
  const bereitsAbgestimmt = featured
    ? featured.typ === "dot_voting"
      ? await hatBereitsDotAbgestimmt(db, tenant, featured.id, { userId })
      : featured.typ === "widerstandsabfrage"
        ? await hatBereitsWiderstandAbgestimmt(db, tenant, featured.id, { userId })
        : await hatBereitsAbgestimmt(db, tenant, featured.id, { userId })
    : false;

  // Nach Ebene gruppiert, ohne die Featured-Frage doppelt zu zeigen.
  const aktiveMitErgebnis = alleMitErgebnis.filter((p) => p.id !== featured?.id);
  const gruppen = gruppiereNachEbene(aktiveMitErgebnis);

  // P1: Teilnahme-Status für die gruppierten Karten in EINER Batch-Query statt N×
  // (CANNANAS_EVAL §Empf. 4). Secret Ballot: liefert nur das OB der Teilnahme.
  // Nur für eingeloggte Nutzer (Stufe ≥ 1) relevant — sonst leeres Set.
  const abgestimmtSet = eingeloggt
    ? await hatBereitsAbgestimmtBatch(
        db,
        tenant,
        aktiveMitErgebnis.map((p) => p.id),
        { userId }
      )
    : new Set<string>();

  // Ortsteile für den Banner-Dropdown.
  const ortsteilOptionen = await getOrtsteileForTenant(db, tenant.id);

  return (
    <main>
      {/* Region-Banner (nur wenn eine Region gemerkt ist; Eingeloggte ohne
          Cookie nutzen ihren Konto-Ortsteil und brauchen ihn nicht). */}
      {region != null && (
        <div className="mx-auto max-w-3xl px-6 pt-6">
          <RegionBanner
            tenantName={name}
            ortsteile={ortsteilOptionen}
            currentOrtsteilCode={region.ortsteilCode}
          />
        </div>
      )}

      {/* Ein-Schritt-Nudge (Einrichtungs-Checkliste Fläche B): ersetzt den
          reinen Stufen-Streifen — zeigt den EINEN nächsten Einrichtungs-Schritt
          (Wohnort → Verifizierung → Benachrichtigung → Teilnahme) und
          verschwindet vollständig, wenn alles erledigt ist. */}
      {eingeloggt && einrichtungsSchritt && (
        <div className="mx-auto max-w-3xl px-6 pt-6">
          <NaechsterSchritt schritt={einrichtungsSchritt} tenantSlug={slug} />
        </div>
      )}

      {/* Hero: neueste aktive Frage (Mitmach-Schleife) */}
      <section className="pz-hero">
        <div className="mx-auto max-w-3xl px-6 pb-14 pt-8">
          {featured && featuredErgebnis ? (
            <div className="text-center">
              <PollTypBadge
                verbindlich={featured.verbindlich}
                scope={SCOPE_PHRASE[featured.regionTyp]}
                typ={featured.typ}
              />
              <h1
                className="mx-auto mt-4 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl"
                style={{ color: "var(--pz-ink)" }}
              >
                {featured.frage}
              </h1>
              <p className="mx-auto mt-3 max-w-xl text-sm" style={{ color: "var(--pz-muted)" }}>
                {featuredTeilnahmen > 0
                  ? `Bereits ${featuredTeilnahmen} ${featuredTeilnahmen === 1 ? "Person hat" : "Menschen haben"} mitgemacht.`
                  : "Machen Sie den Anfang — Ihre Stimme zählt."}
              </p>

              <div className="mx-auto mt-7 max-w-lg pz-card p-6 text-left">
                {featured.typ !== "ja_nein_enthaltung" ? (
                  // Options-Formate: das Abstimm-Widget lebt auf der Detailseite
                  // (barrierearme Stepper/Slider) — im Hero nur der Einstieg.
                  // Bereits Teilgenommene sehen das ehrlich (kein zweiter
                  // Mitmach-Aufruf, Gate-B MINOR).
                  <div className="text-center">
                    <p className="text-sm" style={{ color: "var(--pz-body)" }}>
                      {bereitsAbgestimmt
                        ? featured.typ === "dot_voting"
                          ? "Sie haben Ihre Punkte bereits verteilt — danke fürs Mitmachen!"
                          : "Sie haben bereits bewertet — danke fürs Mitmachen!"
                        : featured.typ === "dot_voting"
                          ? "Punkte-Voting: Verteilen Sie Ihre Punkte auf die Optionen."
                          : "Widerstandsabfrage: Bewerten Sie jede Option von 0 bis 10 — die Option mit dem geringsten Gesamtwiderstand gewinnt."}
                    </p>
                    <Link
                      href={`/${slug}/umfrage/${featured.id}`}
                      className="mt-4 inline-block rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
                      style={{ backgroundColor: "var(--tenant-primary)" }}
                    >
                      {bereitsAbgestimmt ? "Zum Ergebnis" : "Zur Abstimmung"}
                    </Link>
                  </div>
                ) : (
                  <PollMitmachen
                    pollId={featured.id}
                    verbindlich={featured.verbindlich}
                    tenantSlug={slug}
                    eingeloggt={eingeloggt}
                    verifiziert={verifiziert}
                    bereitsAbgestimmt={bereitsAbgestimmt}
                    ergebnis={featuredErgebnis}
                    demoMode={demo}
                  />
                )}
                <div className="mt-4 border-t border-[color:var(--pz-line)] pt-3">
                  <TeilenButton title={featured.frage} path={`/${slug}/umfrage/${featured.id}`} />
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <h1
                className="text-3xl font-semibold tracking-tight sm:text-4xl"
                style={{ color: "var(--pz-ink)" }}
              >
                {name}
              </h1>
              <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed" style={{ color: "var(--pz-body)" }}>
                Gerade läuft keine Abstimmung. {intro}
              </p>
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-6 py-14">
        {/* Nach Ebene gekennzeichnete Abstimmungen */}
        <section>
          <div className="mb-5 flex items-baseline justify-between">
            <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
              Abstimmungen für Sie
            </h2>
            <Link
              href={`/${slug}/umfragen`}
              className="text-sm font-medium underline-offset-4 hover:underline"
              style={{ color: "var(--pz-brand-strong)" }}
            >
              Alle ansehen →
            </Link>
          </div>

          {gruppen.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[color:var(--pz-line)] bg-zinc-50/50 p-6 text-center">
              <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
                {featured
                  ? "Aktuell läuft nur die Abstimmung oben."
                  : "Gerade läuft keine Abstimmung für Ihre Region."}
              </p>
            </div>
          ) : (
            <div className="space-y-7">
              {gruppen.map((g) => (
                <div key={g.typ}>
                  <h3
                    className="mb-2.5 text-xs font-semibold uppercase tracking-wide"
                    style={{ color: "var(--pz-muted)" }}
                  >
                    {g.label}
                  </h3>
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {g.polls.map((p) => (
                      <li key={p.id}>
                        <PollKarte
                          slug={slug}
                          poll={p}
                          abgestimmt={eingeloggt ? abgestimmtSet.has(p.id) : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Anmelden (sekundär) — nur für Nicht-Eingeloggte. */}
        {!eingeloggt && (
          <section id="anmelden" className="mt-14">
            <div className="pz-card p-8">
              <div className="mb-6 text-center">
                <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
                  Anmelden &amp; auf dem Laufenden bleiben
                </h2>
                <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
                  Per E-Mail-Link, ohne Passwort. Mit Konto können Sie bei Abstimmungen mitstimmen.
                </p>
              </div>
              <LoginForm tenantSlug={slug} />
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
