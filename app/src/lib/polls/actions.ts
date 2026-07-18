/**
 * actions.ts — Server Actions für die Mitmach-Schleife (M3 lokale Umfragen)
 *
 * Gate-B: Server Actions sind eigenständige Endpoints — Auth/Validierung/Tenant
 * werden serverseitig erzwungen, nie dem Client vertraut.
 *
 * SICHERHEITS-KERN (Vertrauensprodukt):
 *   - Secret Ballot: die Wahl (choice) steht NUR in der votes-Zeile, verknüpft
 *     mit dem pseudonymen voter_ref. Das Audit (poll.voted) enthält NIE die Wahl.
 *   - Stufe-1-Pflicht (ADR-014): Mitstimmen erfordert ein bestätigtes Konto
 *     (Magic-Link). Anonymes Abstimmen entfällt — jede Stimme hängt an einer
 *     verifizierten E-Mail (Bot-/Troll-Schutz). voter_ref immer user-Domain.
 *   - Verbindlich-Gating: poll.verbindlich ⇒ getStufe(user) ≥ 2 (hart, serverseitig).
 *   - Doppelstimmen-Schutz: UNIQUE(poll_id, voter_ref) + onConflictDoNothing →
 *     freundliche "bereits abgestimmt"-Meldung (kein Fehler).
 *   - IP-Hash-Rate-Limit (zusätzlich zu user) gegen Massen-Abstimmen.
 *   - Tenant-Isolation: jede Query ist tenant-scoped (Host → Tenant).
 *
 * Frage UND Ergebnis bleiben für alle sichtbar (auch nicht angemeldet) — nur das
 * Mitstimmen kostet die kurze Anmeldung. Der Auth-Kontext lädt Tenant aus dem
 * Host und die Session OPTIONAL (damit nicht-eingeloggte sauber needLogin sehen).
 */

"use server";

import { headers } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db } from "@/db/client";
import {
  polls,
  votes,
  pollOptions,
  voteAllocations,
  voteResistances,
  auditEvents,
} from "@/db/schema";
import { SCOPE_INPUT_LEVELS } from "@/lib/region/ebenen";
import { getStufe } from "@/lib/eligibility/stufe";
import {
  getOptionalAuthContext,
  getClientIp,
  requireAdminCtx,
} from "@/lib/auth/action-context";
import { computeVoterRefForUser } from "@/lib/polls/voter-ref";
import { isDemoTenant } from "@/lib/demo/config";
import { istMusterstadtSeedPollId } from "@/lib/demo/seed-ids";
import { istGebietsZustaendig, waehleAnkerRegionId } from "@/lib/polls/gebiet";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { getRegion } from "@/lib/region/tree";
import { getUserRolesMitScope } from "@/lib/auth/roles";
import {
  pollGebietErlaubt,
  istSuperAdminScope,
  pollVerwaltungErlaubt,
} from "@/lib/polls/composer-autoritaet";
import { insertBelegCode } from "@/lib/polls/beleg";
import { checkVoteRateLimit } from "@/lib/polls/rate-limit";
import { isValidChoice } from "@/lib/polls/ergebnis";
import {
  validateDotAllocations,
  DOT_OPTIONEN_MIN,
  DOT_OPTIONEN_MAX,
  DOT_BUDGET_MIN,
  DOT_BUDGET_MAX,
  DOT_OPTION_LABEL_MAX,
} from "@/lib/polls/dot";
import { validateWiderstandsWerte } from "@/lib/polls/widerstand";
import { notifyNewPoll, type NotifyPoll } from "@/lib/polls/notify";
import {
  createDefaultTransport,
  type NotifyTransport,
} from "@/lib/anliegen/notify";
import {
  kiPruefungAktiv,
  pruefungAbschliessenCore,
  type Verdict,
} from "@/lib/polls/pruefung-core";
import { isSelfApprovalAllowed } from "@/lib/digest/freigabe-core";
import type { TenantRow } from "@/lib/tenant";

// ---------------------------------------------------------------------------
// abstimmen — die Kern-Action (NUR eingeloggt, Stufe ≥ 1; ADR-014)
// ---------------------------------------------------------------------------

const abstimmenSchema = z.object({
  pollId: z.string().uuid(),
  choice: z.enum(["ja", "nein", "enthaltung"]),
});

export interface AbstimmenResult {
  ok: boolean;
  alreadyVoted?: boolean;
  /** true ⇒ nicht eingeloggt: Client zeigt freundlichen Anmelde-CTA statt Fehler. */
  needLogin?: boolean;
  error?: string;
  /**
   * Einmaliger Beleg-Code (D4, ADR-016) — NUR bei einer frischen Stimme gesetzt
   * (nie bei alreadyVoted). Secret-Ballot-konform: beweist DASS, nie WIE. Wird
   * nicht pro Person gespeichert; der Client zeigt ihn genau einmal.
   */
  beleg?: string;
}

export async function abstimmen(
  pollId: string,
  choice: string
): Promise<AbstimmenResult> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };

  // Stufe-1-Pflicht (ADR-014): ohne Konto KEINE Stimme. Frage/Ergebnis bleiben
  // sichtbar — der Client zeigt bei needLogin einen Anmelde-CTA statt Fehler.
  if (!ctx.userId) {
    return {
      ok: false,
      needLogin: true,
      error: "Bitte melden Sie sich an, um mitzustimmen.",
    };
  }

  const parsed = abstimmenSchema.safeParse({ pollId, choice });
  if (!parsed.success) {
    return { ok: false, error: "Ungültige Eingabe." };
  }

  // Poll tenant-scoped laden
  const pollRows = await ctx.db
    .select({
      id: polls.id,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      regionId: polls.regionId,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
    })
    .from(polls)
    .where(and(eq(polls.id, parsed.data.pollId), eq(polls.tenantId, ctx.tenant.id)))
    .limit(1);

  const poll = pollRows[0];
  if (!poll) return { ok: false, error: "Diese Frage gibt es nicht." };

  // Status + Zeitfenster
  const now = new Date();
  if (poll.status !== "aktiv") {
    return { ok: false, error: "Diese Abstimmung ist derzeit nicht offen." };
  }
  if (poll.opensAt && poll.opensAt > now) {
    return { ok: false, error: "Diese Abstimmung hat noch nicht begonnen." };
  }
  if (poll.closesAt && poll.closesAt <= now) {
    return { ok: false, error: "Diese Abstimmung ist bereits beendet." };
  }

  // choice gegen den Poll-Typ validieren (vorerst nur ja_nein_enthaltung)
  if (poll.typ === "ja_nein_enthaltung") {
    if (!isValidChoice(parsed.data.choice)) {
      return { ok: false, error: "Ungültige Auswahl." };
    }
  } else {
    return { ok: false, error: "Dieser Fragetyp wird nicht unterstützt." };
  }

  // Stufe bestimmen. war_verifiziert = Snapshot Stufe≥2 (wohnsitz-verifiziert).
  const stufe = getStufe(ctx.user);
  const warVerifiziert = stufe >= 2;

  // Stufe-1-Pflicht HART (ADR-014): Eine gültige Session allein genügt nicht —
  // ein Konto ohne bestätigtes Mindestalter oder mit inaktivem Status ist Stufe 0
  // und darf NICHT abstimmen. needLogin lenkt freundlich zur Anmeldung/Profil.
  if (stufe < 1) {
    return {
      ok: false,
      needLogin: true,
      error: "Bitte melden Sie sich an, um mitzustimmen.",
    };
  }

  // Verbindlich-Gating: HART serverseitig (nur Stufe ≥ 2).
  if (poll.verbindlich && stufe < 2) {
    return {
      ok: false,
      error: "Diese verbindliche Abstimmung ist verifizierten Bürger:innen vorbehalten.",
    };
  }

  // Gebiets-Zuständigkeit HART serverseitig (Audit M2): Die Lese-Sicht blendet
  // fremde Gebiete aus — hier wird das durchgesetzt, damit Detail-URL/Direkt-
  // aufruf keine Stimme in einem fremden Ortsteil/Gebiet erlaubt. Anker je nach
  // Verbindlichkeit (verifizierter vs. weicher Wohnsitz), Fallback Gemeinde-Knoten.
  // stufe >= 1 (oben geprüft) ⇒ ctx.user ist non-null (getStufe(null)=0).
  const ankerRegionId = ctx.user
    ? waehleAnkerRegionId(ctx.user, poll.verbindlich)
    : null;
  const gebietsZustaendig = await istGebietsZustaendig(
    ctx.db,
    ctx.tenant.id,
    poll.regionId,
    ankerRegionId,
  );
  if (!gebietsZustaendig) {
    return {
      ok: false,
      error: "Diese Abstimmung gehört nicht zu Ihrem Gebiet.",
    };
  }

  // voter_ref: immer user-Domain (kein anonymer Device-Pfad mehr, ADR-014).
  let voterRef: string;
  try {
    voterRef = computeVoterRefForUser(ctx.userId);
  } catch (err) {
    console.error("[abstimmen] Fehler bei voter_ref:", err);
    return { ok: false, error: "Konfigurationsfehler — bitte später erneut versuchen." };
  }

  // Rate-Limit (IP + user via voter_ref). write-then-count.
  const ipAddress = await getClientIp();
  const rl = await checkVoteRateLimit(ctx.db, {
    tenantId: ctx.tenant.id,
    actorRef: voterRef,
    ipAddress,
    deviceToken: null,
  });
  if (!rl.allowed) {
    return {
      ok: false,
      error: "Zu viele Stimmen in kurzer Zeit. Bitte versuchen Sie es später erneut.",
    };
  }

  // Insert mit onConflictDoNothing auf UNIQUE(pollId, voterRef).
  // Audit (PII-frei, OHNE choice) in DERSELBEN Transaktion.
  const result = await ctx.db.transaction(async (tx: Db) => {
    // F: Status/Zeitfenster ATOMAR prüfen (Row-Lock) — schließt das TOCTOU-Fenster
    // zwischen Vorprüfung und Insert (wichtig v.a. für verbindliche Abstimmungen).
    const liveRows = await tx
      .select({ status: polls.status, opensAt: polls.opensAt, closesAt: polls.closesAt })
      .from(polls)
      .where(and(eq(polls.id, poll.id), eq(polls.tenantId, ctx.tenant.id)))
      .for("update")
      .limit(1);
    const live = liveRows[0];
    if (
      !live ||
      live.status !== "aktiv" ||
      (live.opensAt && live.opensAt > now) ||
      (live.closesAt && live.closesAt <= now)
    ) {
      return { ok: false as const, error: "Diese Abstimmung ist derzeit nicht offen." };
    }

    const inserted = await tx
      .insert(votes)
      .values({
        pollId: poll.id,
        tenantId: ctx.tenant.id,
        voterRef,
        choice: parsed.data.choice,
        warVerifiziert,
      })
      .onConflictDoNothing({ target: [votes.pollId, votes.voterRef] })
      .returning({ id: votes.id });

    if (inserted.length === 0) {
      // Bereits abgestimmt — kein Fehler, Ergebnis anzeigen. KEIN neuer Beleg
      // (der wurde bei der ersten Stimme einmalig vergeben und nie pro Person
      // gespeichert — er lässt sich bewusst nicht erneut abrufen).
      return { ok: true as const, alreadyVoted: true };
    }

    // D4 (ADR-016): EINEN Beleg-Code für diese Stimme erzeugen — in DERSELBEN
    // Transaktion (Invariante #Belege == #Stimmen). Die Tabelle kennt weder
    // voter_ref noch choice → der Beleg ist mit nichts verkettbar (Secret Ballot).
    const beleg = await insertBelegCode(tx, ctx.tenant.id, poll.id);

    // SECRET BALLOT: NIEMALS die Wahl ins Audit. Nur pollId + Verifiziert-Flag.
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "user",
      actorRef: voterRef, // Pseudonym, kein User-Identifier
      action: "poll.voted",
      targetType: "poll",
      targetId: poll.id,
      metadata: { pollId: poll.id, warVerifiziert },
    });

    return { ok: true as const, alreadyVoted: false, beleg };
  });

  return result;
}

// ---------------------------------------------------------------------------
// dotAbstimmen — Punkte-/Budget-Verteilung (ADR-025)
// ---------------------------------------------------------------------------

const dotAbstimmenSchema = z.object({
  pollId: z.string().uuid(),
  allocations: z
    .array(z.object({ optionId: z.string().uuid(), punkte: z.number().int() }))
    .max(DOT_OPTIONEN_MAX),
});

/**
 * Gibt eine Dot-Voting-Stimme ab: der Wähler verteilt Punkte auf Optionen.
 * Spiegelt die Sicherheits-Gates von abstimmen() (Stufe, Verbindlich, Gebiet,
 * Rate-Limit, Beleg, PII-freies Audit) und schreibt eine vote_allocations-Zeile
 * je Option. Secret Ballot: weder Punkte noch Optionen gehen ins Audit; ein
 * Advisory-Lock je (Umfrage, voter_ref) verhindert Teil-Doppelabgaben race-frei.
 */
export async function dotAbstimmen(
  pollId: string,
  allocations: unknown,
): Promise<AbstimmenResult> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (!ctx.userId) {
    return { ok: false, needLogin: true, error: "Bitte melden Sie sich an, um mitzustimmen." };
  }

  const parsed = dotAbstimmenSchema.safeParse({ pollId, allocations });
  if (!parsed.success) return { ok: false, error: "Ungültige Eingabe." };

  // Poll tenant-scoped laden (inkl. typ + Budget).
  const pollRows = await ctx.db
    .select({
      id: polls.id,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      regionId: polls.regionId,
      punkteBudget: polls.punkteBudget,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
    })
    .from(polls)
    .where(and(eq(polls.id, parsed.data.pollId), eq(polls.tenantId, ctx.tenant.id)))
    .limit(1);
  const poll = pollRows[0];
  if (!poll) return { ok: false, error: "Diese Frage gibt es nicht." };
  if (poll.typ !== "dot_voting" || poll.punkteBudget == null) {
    return { ok: false, error: "Diese Abstimmung ist kein Punkte-Voting." };
  }

  const now = new Date();
  if (poll.status !== "aktiv") return { ok: false, error: "Diese Abstimmung ist derzeit nicht offen." };
  if (poll.opensAt && poll.opensAt > now) return { ok: false, error: "Diese Abstimmung hat noch nicht begonnen." };
  if (poll.closesAt && poll.closesAt <= now) return { ok: false, error: "Diese Abstimmung ist bereits beendet." };

  // Optionen der Umfrage laden → gültige optionIds.
  const optionRows = await ctx.db
    .select({ id: pollOptions.id })
    .from(pollOptions)
    .where(and(eq(pollOptions.pollId, poll.id), eq(pollOptions.tenantId, ctx.tenant.id)));
  const gueltigeOptionIds = new Set<string>(optionRows.map((o: { id: string }) => o.id));

  // Zuteilungen serverseitig validieren (Budget, gültige Optionen, ≥1 Punkt).
  const val = validateDotAllocations(parsed.data.allocations, gueltigeOptionIds, poll.punkteBudget);
  if (!val.ok) return { ok: false, error: val.error };

  const stufe = getStufe(ctx.user);
  const warVerifiziert = stufe >= 2;
  if (stufe < 1) return { ok: false, needLogin: true, error: "Bitte melden Sie sich an, um mitzustimmen." };
  if (poll.verbindlich && stufe < 2) {
    return { ok: false, error: "Diese verbindliche Abstimmung ist verifizierten Bürger:innen vorbehalten." };
  }

  // Gebiets-Zuständigkeit (Audit M2), identisch zu abstimmen().
  const ankerRegionId = ctx.user ? waehleAnkerRegionId(ctx.user, poll.verbindlich) : null;
  if (!(await istGebietsZustaendig(ctx.db, ctx.tenant.id, poll.regionId, ankerRegionId))) {
    return { ok: false, error: "Diese Abstimmung gehört nicht zu Ihrem Gebiet." };
  }

  let voterRef: string;
  try {
    voterRef = computeVoterRefForUser(ctx.userId);
  } catch (err) {
    console.error("[dotAbstimmen] Fehler bei voter_ref:", err);
    return { ok: false, error: "Konfigurationsfehler — bitte später erneut versuchen." };
  }

  const ipAddress = await getClientIp();
  const rl = await checkVoteRateLimit(ctx.db, {
    tenantId: ctx.tenant.id,
    actorRef: voterRef,
    ipAddress,
    deviceToken: null,
  });
  if (!rl.allowed) {
    return { ok: false, error: "Zu viele Stimmen in kurzer Zeit. Bitte versuchen Sie es später erneut." };
  }

  const result = await ctx.db.transaction(async (tx: Db) => {
    // Advisory-Lock je (Umfrage, Wähler) → serialisiert nebenläufige Abgaben
    // desselben Wählers (verhindert Teil-Doppelabgabe über verschiedene Options-
    // Mengen; die UNIQUE je Option allein reicht dafür nicht).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${poll.id + ":" + voterRef}))`);

    // Live-Status atomar prüfen (TOCTOU).
    const liveRows = await tx
      .select({ status: polls.status, opensAt: polls.opensAt, closesAt: polls.closesAt })
      .from(polls)
      .where(and(eq(polls.id, poll.id), eq(polls.tenantId, ctx.tenant.id)))
      .for("update")
      .limit(1);
    const live = liveRows[0];
    if (!live || live.status !== "aktiv" || (live.opensAt && live.opensAt > now) || (live.closesAt && live.closesAt <= now)) {
      return { ok: false as const, error: "Diese Abstimmung ist derzeit nicht offen." };
    }

    // Schon abgestimmt? (irgendeine Zuteilung dieses Wählers für die Umfrage)
    const bestehend = await tx
      .select({ id: voteAllocations.id })
      .from(voteAllocations)
      .where(and(eq(voteAllocations.pollId, poll.id), eq(voteAllocations.voterRef, voterRef)))
      .limit(1);
    if (bestehend.length > 0) {
      return { ok: true as const, alreadyVoted: true };
    }

    await tx.insert(voteAllocations).values(
      val.allocations.map((a) => ({
        pollId: poll.id,
        tenantId: ctx.tenant.id,
        optionId: a.optionId,
        voterRef,
        punkte: a.punkte,
        warVerifiziert,
      })),
    );

    // EIN Beleg je Wähler (nicht je Option) — Invariante bleibt „ein Beleg je
    // Stimme"; die Tabelle kennt weder voter_ref noch Punkte/Option.
    const beleg = await insertBelegCode(tx, ctx.tenant.id, poll.id);

    // SECRET BALLOT: weder Punkte noch Optionen ins Audit. Nur pollId + Flag.
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "user",
      actorRef: voterRef,
      action: "poll.voted",
      targetType: "poll",
      targetId: poll.id,
      metadata: { pollId: poll.id, warVerifiziert, format: "dot_voting" },
    });

    return { ok: true as const, alreadyVoted: false, beleg };
  });

  return result;
}

// ---------------------------------------------------------------------------
// widerstandAbstimmen — Widerstandsabfrage / Systemisches Konsensieren (ADR-025)
// ---------------------------------------------------------------------------

const widerstandAbstimmenSchema = z.object({
  pollId: z.string().uuid(),
  // Geteilte poll_options-Grenze: mehr Werte als Optionen kann es nie geben.
  werte: z
    .array(z.object({ optionId: z.string().uuid(), wert: z.number().int() }))
    .max(DOT_OPTIONEN_MAX),
});

/**
 * Gibt eine Widerstandsabfrage-Stimme ab: der Wähler bewertet JEDE Option mit
 * einem Widerstandswert 0–10 (vollständige Abgabe — validateWiderstandsWerte
 * erzwingt sie; wert=0 wird MIT gespeichert, sonst wären die Summen verzerrt).
 * Spiegelt die Sicherheits-Gates von dotAbstimmen() (Stufe, Verbindlich, Gebiet,
 * Rate-Limit, Beleg, PII-freies Audit) und schreibt eine vote_resistances-Zeile
 * je Option. Secret Ballot: weder Werte noch Optionen gehen ins Audit; ein
 * Advisory-Lock je (Umfrage, voter_ref) verhindert Teil-Doppelabgaben race-frei.
 */
export async function widerstandAbstimmen(
  pollId: string,
  werte: unknown,
): Promise<AbstimmenResult> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (!ctx.userId) {
    return { ok: false, needLogin: true, error: "Bitte melden Sie sich an, um mitzustimmen." };
  }

  const parsed = widerstandAbstimmenSchema.safeParse({ pollId, werte });
  if (!parsed.success) return { ok: false, error: "Ungültige Eingabe." };

  // Poll tenant-scoped laden (inkl. typ).
  const pollRows = await ctx.db
    .select({
      id: polls.id,
      typ: polls.typ,
      status: polls.status,
      verbindlich: polls.verbindlich,
      regionId: polls.regionId,
      opensAt: polls.opensAt,
      closesAt: polls.closesAt,
    })
    .from(polls)
    .where(and(eq(polls.id, parsed.data.pollId), eq(polls.tenantId, ctx.tenant.id)))
    .limit(1);
  const poll = pollRows[0];
  if (!poll) return { ok: false, error: "Diese Frage gibt es nicht." };
  if (poll.typ !== "widerstandsabfrage") {
    return { ok: false, error: "Diese Abstimmung ist keine Widerstandsabfrage." };
  }

  const now = new Date();
  if (poll.status !== "aktiv") return { ok: false, error: "Diese Abstimmung ist derzeit nicht offen." };
  if (poll.opensAt && poll.opensAt > now) return { ok: false, error: "Diese Abstimmung hat noch nicht begonnen." };
  if (poll.closesAt && poll.closesAt <= now) return { ok: false, error: "Diese Abstimmung ist bereits beendet." };

  // Optionen der Umfrage laden → gültige optionIds.
  const optionRows = await ctx.db
    .select({ id: pollOptions.id })
    .from(pollOptions)
    .where(and(eq(pollOptions.pollId, poll.id), eq(pollOptions.tenantId, ctx.tenant.id)));
  const gueltigeOptionIds = new Set<string>(optionRows.map((o: { id: string }) => o.id));

  // Werte serverseitig validieren (Vollständigkeit, gültige Optionen, 0–10).
  const val = validateWiderstandsWerte(parsed.data.werte, gueltigeOptionIds);
  if (!val.ok) return { ok: false, error: val.error };

  const stufe = getStufe(ctx.user);
  const warVerifiziert = stufe >= 2;
  if (stufe < 1) return { ok: false, needLogin: true, error: "Bitte melden Sie sich an, um mitzustimmen." };
  if (poll.verbindlich && stufe < 2) {
    return { ok: false, error: "Diese verbindliche Abstimmung ist verifizierten Bürger:innen vorbehalten." };
  }

  // Gebiets-Zuständigkeit (Audit M2), identisch zu abstimmen().
  const ankerRegionId = ctx.user ? waehleAnkerRegionId(ctx.user, poll.verbindlich) : null;
  if (!(await istGebietsZustaendig(ctx.db, ctx.tenant.id, poll.regionId, ankerRegionId))) {
    return { ok: false, error: "Diese Abstimmung gehört nicht zu Ihrem Gebiet." };
  }

  let voterRef: string;
  try {
    voterRef = computeVoterRefForUser(ctx.userId);
  } catch (err) {
    console.error("[widerstandAbstimmen] Fehler bei voter_ref:", err);
    return { ok: false, error: "Konfigurationsfehler — bitte später erneut versuchen." };
  }

  const ipAddress = await getClientIp();
  const rl = await checkVoteRateLimit(ctx.db, {
    tenantId: ctx.tenant.id,
    actorRef: voterRef,
    ipAddress,
    deviceToken: null,
  });
  if (!rl.allowed) {
    return { ok: false, error: "Zu viele Stimmen in kurzer Zeit. Bitte versuchen Sie es später erneut." };
  }

  const result = await ctx.db.transaction(async (tx: Db) => {
    // Advisory-Lock je (Umfrage, Wähler) → serialisiert nebenläufige Abgaben
    // desselben Wählers (verhindert Teil-Doppelabgabe über verschiedene Options-
    // Mengen; die UNIQUE je Option allein reicht dafür nicht).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${poll.id + ":" + voterRef}))`);

    // Live-Status atomar prüfen (TOCTOU).
    const liveRows = await tx
      .select({ status: polls.status, opensAt: polls.opensAt, closesAt: polls.closesAt })
      .from(polls)
      .where(and(eq(polls.id, poll.id), eq(polls.tenantId, ctx.tenant.id)))
      .for("update")
      .limit(1);
    const live = liveRows[0];
    if (!live || live.status !== "aktiv" || (live.opensAt && live.opensAt > now) || (live.closesAt && live.closesAt <= now)) {
      return { ok: false as const, error: "Diese Abstimmung ist derzeit nicht offen." };
    }

    // Schon abgestimmt? (irgendein Widerstandswert dieses Wählers für die Umfrage)
    const bestehend = await tx
      .select({ id: voteResistances.id })
      .from(voteResistances)
      .where(and(eq(voteResistances.pollId, poll.id), eq(voteResistances.voterRef, voterRef)))
      .limit(1);
    if (bestehend.length > 0) {
      return { ok: true as const, alreadyVoted: true };
    }

    // ALLE Werte-Zeilen schreiben — auch wert=0 (vollständige Abgabe, sonst
    // wären die Widerstands-Summen verzerrt).
    await tx.insert(voteResistances).values(
      val.werte.map((w) => ({
        pollId: poll.id,
        tenantId: ctx.tenant.id,
        optionId: w.optionId,
        voterRef,
        wert: w.wert,
        warVerifiziert,
      })),
    );

    // EIN Beleg je Wähler (nicht je Option) — Invariante bleibt „ein Beleg je
    // Stimme"; die Tabelle kennt weder voter_ref noch Werte/Option.
    const beleg = await insertBelegCode(tx, ctx.tenant.id, poll.id);

    // SECRET BALLOT: weder Werte noch Optionen ins Audit. Nur pollId + Flag.
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "user",
      actorRef: voterRef,
      action: "poll.voted",
      targetType: "poll",
      targetId: poll.id,
      metadata: { pollId: poll.id, warVerifiziert, format: "widerstandsabfrage" },
    });

    return { ok: true as const, alreadyVoted: false, beleg };
  });

  return result;
}

// Lese-Funktionen (getPollErgebnis / getAktiveFeaturedPoll / hatBereitsAbgestimmt)
// liegen bewusst in @/lib/polls/queries (OHNE "use server"), damit sie nicht als
// client-aufrufbare RPC-Endpunkte exponiert werden (Gate-B MAJOR-G).

// ---------------------------------------------------------------------------
// Minimal-Admin: Umfrage anlegen & aktivieren (nur Admins)
// ---------------------------------------------------------------------------

const pollErstellenSchema = z.object({
  frage: z.string().trim().min(5, "Die Frage ist zu kurz.").max(500, "Die Frage ist zu lang."),
  // ADR-024 contract: Composer-Eingabe-Ebene als TS-Union (kein DB-Enum mehr),
  // serverseitig zu region_id aufgelöst.
  scopeLevel: z.enum(SCOPE_INPUT_LEVELS),
  scopeCode: z.string().trim().max(100).optional().nullable(),
  verbindlich: z.boolean().optional(),
  closesAt: z.coerce.date().optional().nullable(),
  // Beteiligungsformat (ADR-025). Default = binäres Ja/Nein.
  typ: z.enum(["ja_nein_enthaltung", "dot_voting", "widerstandsabfrage"]).optional(),
  // Nicht-binäre Formate (dot_voting + widerstandsabfrage): Optionen (Labels).
  optionen: z
    .array(z.string().trim().min(1, "Leere Option.").max(DOT_OPTION_LABEL_MAX, "Option zu lang."))
    .optional(),
  // Nur dot_voting: Punktebudget je Wähler.
  punkteBudget: z.coerce.number().int().optional(),
});

export async function pollErstellen(
  rawData: unknown
): Promise<{ ok: boolean; pollId?: string; error?: string }> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const parsed = pollErstellenSchema.safeParse(rawData);
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Ungültige Eingabe.";
    return { ok: false, error: msg };
  }
  const { frage, scopeLevel, scopeCode, verbindlich, closesAt } = parsed.data;
  const typ = parsed.data.typ ?? "ja_nein_enthaltung";

  // Nicht-binäre Formate (dot_voting + widerstandsabfrage): Optionen serverseitig
  // validieren (Client nie vertrauen); geteilte poll_options-Grenzen aus dot.ts.
  // Das Punktebudget bleibt dot-only (bei widerstandsabfrage NULL).
  let formatOptionen: string[] = [];
  let punkteBudget: number | null = null;
  if (typ !== "ja_nein_enthaltung") {
    formatOptionen = (parsed.data.optionen ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    if (formatOptionen.length < DOT_OPTIONEN_MIN || formatOptionen.length > DOT_OPTIONEN_MAX) {
      return {
        ok: false,
        error: `Bitte ${DOT_OPTIONEN_MIN}–${DOT_OPTIONEN_MAX} Optionen angeben.`,
      };
    }
    if (new Set(formatOptionen.map((s) => s.toLowerCase())).size !== formatOptionen.length) {
      return { ok: false, error: "Die Optionen müssen sich unterscheiden." };
    }
  }
  if (typ === "dot_voting") {
    const budget = parsed.data.punkteBudget ?? 0;
    if (!Number.isInteger(budget) || budget < DOT_BUDGET_MIN || budget > DOT_BUDGET_MAX) {
      return {
        ok: false,
        error: `Das Punktebudget muss zwischen ${DOT_BUDGET_MIN} und ${DOT_BUDGET_MAX} liegen.`,
      };
    }
    punkteBudget = budget;
  }

  // ADR-024 contract: die Composer-Scope-Eingabe wird via Baum zu region_id
  // aufgelöst — der EINZIGE geschriebene Gebietsbezug (scope_level/scope_code sind
  // entfernt). Kein Gebiet hinterlegt → freundlicher Fehler statt DB-Exception.
  let regionId: string;
  try {
    regionId = await resolveRegionIdForScope(ctx.db, ctx.tenant.id, scopeLevel, scopeCode ?? null);
  } catch {
    return { ok: false, error: "Für die gewählte Ebene ist noch kein Gebiet hinterlegt." };
  }

  // GEBIETS-AUTORITÄT (Block H, fail-closed): requireAdminCtx stellt nur „irgendein
  // Admin des Tenants" sicher — HIER wird zusätzlich erzwungen, dass das aufgelöste
  // Ziel-Gebiet vom eigenen Rollen-Pfad gedeckt ist (kommune_admin an sein Gebiet
  // gebunden; super_admin bypass). Das schließt die bestehende Lücke: ein
  // präparierter Request mit scopeLevel:"kreis"/"land" wird abgelehnt, obwohl
  // resolveRegionIdForScope den groben Knoten tenant-intern auflösen würde.
  const scopes = await getUserRolesMitScope(ctx.db, ctx.tenant.id, ctx.userId);
  const istSuperAdmin = istSuperAdminScope(scopes);
  const zielRegion = await getRegion(ctx.db, regionId);
  const zielPath = zielRegion?.path ?? null;
  // H bleibt bewusst ABWÄRTS: Poll-Erstellung nur auf Gemeinde-/Ortsteil-Ebene.
  // kreis/land/bund gehören dem Separate-Tenant-Modell (PR #49) und werden hier
  // hart abgelehnt — auch für super_admin (der Bypass gilt der Gebiets-Bindung
  // pfadDecktAb, NICHT der Ebenen-Grenze). Sonst könnte ein Direkt-Action-Aufruf
  // mit scopeLevel:"kreis" die Feed-Begrenzung umgehen.
  const zielTypErlaubt = zielRegion?.typ === "gemeinde" || zielRegion?.typ === "ortsteil";
  if (!zielPath || !zielTypErlaubt || !pollGebietErlaubt(scopes, istSuperAdmin, zielPath)) {
    // Verstoß PII-frei protokollieren (nur Scope-Ebene, kein Poll-Inhalt); noch
    // keine Poll → targetId null.
    await ctx.db.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "poll.create_denied",
      targetType: "poll",
      targetId: null,
      metadata: { scopeLevel },
    });
    return { ok: false, error: "Für dieses Gebiet sind Sie nicht berechtigt." };
  }

  const pollId = await ctx.db.transaction(async (tx: Db) => {
    const [row] = await tx
      .insert(polls)
      .values({
        tenantId: ctx.tenant.id,
        regionId,
        frage,
        typ,
        punkteBudget,
        status: "entwurf",
        verbindlich: verbindlich ?? false,
        erstelltVon: ctx.userId,
        closesAt: closesAt ?? null,
      })
      .returning({ id: polls.id });

    // Optionen für beide Nicht-binär-Formate (poll_options ist format-neutral).
    if (typ !== "ja_nein_enthaltung") {
      await tx.insert(pollOptions).values(
        formatOptionen.map((label, position) => ({
          pollId: row.id,
          tenantId: ctx.tenant.id,
          label,
          position,
        })),
      );
    }

    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "poll.created",
      targetType: "poll",
      targetId: row.id,
      // PII-/inhaltsarm: nur Metadaten, keine Options-Labels ins Audit.
      metadata: {
        pollId: row.id,
        verbindlich: verbindlich ?? false,
        scopeLevel,
        typ,
        // optionenAnzahl für beide Nicht-binär-Formate; punkteBudget nur dot.
        ...(typ !== "ja_nein_enthaltung" ? { optionenAnzahl: formatOptionen.length } : {}),
        ...(typ === "dot_voting" ? { punkteBudget } : {}),
      },
    });

    return row.id;
  });

  return { ok: true, pollId };
}

export async function pollAktivieren(
  pollId: string,
  // Transport injizierbar für Tests (Spy); Default createDefaultTransport().
  transport: NotifyTransport = createDefaultTransport()
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(pollId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Umfrage-ID." };

  // Seed-Schutz (Demo-Spielwiese): die drei kuratierten Beispiel-Fragen sind
  // der Bürger-Rundgang — ephemere Demo-Admins dürfen sie nicht verändern
  // (defensiv: die Seeds sind aktiv/geschlossen, der Status-Guard griffe schon).
  if (isDemoTenant(ctx.tenant.slug) && istMusterstadtSeedPollId(ctx.tenant.slug, idParsed.data)) {
    return { ok: false, error: "Diese Beispiel-Frage gehört zum Demo-Rundgang und bleibt unverändert." };
  }

  // GEBIETS-AUTORITÄT (Block H, symmetrisch zur Erstellung): ein gebietsgebundener
  // Admin darf eine Poll AUSSERHALB seines Gebiets nicht aktivieren. Prüfung gegen
  // poll.region_id VOR dem Status-UPDATE (super_admin bypass). Existiert die Poll im
  // Tenant nicht, übernimmt der atomare Status-Guard unten die „nicht gefunden"-Meldung.
  const scopes = await getUserRolesMitScope(ctx.db, ctx.tenant.id, ctx.userId);
  if (!(await pollVerwaltungErlaubt(ctx.db, ctx.tenant.id, idParsed.data, scopes, istSuperAdminScope(scopes)))) {
    return { ok: false, error: "Für dieses Gebiet sind Sie nicht berechtigt." };
  }

  // Block L (ADR-028): Ist der KI-Neutralitäts-Check für den Tenant AN, geht die
  // Umfrage NICHT direkt live, sondern in den Zustand `in_pruefung` (Betreiber
  // bewertet sie assisted anhand des öffentlichen Prompts, dann Freigabe/Anhalten
  // via pollPruefungAbschliessen). Der CAS bleibt `WHERE status='entwurf'`; nur das
  // Ziel + die Audit-Aktion unterscheiden sich, und opens_at wird ERST bei der
  // echten Aktivierung gesetzt (in der Prüf-Freigabe), nicht schon hier.
  const gehtInPruefung = kiPruefungAktiv(ctx.tenant);

  const result = await ctx.db.transaction(async (tx: Db) => {
    // TOCTOU-Guard: nur aus 'entwurf', tenant-scoped. Poll-Daten (frage/region)
    // werden für die spätere Benachrichtigung MITGEFÜHRT (kein Zweit-Read nötig).
    const updated = await tx
      .update(polls)
      .set(
        gehtInPruefung
          ? { status: "in_pruefung" }
          : { status: "aktiv", opensAt: sql`COALESCE(${polls.opensAt}, now())` }
      )
      .where(
        and(
          eq(polls.id, idParsed.data),
          eq(polls.tenantId, ctx.tenant.id),
          eq(polls.status, "entwurf")
        )
      )
      .returning({
        id: polls.id,
        frage: polls.frage,
        regionId: polls.regionId,
      });

    if (updated.length === 0) {
      return { ok: false as const, error: "Umfrage nicht gefunden oder nicht im Entwurf." };
    }

    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: gehtInPruefung ? "poll.submitted_for_review" : "poll.activated",
      targetType: "poll",
      targetId: idParsed.data,
      metadata: { pollId: idParsed.data },
    });

    return { ok: true as const, poll: updated[0] };
  });

  if (!result.ok) return { ok: false, error: result.error };

  // Flag AN: die Umfrage wartet nun auf die Neutralitätsprüfung — sie ist noch NICHT
  // öffentlich, daher wird KEINE Benachrichtigung gefeuert (die zieht auf die echte
  // Aktivierung in pollPruefungAbschliessen um).
  if (gehtInPruefung) return { ok: true };

  // SIDE-EFFECT-FENCE (Demo-Spielwiese, fail-closed): auf dem Demo-Mandanten
  // wird notifyNewPoll KOMPLETT übersprungen — kein Mail-Versand nach außen,
  // wenn ein ephemerer Demo-Admin eine Frage aktiviert. Der Empfängerfilter in
  // notify.ts (schließt @demo.invalid + notifyNewPolls=false aus) ist nur
  // Defense-in-Depth, KEIN Tenant-Gate: ein einziges echtes Opt-in-Konto im
  // Demo-Tenant würde sonst bei jedem Demo-Spielzug E-Mail bekommen.
  if (isDemoTenant(ctx.tenant.slug)) {
    return { ok: true };
  }

  // BEST-EFFORT-Benachrichtigung NACH erfolgreicher Aktivierung, AUSSERHALB der
  // Transaktion. Ein Mail-/Empfänger-Fehler darf pollAktivieren NIEMALS auf
  // {ok:false} kippen — die Aktivierung bleibt erfolgreich. Audit PII-frei.
  await notifyPollBestEffort(ctx.db, ctx.tenant, result.poll, transport);

  return { ok: true };
}

/**
 * BEST-EFFORT-Benachrichtigung einer frisch aktivierten Umfrage, AUSSERHALB jeder
 * Transaktion. Ein Mail-/Empfänger-Fehler darf die Aktivierung/Freigabe NIEMALS auf
 * {ok:false} kippen (deshalb komplett gekapselt + PII-frei auditiert). Wird von
 * pollAktivieren (Flag AUS) UND pollPruefungAbschliessen (Freigabe neutral) genutzt,
 * damit der Aktivierungs-Nebeneffekt an genau EINER Stelle lebt.
 */
async function notifyPollBestEffort(
  db: Db,
  tenant: TenantRow,
  poll: NotifyPoll,
  transport: NotifyTransport
): Promise<void> {
  try {
    const headerStore = await headers();
    const host = headerStore.get("host") ?? `${tenant.slug}.localhost`;
    const { sent, errors } = await notifyNewPoll({ db, tenant, poll, host, transport });
    await db.insert(auditEvents).values({
      tenantId: tenant.id,
      actorType: "system",
      actorRef: null,
      action: "poll.notifications",
      targetType: "poll",
      targetId: poll.id,
      metadata: { pollId: poll.id, sent, errors },
    });
  } catch {
    // Benachrichtigung gescheitert — der Übergang bleibt trotzdem erfolgreich.
    // PII-frei: nur pollId, keine Adressen.
    try {
      await db.insert(auditEvents).values({
        tenantId: tenant.id,
        actorType: "system",
        actorRef: null,
        action: "poll.notify_error",
        targetType: "poll",
        targetId: poll.id,
        metadata: { pollId: poll.id },
      });
    } catch {
      // Selbst das Audit darf den erfolgreichen Übergang nicht kippen.
    }
  }
}

/**
 * pollSchliessen — eine aktive Umfrage beenden (aktiv → geschlossen).
 *
 * ATOMARER Status-Guard: der Übergang steckt direkt im WHERE
 * (status='aktiv'). 0 betroffene Zeilen ⇒ die Umfrage gibt es nicht,
 * gehört nicht zum Tenant oder ist nicht (mehr) aktiv → freundlicher Fehler.
 * Geschlossene Umfragen bleiben als Vorgang erhalten (kein Löschen).
 */
export async function pollSchliessen(
  pollId: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(pollId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Umfrage-ID." };

  // Seed-Schutz (Demo-Spielwiese): die kuratierte AKTIVE Beispiel-Frage ist der
  // Abstimm-Moment des Bürger-Rundgangs — würde ein Demo-Admin sie schließen,
  // wäre der Rundgang für ALLE Besucher bis zum nächtlichen Reset kaputt.
  if (isDemoTenant(ctx.tenant.slug) && istMusterstadtSeedPollId(ctx.tenant.slug, idParsed.data)) {
    return { ok: false, error: "Diese Beispiel-Frage gehört zum Demo-Rundgang und bleibt unverändert." };
  }

  // GEBIETS-AUTORITÄT (Block H, symmetrisch): ein gebietsgebundener Admin darf eine
  // Poll außerhalb seines Gebiets nicht schließen. Prüfung gegen poll.region_id VOR
  // dem Status-UPDATE (super_admin bypass; fremder/fehlender Poll → Standard-Guard).
  const scopes = await getUserRolesMitScope(ctx.db, ctx.tenant.id, ctx.userId);
  if (!(await pollVerwaltungErlaubt(ctx.db, ctx.tenant.id, idParsed.data, scopes, istSuperAdminScope(scopes)))) {
    return { ok: false, error: "Für dieses Gebiet sind Sie nicht berechtigt." };
  }

  const result = await ctx.db.transaction(async (tx: Db) => {
    // ATOMARER Guard: nur aus 'aktiv' nach 'geschlossen', tenant-scoped.
    const updated = await tx
      .update(polls)
      .set({ status: "geschlossen", closesAt: sql`COALESCE(${polls.closesAt}, now())` })
      .where(
        and(
          eq(polls.id, idParsed.data),
          eq(polls.tenantId, ctx.tenant.id),
          eq(polls.status, "aktiv")
        )
      )
      .returning({ id: polls.id });

    if (updated.length === 0) {
      return { ok: false as const, error: "Umfrage nicht gefunden oder nicht aktiv." };
    }

    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "poll.closed",
      targetType: "poll",
      targetId: idParsed.data,
      metadata: { pollId: idParsed.data },
    });

    return { ok: true as const };
  });

  return result;
}

/**
 * pollEntwurfLoeschen — einen noch nicht veröffentlichten Entwurf löschen.
 *
 * Löscht NUR im Status 'entwurf' (atomar im WHERE, tenant-scoped). Aktive und
 * geschlossene Umfragen sind NICHT löschbar — der Vorgang bleibt erhalten.
 * Sicherheitsnetz: zusätzlich nur, wenn keine Stimmen existieren (bei einem
 * Entwurf ohnehin 0, aber wir prüfen es hart, bevor wir etwas löschen).
 */
export async function pollEntwurfLoeschen(
  pollId: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(pollId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Umfrage-ID." };

  // Seed-Schutz (Demo-Spielwiese): kuratierte Beispiel-Fragen nie löschbar
  // (defensiv — sie sind aktiv/geschlossen, der Entwurf-Guard griffe schon).
  if (isDemoTenant(ctx.tenant.slug) && istMusterstadtSeedPollId(ctx.tenant.slug, idParsed.data)) {
    return { ok: false, error: "Diese Beispiel-Frage gehört zum Demo-Rundgang und bleibt unverändert." };
  }

  // GEBIETS-AUTORITÄT (Block H, symmetrisch): ein gebietsgebundener Admin darf einen
  // Entwurf außerhalb seines Gebiets nicht löschen. Prüfung gegen poll.region_id VOR
  // dem DELETE (super_admin bypass; fremder/fehlender Poll → Standard-Guard).
  const scopes = await getUserRolesMitScope(ctx.db, ctx.tenant.id, ctx.userId);
  if (!(await pollVerwaltungErlaubt(ctx.db, ctx.tenant.id, idParsed.data, scopes, istSuperAdminScope(scopes)))) {
    return { ok: false, error: "Für dieses Gebiet sind Sie nicht berechtigt." };
  }

  const result = await ctx.db.transaction(async (tx: Db) => {
    // Sicherheitsnetz: bei vorhandenen Stimmen NIEMALS löschen (sollte bei
    // einem Entwurf 0 sein — aber wir verlassen uns nicht darauf). Deckt ALLE
    // Abstimm-Formate ab: Ja/Nein (votes), Dot (vote_allocations), Widerstand
    // (vote_resistances) — die Format-Actions schreiben keine votes-Zeile.
    const [stimmen, zuteilungen, widerstaende] = await Promise.all([
      tx
        .select({ id: votes.id })
        .from(votes)
        .where(and(eq(votes.pollId, idParsed.data), eq(votes.tenantId, ctx.tenant.id)))
        .limit(1),
      tx
        .select({ id: voteAllocations.id })
        .from(voteAllocations)
        .where(and(eq(voteAllocations.pollId, idParsed.data), eq(voteAllocations.tenantId, ctx.tenant.id)))
        .limit(1),
      tx
        .select({ id: voteResistances.id })
        .from(voteResistances)
        .where(and(eq(voteResistances.pollId, idParsed.data), eq(voteResistances.tenantId, ctx.tenant.id)))
        .limit(1),
    ]);
    if (stimmen.length > 0 || zuteilungen.length > 0 || widerstaende.length > 0) {
      return { ok: false as const, error: "Diese Umfrage hat bereits Stimmen und kann nicht gelöscht werden." };
    }

    // ATOMARER Guard: nur 'entwurf', tenant-scoped. RETURNING bestätigt den Treffer.
    const deleted = await tx
      .delete(polls)
      .where(
        and(
          eq(polls.id, idParsed.data),
          eq(polls.tenantId, ctx.tenant.id),
          eq(polls.status, "entwurf")
        )
      )
      .returning({ id: polls.id });

    if (deleted.length === 0) {
      return { ok: false as const, error: "Nur Entwürfe können gelöscht werden." };
    }

    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "poll.deleted",
      targetType: "poll",
      targetId: idParsed.data,
      metadata: { pollId: idParsed.data },
    });

    return { ok: true as const };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Block L (ADR-028): KI-Neutralitäts-Check — Prüfung abschließen.
// ---------------------------------------------------------------------------

const pollPruefungSchema = z.object({
  pollId: z.string().uuid("Ungültige Umfrage-ID."),
  verdict: z.enum(["neutral", "angehalten"]),
  begruendung: z
    .string()
    .trim()
    .min(1, "Bitte geben Sie eine kurze Begründung an.")
    .max(400, "Die Begründung ist zu lang (max. 400 Zeichen)."),
  // Pflicht nur bei 'angehalten' (unten geprüft); ≤160 Zeichen.
  verletzteRegel: z.string().trim().max(160, "Die verletzte Regel ist zu lang.").optional().nullable(),
  istOverride: z.boolean().optional(),
});

/**
 * pollPruefungAbschliessen — der Betreiber schließt die assisted Neutralitätsprüfung
 * einer `in_pruefung`-Umfrage ab: `neutral` gibt frei (→ aktiv + Benachrichtigung),
 * `angehalten` schickt sie mit Begründung zurück an den Ersteller (→ entwurf).
 *
 * Alle Gates serverseitig: Admin (requireAdminCtx) + Gebiets-Autorität (Block H) +
 * zod-Validierung + Demo-Fence + SoD bei Freigabe (im Kern, atomar). Die
 * best-effort-Benachrichtigung läuft — wie bei pollAktivieren — AUSSERHALB der
 * Transaktion und kippt das Ergebnis nie.
 */
export async function pollPruefungAbschliessen(
  raw: {
    pollId: string;
    verdict: Verdict;
    begruendung: string;
    verletzteRegel?: string | null;
    istOverride?: boolean;
  },
  transport: NotifyTransport = createDefaultTransport()
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const parsed = pollPruefungSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  const { pollId, verdict, begruendung, istOverride } = parsed.data;
  const verletzteRegel = parsed.data.verletzteRegel ?? null;

  // Beim Anhalten ist die konkret verletzte Regel Pflicht (nachvollziehbares Log).
  if (verdict === "angehalten" && verletzteRegel === null) {
    return { ok: false, error: "Bitte benennen Sie die verletzte Regel." };
  }

  // Demo-Fence (fail-closed): auf dem Demo-Mandanten ist der Neutralitäts-Check nicht
  // aktiv (Flag AUS) — eine Prüf-Aktion darf dort keine Außenwirkung entfalten.
  if (isDemoTenant(ctx.tenant.slug)) {
    return { ok: false, error: "In der Demo ist die Neutralitätsprüfung nicht aktiv." };
  }

  // GEBIETS-AUTORITÄT (Block H, symmetrisch): ein gebietsgebundener Admin darf eine
  // Poll außerhalb seines Gebiets nicht freigeben/anhalten (super_admin bypass;
  // fremder/fehlender Poll → Standard-Guard im Kern).
  const scopes = await getUserRolesMitScope(ctx.db, ctx.tenant.id, ctx.userId);
  if (!(await pollVerwaltungErlaubt(ctx.db, ctx.tenant.id, pollId, scopes, istSuperAdminScope(scopes)))) {
    return { ok: false, error: "Für dieses Gebiet sind Sie nicht berechtigt." };
  }

  const result = await pruefungAbschliessenCore(ctx.db, ctx.tenant.id, {
    pollId,
    verdict,
    begruendung,
    verletzteRegel,
    istOverride: istOverride ?? false,
    callerUserId: ctx.userId,
    // SoD-Überbrückung nur über die exakte Env (Pilot-Ein-Personen-Betrieb).
    allowSelfApproval: isSelfApprovalAllowed(process.env),
  });

  if (!result.ok) return { ok: false, error: result.error };

  // Freigabe (neutral) → die Umfrage ist jetzt echt aktiv: Benachrichtigung
  // best-effort außerhalb der Tx (der Aktivierungs-Nebeneffekt zieht hierher um).
  if (result.notify) {
    await notifyPollBestEffort(ctx.db, ctx.tenant, result.notify, transport);
  }

  return { ok: true };
}
