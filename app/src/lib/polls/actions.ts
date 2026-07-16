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
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { insertBelegCode } from "@/lib/polls/beleg";
import { checkVoteRateLimit } from "@/lib/polls/rate-limit";
import { isValidChoice } from "@/lib/polls/ergebnis";
import { notifyNewPoll } from "@/lib/polls/notify";
import {
  createDefaultTransport,
  type NotifyTransport,
} from "@/lib/anliegen/notify";

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

  // ADR-024 contract: die Composer-Scope-Eingabe wird via Baum zu region_id
  // aufgelöst — der EINZIGE geschriebene Gebietsbezug (scope_level/scope_code sind
  // entfernt). Kein Gebiet hinterlegt → freundlicher Fehler statt DB-Exception.
  let regionId: string;
  try {
    regionId = await resolveRegionIdForScope(ctx.db, ctx.tenant.id, scopeLevel, scopeCode ?? null);
  } catch {
    return { ok: false, error: "Für die gewählte Ebene ist noch kein Gebiet hinterlegt." };
  }

  const pollId = await ctx.db.transaction(async (tx: Db) => {
    const [row] = await tx
      .insert(polls)
      .values({
        tenantId: ctx.tenant.id,
        regionId,
        frage,
        typ: "ja_nein_enthaltung",
        status: "entwurf",
        verbindlich: verbindlich ?? false,
        erstelltVon: ctx.userId,
        closesAt: closesAt ?? null,
      })
      .returning({ id: polls.id });

    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "poll.created",
      targetType: "poll",
      targetId: row.id,
      metadata: { pollId: row.id, verbindlich: verbindlich ?? false, scopeLevel },
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

  const result = await ctx.db.transaction(async (tx: Db) => {
    // TOCTOU-Guard: nur aus 'entwurf' nach 'aktiv', tenant-scoped.
    // Poll-Daten (frage/scope) werden für die spätere Benachrichtigung MITGEFÜHRT
    // (kein Zweit-Read außerhalb der Transaktion nötig).
    const updated = await tx
      .update(polls)
      .set({ status: "aktiv", opensAt: sql`COALESCE(${polls.opensAt}, now())` })
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
      action: "poll.activated",
      targetType: "poll",
      targetId: idParsed.data,
      metadata: { pollId: idParsed.data },
    });

    return { ok: true as const, poll: updated[0] };
  });

  if (!result.ok) return { ok: false, error: result.error };

  // BEST-EFFORT-Benachrichtigung NACH erfolgreicher Aktivierung, AUSSERHALB der
  // Transaktion. Ein Mail-/Empfänger-Fehler darf pollAktivieren NIEMALS auf
  // {ok:false} kippen — die Aktivierung bleibt erfolgreich. Audit PII-frei.
  try {
    const headerStore = await headers();
    const host = headerStore.get("host") ?? `${ctx.tenant.slug}.localhost`;
    const { sent, errors } = await notifyNewPoll({
      db: ctx.db,
      tenant: ctx.tenant,
      poll: result.poll,
      host,
      transport,
    });
    await ctx.db.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "system",
      actorRef: null,
      action: "poll.notifications",
      targetType: "poll",
      targetId: idParsed.data,
      metadata: { pollId: idParsed.data, sent, errors },
    });
  } catch {
    // Benachrichtigung gescheitert — Aktivierung bleibt trotzdem erfolgreich.
    // PII-frei: nur pollId, keine Adressen.
    try {
      await ctx.db.insert(auditEvents).values({
        tenantId: ctx.tenant.id,
        actorType: "system",
        actorRef: null,
        action: "poll.notify_error",
        targetType: "poll",
        targetId: idParsed.data,
        metadata: { pollId: idParsed.data },
      });
    } catch {
      // Selbst das Audit darf die erfolgreiche Aktivierung nicht kippen.
    }
  }

  return { ok: true };
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

  const result = await ctx.db.transaction(async (tx: Db) => {
    // Sicherheitsnetz: bei vorhandenen Stimmen NIEMALS löschen (sollte bei
    // einem Entwurf 0 sein — aber wir verlassen uns nicht darauf).
    const stimmen = await tx
      .select({ id: votes.id })
      .from(votes)
      .where(and(eq(votes.pollId, idParsed.data), eq(votes.tenantId, ctx.tenant.id)))
      .limit(1);
    if (stimmen.length > 0) {
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
