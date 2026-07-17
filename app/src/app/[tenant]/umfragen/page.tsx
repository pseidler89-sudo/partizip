/**
 * [tenant]/umfragen/page.tsx — Listing der lokalen Abstimmungen (ADR-014 + ADR-015).
 *
 * Nicht angemeldet: aktive Abstimmungen, NACH EBENE gekennzeichnet (Ortsteil/
 *   Kommune/Kreis/Land), je Karte Frage + Kurz-Ergebnis + „Anmelden zum
 *   Mitstimmen". Frage/Ergebnis bleiben sichtbar.
 * Angemeldet: „Für dich offen" (aktiv, im Gebiet, noch nicht abgestimmt — nach
 *   Ebene gruppiert) und „Bereits teilgenommen" (Verlauf, mit Ergebnis).
 *
 * Scope: eingeloggt = echter user.ortsteilId; anonym = Ortsteil aus dem
 * Region-Cookie (ADR-015). stadt/kreis/land sind tenant-weit.
 */

import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions, users, ortsteile } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  getAktivePolls,
  getMeineTeilnahmen,
  hatBereitsAbgestimmtBatch,
  mitErgebnissen,
  type PollMitErgebnis,
} from "@/lib/polls/queries";
import { gruppiereNachEbene } from "@/lib/polls/gruppierung";
import { RegionEinstieg } from "../RegionEinstieg";
import { isDemoTenant } from "@/lib/demo/config";
import { REGION_TYP_LABEL } from "@/lib/region/ebenen";
import type { PollErgebnis } from "@/lib/polls/ergebnis";
import { REGION_COOKIE_NAME, parseRegionCookie } from "@/lib/region/core";
import { getOrtsteileForTenant } from "@/lib/region/queries";
import { resolveOrtsteilRegionId } from "@/lib/region/scope";
import { RegionBanner } from "../RegionBanner";
import { PollTypBadge } from "../PollTypBadge";
import { KurzErgebnisDot } from "../KurzErgebnisDot";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

/** Kompakte Ergebnis-Zeile für die Listenkarten (mit Verifiziert-Anteil). */
function KurzErgebnis({ ergebnis }: { ergebnis: PollErgebnis }) {
  const ja = ergebnis.optionen.find((o) => o.choice === "ja");
  const nein = ergebnis.optionen.find((o) => o.choice === "nein");
  // k-Anonymität: maskierte Optionen kommen ohne Zahlen vom Server —
  // dann keine (falschen) Prozente zeigen, nur Gesamt + Verifiziert.
  const maskiert = ja?.maskiert || nein?.maskiert;
  return (
    <div className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
      {ergebnis.gesamt === 0 ? (
        <span>Noch keine Stimmen.</span>
      ) : ergebnis.aufschluesselungNachSchluss ? (
        // ADR-022: laufende Umfrage — Aufschlüsselung erst nach Abstimmungsende.
        <span>
          <strong>{ergebnis.gesamt}</strong>{" "}
          {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"}, davon{" "}
          {ergebnis.verifiziert} wohnsitz-verifiziert · Ausgezählt wird nach
          Abstimmungsende
        </span>
      ) : maskiert ? (
        <span>
          <strong>{ergebnis.gesamt}</strong>{" "}
          {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"}, davon{" "}
          {ergebnis.verifiziert} wohnsitz-verifiziert · Aufschlüsselung zum
          Schutz kleiner Gruppen ausgeblendet
        </span>
      ) : (
        <span>
          Ja {ja?.prozent ?? 0}% · Nein {nein?.prozent ?? 0}% ·{" "}
          <strong>{ergebnis.gesamt}</strong>{" "}
          {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"}, davon{" "}
          {ergebnis.verifiziert} wohnsitz-verifiziert
        </span>
      )}
    </div>
  );
}

function PollKarte({
  slug,
  poll,
  cta,
}: {
  slug: string;
  poll: PollMitErgebnis;
  cta: string;
}) {
  return (
    <Link
      href={`/${slug}/umfrage/${poll.id}`}
      className="pz-card pz-card-hover block p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
    >
      <PollTypBadge
        verbindlich={poll.verbindlich}
        scope={REGION_TYP_LABEL[poll.regionTyp]}
        typ={poll.typ}
      />
      <h3 className="mt-3 text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
        {poll.frage}
      </h3>
      {poll.typ === "dot_voting" ? (
        // Dot-Voting: Teilnahme-Zeile aus dem Dot-Aggregat (M1-Nachzug Block F);
        // die Punkte-Verteilung selbst lebt auf der Detailseite (Stepper-Widget).
        poll.dot ? (
          <KurzErgebnisDot ergebnis={poll.dot} mitVerifiziert />
        ) : (
          <div className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            Punkte-Voting — verteilen Sie Ihre Punkte auf die Optionen
          </div>
        )
      ) : (
        <KurzErgebnis ergebnis={poll.ergebnis} />
      )}
      <p className="mt-3 text-xs font-medium" style={{ color: "var(--pz-brand-strong)" }}>
        {cta} →
      </p>
    </Link>
  );
}

/** Liste, nach Ebene (Ortsteil/Kommune/Kreis/Land) gruppiert. */
function GruppierteListe({
  slug,
  items,
  cta,
}: {
  slug: string;
  items: PollMitErgebnis[];
  cta: string;
}) {
  const gruppen = gruppiereNachEbene(items);
  return (
    <div className="space-y-7">
      {gruppen.map((g) => (
        <div key={g.typ}>
          <h3
            className="mb-2.5 text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--pz-muted)" }}
          >
            {g.label}
          </h3>
          <ul className="space-y-4">
            {g.polls.map((p) => (
              <li key={p.id}>
                <PollKarte slug={slug} poll={p} cta={cta} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default async function UmfragenListePage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const db = createDb(databaseUrl());
  const cookieStore = await cookies();
  const region = parseRegionCookie(cookieStore.get(REGION_COOKIE_NAME)?.value);

  // Optionale Session → userId + Wohnort-Knoten (viewer_path der Standard-Sicht).
  let userId: string | null = null;
  let userOrtsteilCode: string | null = null;
  let userHomeRegionId: string | null = null;
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
        .select({ id: users.id, ortsteilId: users.ortsteilId, homeRegionId: users.homeRegionId })
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
        .limit(1);
      const user = userRows[0];
      if (user) {
        userId = user.id;
        userHomeRegionId = user.homeRegionId ?? null;
        if (user.ortsteilId) {
          const otRows = await db
            .select({ code: ortsteile.code })
            .from(ortsteile)
            .where(and(eq(ortsteile.id, user.ortsteilId), eq(ortsteile.tenantId, tenant.id)))
            .limit(1);
          userOrtsteilCode = otRows[0]?.code ?? null;
        }
      }
    }
  }

  const eingeloggt = userId != null;
  // ADR-024 (ETAPPE 2): viewer_path = Wohnort-Knoten. Eingeloggt → home_region_id
  // (Fallback: Ortsteil-Knoten aus dem Konto-Ortsteil). Anonym → Cookie-Ortsteil.
  const cookieOrtsteilCode = region?.ortsteilCode ?? null;
  const viewerRegionId = eingeloggt
    ? userHomeRegionId ??
      (userOrtsteilCode ? await resolveOrtsteilRegionId(db, tenant.id, userOrtsteilCode) : null)
    : cookieOrtsteilCode
      ? await resolveOrtsteilRegionId(db, tenant.id, cookieOrtsteilCode)
      : null;

  // Aktive Polls (vertikale Scheibe), Ergebnis je Poll (Ja/Nein-Aggregat +
  // Dot-Aggregat für dot_voting — M1-Nachzug Block F).
  const aktive = await getAktivePolls(db, tenant.id, { viewerRegionId });
  const aktiveMitErgebnis: PollMitErgebnis[] = await mitErgebnissen(db, tenant.id, aktive);

  // Region-Banner (nur wenn eine Region gemerkt ist).
  const ortsteilOptionen = region != null ? await getOrtsteileForTenant(db, tenant.id) : [];
  const banner =
    region != null ? (
      <div className="mb-6">
        <RegionBanner
          tenantName={tenant.name}
          ortsteile={ortsteilOptionen}
          currentOrtsteilCode={region.ortsteilCode}
        />
      </div>
    ) : null;

  if (!eingeloggt) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        {banner}
        <header className="mb-8">
          <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Abstimmungen
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
            Aktuelle lokale Abstimmungen — Frage und Beteiligung sehen Sie ohne
            Anmeldung; ausgezählt wird nach Abstimmungsende. Zum Mitstimmen genügt
            ein Konto (E-Mail-Link, ohne Passwort).
          </p>
        </header>

        {aktiveMitErgebnis.length === 0 ? (
          <LeerHinweis text="Gerade läuft keine Abstimmung für Ihre Region." />
        ) : (
          <GruppierteListe slug={slugFromPath} items={aktiveMitErgebnis} cta="Anmelden zum Mitstimmen" />
        )}
      </main>
    );
  }

  // Angemeldet: „Für dich offen" (nach Ebene gruppiert) + „Bereits teilgenommen".
  // Teilnahme-Status in EINER Batch-Query statt N× (CANNANAS_EVAL §Empf. 4);
  // Secret Ballot: nur das OB der Teilnahme. Die Sektionstrennung selbst trägt
  // hier den Chip-Effekt, daher kein zusätzlicher Chip pro Karte nötig.
  const abgestimmtSet = await hatBereitsAbgestimmtBatch(
    db,
    tenant,
    aktiveMitErgebnis.map((p) => p.id),
    { userId }
  );
  const offen = aktiveMitErgebnis.filter((p) => !abgestimmtSet.has(p.id));

  const teilnahmen = await getMeineTeilnahmen(db, tenant.id, userId!);

  // Erst-Login-Lücke: wer sich ohne vorherige PLZ-Eingabe registriert, hat weder
  // home_region noch Cookie und sieht nur die tenant-weite Sicht. Einmalige
  // Einladung, den Wohnort zu setzen (regionAusPlz schreibt für Eingeloggte
  // home_region_id mit — lib/region/actions.ts).
  // Nicht auf dem Demo-Tenant: Demo-Konten haben nie einen Wohnort, und der
  // Musterstadt-Zweig hat keine PLZ-Zuordnungen — die Karte wäre eine Sackgasse
  // mitten im Demo-Rundgang (Gate-B-Befund).
  const zeigeRegionEinstieg =
    viewerRegionId == null && region == null && !isDemoTenant(tenant.slug);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {banner}
      {zeigeRegionEinstieg && (
        <section className="pz-card mb-8 p-5" aria-label="Wohnort festlegen">
          <h2 className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
            Wo wohnen Sie?
          </h2>
          <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
            Mit Ihrer Postleitzahl sehen Sie zuerst die Abstimmungen aus Ihrem
            Ortsteil und Ihrer Stadt — statt allem auf einmal.
          </p>
          <div className="mt-4">
            <RegionEinstieg tenantName={tenant.name} variante="eingeloggt" />
          </div>
        </section>
      )}
      <header className="mb-8">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Abstimmungen
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Ihre offenen Abstimmungen und Ihre bisherigen Teilnahmen.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Für Sie offen
        </h2>
        {offen.length === 0 ? (
          <LeerHinweis text="Aktuell gibt es keine offene Abstimmung für Sie." />
        ) : (
          <GruppierteListe slug={slugFromPath} items={offen} cta="Jetzt mitstimmen" />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Bereits teilgenommen
        </h2>
        {teilnahmen.length === 0 ? (
          <LeerHinweis text="Sie haben noch an keiner Abstimmung teilgenommen." />
        ) : (
          <ul className="space-y-4">
            {teilnahmen.map((p) => (
              <li key={p.id}>
                <PollKarte slug={slugFromPath} poll={p} cta="Ergebnis ansehen" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function LeerHinweis({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[color:var(--pz-line)] bg-zinc-50/50 p-6 text-center">
      <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
        {text}
      </p>
    </div>
  );
}
