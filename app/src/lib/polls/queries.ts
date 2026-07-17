/**
 * queries.ts — Lese-Queries der Mitmach-Schleife (Server-Component-Nutzung).
 *
 * BEWUSST OHNE "use server": Diese Funktionen sind reine, tenant-scoped
 * Lesezugriffe und werden nur aus Server-Komponenten aufgerufen. Lägen sie in
 * der "use server"-Action-Datei, würde Next.js sie als client-aufrufbare
 * RPC-Endpunkte mit client-kontrolliertem tenantId exponieren (Gate-B MAJOR-G).
 *
 * ADR-022 (Aufschlüsselung erst nach Abstimmungsende): Alle Ergebnis-Aggregate
 * hier (getPollErgebnis, getMeineTeilnahmen) liefern für LAUFENDE Umfragen die
 * Optionen OHNE Zahlen (ohneAufschluesselung) — serverseitig hart, nie nur UI.
 * Beendet-Semantik: istBeendet (deckungsgleich mit der Beleg-Listen-Freigabe).
 */

import { and, eq, or, isNull, lte, gt, desc, inArray, count, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { polls, votes, pollOptions, voteAllocations, regions, pollStatusEnum } from "@/db/schema";
import {
  aggregateDotVotes,
  type DotOption,
  type DotVotingErgebnis,
} from "@/lib/polls/dot";
import type { RegionTyp } from "@/lib/region/ebenen";
import type { TenantRow } from "@/lib/tenant";
import { computeVoterRefForUser } from "@/lib/polls/voter-ref";
import {
  aggregateVotes,
  istBeendet,
  ohneAufschluesselung,
  type PollErgebnis,
} from "@/lib/polls/ergebnis";

/**
 * Aggregiertes Ergebnis einer Umfrage (tenant-scoped). Liefert null, wenn die
 * Umfrage nicht zum Tenant gehört.
 *
 * ADR-022: Läuft die Umfrage noch (nicht istBeendet), enthält das Ergebnis
 * KEINE per-Option-Zahlen (alle null, aufschluesselungNachSchluss=true) — nur
 * gesamt/verifiziert auf Poll-Ebene. Erst nach Abstimmungsende kommt die volle
 * Aufschlüsselung (ein finaler Stand), weiterhin mit k-Suppression.
 */
export async function getPollErgebnis(
  db: Db,
  tenantId: string,
  pollId: string
): Promise<PollErgebnis | null> {
  const pollRows = await db
    .select({ id: polls.id, status: polls.status, closesAt: polls.closesAt })
    .from(polls)
    .where(and(eq(polls.id, pollId), eq(polls.tenantId, tenantId)))
    .limit(1);
  const poll = pollRows[0];
  if (!poll) return null;

  const rows = await db
    .select({ choice: votes.choice, warVerifiziert: votes.warVerifiziert })
    .from(votes)
    .where(and(eq(votes.pollId, pollId), eq(votes.tenantId, tenantId)));

  const ergebnis = aggregateVotes(rows);
  return istBeendet(poll) ? ergebnis : ohneAufschluesselung(ergebnis);
}

/**
 * Optionen einer dot_voting-Umfrage (tenant-scoped, nach Position sortiert).
 */
export async function getDotOptions(
  db: Db,
  tenantId: string,
  pollId: string,
): Promise<DotOption[]> {
  const rows = await db
    .select({ id: pollOptions.id, label: pollOptions.label, position: pollOptions.position })
    .from(pollOptions)
    .where(and(eq(pollOptions.pollId, pollId), eq(pollOptions.tenantId, tenantId)))
    .orderBy(pollOptions.position);
  return rows;
}

/**
 * Dot-Voting-Ergebnis (tenant-scoped). Hält die per-Option-Aufschlüsselung
 * zurück, solange die Umfrage läuft ODER < k Teilnehmende (ADR-025, siehe
 * lib/polls/dot.ts). Teilnehmerzahl bleibt sichtbar.
 */
export async function getDotErgebnis(
  db: Db,
  tenantId: string,
  pollId: string,
): Promise<DotVotingErgebnis | null> {
  const pollRows = await db
    .select({
      id: polls.id,
      status: polls.status,
      closesAt: polls.closesAt,
      punkteBudget: polls.punkteBudget,
    })
    .from(polls)
    .where(and(eq(polls.id, pollId), eq(polls.tenantId, tenantId)))
    .limit(1);
  const poll = pollRows[0];
  if (!poll) return null;

  const optionen = await getDotOptions(db, tenantId, pollId);
  const rows = await db
    .select({
      optionId: voteAllocations.optionId,
      punkte: voteAllocations.punkte,
      voterRef: voteAllocations.voterRef,
      warVerifiziert: voteAllocations.warVerifiziert,
    })
    .from(voteAllocations)
    .where(and(eq(voteAllocations.pollId, pollId), eq(voteAllocations.tenantId, tenantId)));

  return aggregateDotVotes(rows, optionen, poll.punkteBudget ?? 0, istBeendet(poll));
}

/**
 * Hat der eingeloggte User bei einer dot_voting-Umfrage bereits abgestimmt?
 * (irgendeine Zuteilung für die Umfrage). Tenant-scoped, ohne userId → false.
 */
export async function hatBereitsDotAbgestimmt(
  db: Db,
  tenant: TenantRow,
  pollId: string,
  ctx: { userId: string | null },
): Promise<boolean> {
  if (!ctx.userId) return false;
  let voterRef: string;
  try {
    voterRef = computeVoterRefForUser(ctx.userId);
  } catch {
    return false;
  }
  const rows = await db
    .select({ id: voteAllocations.id })
    .from(voteAllocations)
    .where(
      and(
        eq(voteAllocations.pollId, pollId),
        eq(voteAllocations.tenantId, tenant.id),
        eq(voteAllocations.voterRef, voterRef),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Prüft, ob der eingeloggte User für eine Umfrage bereits abgestimmt hat
 * (ADR-014: nur noch user-basiert, kein anonymer Device-Pfad). Tenant-scoped.
 * Ohne userId (nicht eingeloggt) → false, da Mitstimmen ohne Konto entfällt.
 */
export async function hatBereitsAbgestimmt(
  db: Db,
  tenant: TenantRow,
  pollId: string,
  ctx: { userId: string | null }
): Promise<boolean> {
  if (!ctx.userId) return false;

  let voterRef: string;
  try {
    voterRef = computeVoterRefForUser(ctx.userId);
  } catch {
    return false;
  }

  const rows = await db
    .select({ id: votes.id })
    .from(votes)
    .where(
      and(
        eq(votes.pollId, pollId),
        eq(votes.tenantId, tenant.id),
        eq(votes.voterRef, voterRef)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Batch-Variante von hatBereitsAbgestimmt (P1, CANNANAS_EVAL §Empf. 4): liefert
 * für eine Liste von Poll-IDs die Teilmenge, für die der eingeloggte User bereits
 * abgestimmt hat — als Set, in EINER Query statt N (kein N+1 im Listing).
 *
 * SECRET BALLOT: selektiert NUR die poll_id (das OB der Teilnahme), NIE `choice`
 * oder Punkte-Zuteilungen (das WIE). Damit verrät der „Sie haben abgestimmt"-Chip
 * nie die getroffene Wahl.
 * Tenant-scoped + voter_ref-gebunden; ohne userId (nicht eingeloggt) leeres Set.
 *
 * Deckt BEIDE Abstimm-Formate ab: Ja/Nein liegt in `votes`, Dot-Voting NUR in
 * `vote_allocations` (dotAbstimmen schreibt keine votes-Zeile) — ohne den
 * zweiten Blick bliebe der Teilnahme-Chip bei Dot-Polls fälschlich „Noch offen".
 */
export async function hatBereitsAbgestimmtBatch(
  db: Db,
  tenant: TenantRow,
  pollIds: string[],
  ctx: { userId: string | null }
): Promise<Set<string>> {
  if (!ctx.userId || pollIds.length === 0) return new Set();

  let voterRef: string;
  try {
    voterRef = computeVoterRefForUser(ctx.userId);
  } catch {
    return new Set();
  }

  const [voteRows, allocRows] = await Promise.all([
    db
      .select({ pollId: votes.pollId })
      .from(votes)
      .where(
        and(
          eq(votes.tenantId, tenant.id),
          eq(votes.voterRef, voterRef),
          inArray(votes.pollId, pollIds)
        )
      ),
    db
      .select({ pollId: voteAllocations.pollId })
      .from(voteAllocations)
      .where(
        and(
          eq(voteAllocations.tenantId, tenant.id),
          eq(voteAllocations.voterRef, voterRef),
          inArray(voteAllocations.pollId, pollIds)
        )
      ),
  ]);
  return new Set(
    [...voteRows, ...allocRows].map((r: { pollId: string }) => r.pollId)
  );
}

// ---------------------------------------------------------------------------
// Listing der Umfragen (ADR-014)
// ---------------------------------------------------------------------------

export interface PollListItem {
  id: string;
  frage: string;
  typ: "ja_nein_enthaltung" | "dot_voting";
  status: (typeof pollStatusEnum.enumValues)[number];
  verbindlich: boolean;
  // ADR-024 contract: Gebietsknoten der Umfrage + abgeleitete Anzeigefelder.
  // Die geografische Ebene ergibt sich aus regionTyp (regions.typ); scope_* sind weg.
  regionId: string;
  regionTyp: RegionTyp;
  regionName: string;
  /** ltree-Pfad des Knotens (für Sicht-/Beobachter-Prüfungen). */
  regionPath: string;
  opensAt: Date | null;
  closesAt: Date | null;
  createdAt: Date;
}

export interface PollMitErgebnis extends PollListItem {
  ergebnis: PollErgebnis;
  /**
   * Nur bei typ=dot_voting gesetzt: aggregiertes Dot-Ergebnis für die
   * Karten-Teilnahmezeile. Kommt aus getDotErgebnis und ist damit serverseitig
   * k-maskiert (ADR-025); gesamtWaehler/verifizierteWaehler sind immer sichtbar.
   */
  dot?: DotVotingErgebnis | null;
}

/** Neutrales Leer-Ergebnis (Fallback, wenn getPollErgebnis null liefert). */
const LEERES_ERGEBNIS: PollErgebnis = {
  gesamt: 0,
  verifiziert: 0,
  optionen: [],
  aufschluesselungNachSchluss: false,
};

/**
 * Reichert Listen-Items um ihr Ergebnis an (Startseite/Listing): Ja/Nein-Polls
 * bekommen das votes-Aggregat, dot_voting-Polls ZUSÄTZLICH das Dot-Aggregat —
 * sonst zeigt die Karte „Noch keine Stimmen", obwohl Punkte verteilt wurden
 * (M1-Nachzug Block F). Tenant-scoped über die aufgerufenen Einzel-Queries.
 */
export async function mitErgebnissen(
  db: Db,
  tenantId: string,
  items: PollListItem[]
): Promise<PollMitErgebnis[]> {
  return Promise.all(
    items.map(async (p) => ({
      ...p,
      ergebnis: (await getPollErgebnis(db, tenantId, p.id)) ?? LEERES_ERGEBNIS,
      dot: p.typ === "dot_voting" ? await getDotErgebnis(db, tenantId, p.id) : undefined,
    }))
  );
}

/**
 * Aktive, im Zeitfenster offene Umfragen des Tenants, neu→alt — Standard-Sicht als
 * VERTIKALE SCHEIBE über den Gebietsbaum (ADR-024, GEBIETSMODELL §5; ETAPPE 2).
 *
 * Sichtbar sind Umfragen auf Knoten, die auf dem Pfad des Wohnort-Knotens liegen:
 *   - Vorfahren inkl. Selbst (`r.path @> viewer_path`): Gemeinde, Kreis, Land, BUND
 *     — die obere Scheibe. Bund fällt automatisch mit rein (Wurzel jedes Pfads),
 *     ohne Sonderfall pro Ebene → Bund-Ebene ist damit AKTIV.
 *   - eigene Ortsteile (`r.path <@ viewer_path`): die Nachfahren des Wohnknotens —
 *     ABER NUR, wenn der Wohnknoten selbst ein Ortsteil (Blatt) ist. Dann ist der
 *     einzige Nachfahr er selbst → das ersetzt exakt das alte
 *     `scope_code == userOrtsteilCode`, strukturell statt per String-Match.
 * Geschwister (Nachbarorte) sind weder Vorfahr noch Nachfahr → NIE sichtbar.
 *
 * WICHTIG (Gate-B MAJOR): Der `<@`-Zweig (Nachfahren) gilt AUSSCHLIESSLICH für einen
 * Ortsteil-Wohnknoten. Zeigt `viewerRegionId` auf den GEMEINDE-Knoten (eingeloggter
 * Nutzer OHNE gewählten Ortsteil, home_region_id = Gemeinde), würde `<@` sonst ALLE
 * Ortsteil-Polls der Gemeinde einschließen (auch fremde Nachbarorte) und die
 * „keine Nachbarorte"-Invariante verletzen. Ein Gemeinde-(oder höherer) Wohnknoten
 * bekommt daher NUR die Vorfahren-Scheibe (`@>`) — identisch zum nicht-verorteten
 * Fallback.
 *
 * viewer_path:
 *   - `viewerRegionId` gesetzt (users.home_region_id bzw. Cookie-Ortsteil-Knoten):
 *     dessen Pfad. Bei Ortsteil-Wohnort = alte Semantik + Bund; bei Gemeinde-Wohnort
 *     = obere Scheibe OHNE Ortsteile.
 *   - `viewerRegionId` null (nicht verortet / kein home_region_id): Fallback auf den
 *     Gemeinde-Knoten des Tenants, NUR Vorfahren (`@>`, OHNE Ortsteil-Kinder) —
 *     entspricht dem heutigen Default „stadt/kreis/land tenant-weit" (+ Bund).
 *
 * Tenant-Isolation UNVERÄNDERT über `polls.tenant_id` (der Baum ist tenant-frei und
 * steuert nur die Sicht). Zeitvergleiche über Drizzle-Operatoren (kein Roh-SQL-Date).
 */
export async function getAktivePolls(
  db: Db,
  tenantId: string,
  opts?: { viewerRegionId?: string | null }
): Promise<PollListItem[]> {
  const now = new Date();
  const viewerRegionId = opts?.viewerRegionId ?? null;

  // viewer_path als Skalar-Subquery (ltree). Ohne home_region_id → Gemeinde-Knoten
  // des Tenants als Fallback-Anker.
  const viewerPath = viewerRegionId
    ? sql`(SELECT path FROM regions WHERE id = ${viewerRegionId}::uuid)`
    : sql`(SELECT g.path FROM regions g WHERE g.typ = 'gemeinde' AND g.tenant_id = ${tenantId}::uuid ORDER BY g.created_at LIMIT 1)`;

  // Vorfahren-Scheibe (`@>`): immer (Gemeinde/Kreis/Land/Bund + Selbst). Die
  // Nachfahren-Scheibe (`<@`, eigene Ortsteile) kommt NUR hinzu, wenn der
  // Wohnknoten selbst ein Ortsteil (Blatt) ist — sonst würde ein Gemeinde-
  // Wohnknoten alle Ortsteil-Polls inkl. Nachbarorte sehen (Gate-B MAJOR).
  const scheibe = viewerRegionId
    ? sql`(
        ${regions.path} @> ${viewerPath}
        OR (
          EXISTS (
            SELECT 1 FROM regions v
            WHERE v.id = ${viewerRegionId}::uuid AND v.typ = 'ortsteil'
          )
          AND ${regions.path} <@ ${viewerPath}
        )
      )`
    : sql`(${regions.path} @> ${viewerPath})`;

  return db
    .select({
      id: polls.id,
      frage: polls.frage,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      regionId: polls.regionId,
      regionTyp: regions.typ,
      regionName: regions.name,
      regionPath: sql<string>`${regions.path}::text`,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
      createdAt: polls.createdAt,
    })
    .from(polls)
    .innerJoin(regions, eq(regions.id, polls.regionId))
    .where(
      and(
        eq(polls.tenantId, tenantId),
        eq(polls.status, "aktiv"),
        or(isNull(polls.opensAt), lte(polls.opensAt, now)),
        or(isNull(polls.closesAt), gt(polls.closesAt, now)),
        // viewer_path kann NULL sein (Tenant ohne Gemeinde-Knoten) → dann matcht
        // weder @> noch <@ (ltree-Vergleich mit NULL = NULL) → leere, sichere Sicht.
        scheibe
      )
    )
    .orderBy(desc(polls.createdAt));
}

/**
 * Umfragen, für die der eingeloggte User (voter_ref user-Domain) eine Stimme
 * abgegeben hat — neu→alt, jeweils mit Ergebnis-Aggregat. Tenant-scoped.
 *
 * Deckt BEIDE Abstimm-Formate ab: Ja/Nein-Stimmen liegen in `votes`,
 * Dot-Voting-Teilnahmen NUR in `vote_allocations` — ohne den zweiten Blick
 * fehlten Dot-Polls dauerhaft in „Bereits teilgenommen". Dot-Polls tragen ihr
 * Dot-Aggregat im `dot`-Feld (k-maskiert via getDotErgebnis, ADR-025).
 *
 * Einschluss bewusst unabhängig vom Status/Zeitfenster: bereits beendete oder
 * geschlossene Umfragen sollen in "Bereits teilgenommen" sichtbar bleiben.
 *
 * ADR-022: Ergebnisse laufender Umfragen kommen OHNE per-Option-Zahlen
 * (ohneAufschluesselung) — gleiche Beendet-Semantik wie getPollErgebnis.
 */
export async function getMeineTeilnahmen(
  db: Db,
  tenantId: string,
  userId: string
): Promise<PollMitErgebnis[]> {
  let voterRef: string;
  try {
    voterRef = computeVoterRefForUser(userId);
  } catch {
    return [];
  }

  // poll_ids mit einer Teilnahme dieses voter_ref (tenant-scoped): Ja/Nein-
  // Stimmen aus votes + Dot-Zuteilungen aus vote_allocations. Beide Queries
  // selektieren NUR poll_id (Secret Ballot: das OB, nie das WIE).
  const [voteRows, allocRows] = await Promise.all([
    db
      .select({ pollId: votes.pollId })
      .from(votes)
      .where(and(eq(votes.tenantId, tenantId), eq(votes.voterRef, voterRef))),
    db
      .select({ pollId: voteAllocations.pollId })
      .from(voteAllocations)
      .where(
        and(eq(voteAllocations.tenantId, tenantId), eq(voteAllocations.voterRef, voterRef))
      ),
  ]);

  const pollIds: string[] = Array.from(
    new Set([...voteRows, ...allocRows].map((r: { pollId: string }) => r.pollId))
  );
  if (pollIds.length === 0) return [];

  const pollRows = await db
    .select({
      id: polls.id,
      frage: polls.frage,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      regionId: polls.regionId,
      regionTyp: regions.typ,
      regionName: regions.name,
      regionPath: sql<string>`${regions.path}::text`,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
      createdAt: polls.createdAt,
    })
    .from(polls)
    .innerJoin(regions, eq(regions.id, polls.regionId))
    .where(and(eq(polls.tenantId, tenantId), inArray(polls.id, pollIds)))
    .orderBy(desc(polls.createdAt));

  // Ergebnis je Poll (tenant-scoped Aggregation in einem Rutsch).
  const allVotes = await db
    .select({ pollId: votes.pollId, choice: votes.choice, warVerifiziert: votes.warVerifiziert })
    .from(votes)
    .where(and(eq(votes.tenantId, tenantId), inArray(votes.pollId, pollIds)));

  // Dot-Aggregat je dot_voting-Poll (Teilnahmen sind wenige — Einzel-Query je
  // Poll ist ok; getDotErgebnis kapselt die k-Maskierung zentral).
  const dotErgebnisse = new Map<string, DotVotingErgebnis | null>();
  for (const p of pollRows as PollListItem[]) {
    if (p.typ === "dot_voting") {
      dotErgebnisse.set(p.id, await getDotErgebnis(db, tenantId, p.id));
    }
  }

  type VoteAggRow = { pollId: string; choice: string; warVerifiziert: boolean };
  const now = new Date();
  return pollRows.map((p: PollListItem) => {
    const ergebnis = aggregateVotes(
      (allVotes as VoteAggRow[]).filter((v: VoteAggRow) => v.pollId === p.id)
    );
    return {
      ...p,
      // ADR-022: laufende Umfragen ohne per-Option-Aufschlüsselung.
      ergebnis: istBeendet(p, now) ? ergebnis : ohneAufschluesselung(ergebnis),
      dot: p.typ === "dot_voting" ? dotErgebnisse.get(p.id) : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Admin-Lese-Query: alle Umfragen des Tenants für die Verwaltung (Composer)
// ---------------------------------------------------------------------------

export interface PollAdminItem {
  id: string;
  frage: string;
  // ADR-024 contract: Gebietsknoten + Anzeigefelder statt scope_level/scope_code.
  regionId: string;
  regionTyp: RegionTyp;
  regionName: string;
  /** ltree-Pfad des Knotens (für die Beobachter-Sichtprüfung). */
  regionPath: string;
  status: (typeof pollStatusEnum.enumValues)[number];
  verbindlich: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  createdAt: Date;
  /** Anzahl aller abgegebenen Stimmen (tenant-scoped). */
  stimmenGesamt: number;
  /** Davon Stimmen mit war_verifiziert = true. */
  stimmenVerifiziert: number;
}

/**
 * Alle Umfragen des Tenants (jeden Status), neu→alt, jeweils mit Stimmenzählern
 * (gesamt + verifiziert). Tenant-scoped. Nur für Admin-Sichten gedacht — die
 * Aufrufer-Seite erzwingt die Admin-Berechtigung serverseitig.
 *
 * Effizient: EINE Aggregations-Query über votes (GROUP BY poll_id) statt N+1.
 * Anschließend per Map zugeordnet (wie getMeineTeilnahmen). Keine Roh-SQL-Dates —
 * es werden keine Zeit-Parameter gebunden (nur status/tenant-Filter).
 */
export async function getAllPollsForAdmin(
  db: Db,
  tenantId: string
): Promise<PollAdminItem[]> {
  const pollRows = await db
    .select({
      id: polls.id,
      frage: polls.frage,
      regionId: polls.regionId,
      regionTyp: regions.typ,
      regionName: regions.name,
      regionPath: sql<string>`${regions.path}::text`,
      status: polls.status,
      verbindlich: polls.verbindlich,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
      createdAt: polls.createdAt,
    })
    .from(polls)
    .innerJoin(regions, eq(regions.id, polls.regionId))
    .where(eq(polls.tenantId, tenantId))
    .orderBy(desc(polls.createdAt));

  if (pollRows.length === 0) return [];

  // Aggregation in EINEM Rutsch: gesamt + verifiziert je Poll (tenant-scoped).
  // FILTER (WHERE war_verifiziert) zählt nur verifizierte Stimmen.
  const aggRows = await db
    .select({
      pollId: votes.pollId,
      gesamt: count(),
      verifiziert: sql<number>`count(*) filter (where ${votes.warVerifiziert})`.mapWith(
        Number
      ),
    })
    .from(votes)
    .where(eq(votes.tenantId, tenantId))
    .groupBy(votes.pollId);

  type AggRow = { pollId: string; gesamt: number; verifiziert: number };
  const aggByPoll = new Map<string, AggRow>(
    (aggRows as AggRow[]).map((r) => [r.pollId, r])
  );

  type PollRow = (typeof pollRows)[number];
  return pollRows.map((p: PollRow) => {
    const agg = aggByPoll.get(p.id);
    return {
      ...p,
      stimmenGesamt: agg ? Number(agg.gesamt) : 0,
      stimmenVerifiziert: agg ? Number(agg.verifiziert) : 0,
    };
  });
}
