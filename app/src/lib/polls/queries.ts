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
import { polls, votes, scopeLevelEnum, pollStatusEnum } from "@/db/schema";
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
 * (das WIE). Damit verrät der „Sie haben abgestimmt"-Chip nie die getroffene Wahl.
 * Tenant-scoped + voter_ref-gebunden; ohne userId (nicht eingeloggt) leeres Set.
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

  const rows = await db
    .select({ pollId: votes.pollId })
    .from(votes)
    .where(
      and(
        eq(votes.tenantId, tenant.id),
        eq(votes.voterRef, voterRef),
        inArray(votes.pollId, pollIds)
      )
    );
  return new Set(rows.map((r: { pollId: string }) => r.pollId));
}

// ---------------------------------------------------------------------------
// Listing der Umfragen (ADR-014)
// ---------------------------------------------------------------------------

export interface PollListItem {
  id: string;
  frage: string;
  typ: "ja_nein_enthaltung";
  status: (typeof pollStatusEnum.enumValues)[number];
  verbindlich: boolean;
  scopeLevel: (typeof scopeLevelEnum.enumValues)[number];
  scopeCode: string | null;
  opensAt: Date | null;
  closesAt: Date | null;
  createdAt: Date;
}

export interface PollMitErgebnis extends PollListItem {
  ergebnis: PollErgebnis;
}

/**
 * Aktive, im Zeitfenster offene Umfragen des Tenants, neu→alt.
 *
 * Scope-Filter (Stufenmodell, geschachtelt): stadt/kreis/land werden im Pilot
 * wie stadtweit behandelt (alle sehen sie). Ortsteil-Umfragen NUR, wenn ihr
 * scopeCode dem userOrtsteilCode entspricht — ein Nutzer ohne Ortsteil (oder
 * nicht eingeloggt → userOrtsteilCode null/undefined) sieht keine Ortsteil-Polls.
 *
 * Zeitvergleiche IMMER über Drizzle-Operatoren (kein Roh-SQL-Date) — sonst
 * bricht der Treiber ab (siehe getAktiveFeaturedPoll).
 */
export async function getAktivePolls(
  db: Db,
  tenantId: string,
  opts?: { userOrtsteilCode?: string | null }
): Promise<PollListItem[]> {
  const now = new Date();
  const userOrtsteilCode = opts?.userOrtsteilCode ?? null;

  // Ortsteil-Polls nur, wenn der Code zum Nutzer-Ortsteil passt; alle anderen
  // Ebenen (stadt/kreis/land) sind tenant-weit sichtbar.
  const scopeFilter = userOrtsteilCode
    ? or(
        inArray(polls.scopeLevel, ["stadt", "kreis", "land"]),
        and(eq(polls.scopeLevel, "ortsteil"), eq(polls.scopeCode, userOrtsteilCode))
      )
    : inArray(polls.scopeLevel, ["stadt", "kreis", "land"]);

  return db
    .select({
      id: polls.id,
      frage: polls.frage,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      scopeLevel: polls.scopeLevel,
      scopeCode: polls.scopeCode,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
      createdAt: polls.createdAt,
    })
    .from(polls)
    .where(
      and(
        eq(polls.tenantId, tenantId),
        eq(polls.status, "aktiv"),
        or(isNull(polls.opensAt), lte(polls.opensAt, now)),
        or(isNull(polls.closesAt), gt(polls.closesAt, now)),
        scopeFilter
      )
    )
    .orderBy(desc(polls.createdAt));
}

/**
 * Umfragen, für die der eingeloggte User (voter_ref user-Domain) eine Stimme
 * abgegeben hat — neu→alt, jeweils mit Ergebnis-Aggregat. Tenant-scoped.
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

  // poll_ids mit einer Stimme dieses voter_ref (tenant-scoped).
  const voteRows = await db
    .select({ pollId: votes.pollId })
    .from(votes)
    .where(and(eq(votes.tenantId, tenantId), eq(votes.voterRef, voterRef)));

  const pollIds: string[] = Array.from(
    new Set(voteRows.map((r: { pollId: string }) => r.pollId))
  );
  if (pollIds.length === 0) return [];

  const pollRows = await db
    .select({
      id: polls.id,
      frage: polls.frage,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      scopeLevel: polls.scopeLevel,
      scopeCode: polls.scopeCode,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
      createdAt: polls.createdAt,
    })
    .from(polls)
    .where(and(eq(polls.tenantId, tenantId), inArray(polls.id, pollIds)))
    .orderBy(desc(polls.createdAt));

  // Ergebnis je Poll (tenant-scoped Aggregation in einem Rutsch).
  const allVotes = await db
    .select({ pollId: votes.pollId, choice: votes.choice, warVerifiziert: votes.warVerifiziert })
    .from(votes)
    .where(and(eq(votes.tenantId, tenantId), inArray(votes.pollId, pollIds)));

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
    };
  });
}

// ---------------------------------------------------------------------------
// Admin-Lese-Query: alle Umfragen des Tenants für die Verwaltung (Composer)
// ---------------------------------------------------------------------------

export interface PollAdminItem {
  id: string;
  frage: string;
  scopeLevel: (typeof scopeLevelEnum.enumValues)[number];
  scopeCode: string | null;
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
      scopeLevel: polls.scopeLevel,
      scopeCode: polls.scopeCode,
      status: polls.status,
      verbindlich: polls.verbindlich,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
      createdAt: polls.createdAt,
    })
    .from(polls)
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
