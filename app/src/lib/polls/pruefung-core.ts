/**
 * pruefung-core.ts — Kern-Logik des KI-Neutralitäts-Checks (Block L, ADR-028).
 *
 * BEWUSST OHNE "use server" (Muster: freigabe-core.ts, composer-autoritaet.ts):
 * rein testbare Funktionen, die db/tenantId/Eingaben als PARAMETER nehmen. Der dünne
 * Wrapper `pollPruefungAbschliessen` in polls/actions.ts löst Auth/Tenant/Rollen auf,
 * validiert per zod und fährt danach die best-effort-Benachrichtigung AUSSERHALB der
 * Transaktion (bei Freigabe). Hier steckt der sicherheitskritische Kern:
 *
 *   - ATOMARE CAS-Übergänge (kein TOCTOU): der Statuswechsel steckt im WHERE
 *     desselben UPDATEs (`status='in_pruefung' RETURNING`).
 *   - SoD bei FREIGABE (neutral → aktiv): Prüfer ≠ Ersteller, außer die
 *     Pilot-Überbrückung `ALLOW_SELF_APPROVAL` ist aktiv (Muster isSelfApprovalAllowed).
 *     Der SoD-Guard ist als atomare Bedingung im UPDATE hinterlegt (Backstop), nicht
 *     nur als Vorprüfung. istOverride ist ein AUDITIERTER Marker (wiederholte
 *     Einreichung), hebt die SoD NICHT auf.
 *   - ANHALTEN (angehalten → entwurf): konservativ, kein SoD (jeder Admin darf
 *     anhalten). Die Umfrage wird wieder editierbar/erneut einreichbar.
 *   - Jede Prüfung schreibt eine Zeile in `ki_pruefungen` (öffentliches Transparenz-
 *     Log, PII-frei außer intern geprueft_von) + ein PII-freies Audit-Event.
 *
 * Die KI lehnt NIE final ab — sie hält an; der Mensch bleibt letzte Instanz.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { polls, kiPruefungen, auditEvents } from "@/db/schema";
import { PROMPT_VERSION, PROMPT_MODELL } from "@/lib/ki/neutralitaet-prompt";
import type { NotifyPoll } from "@/lib/polls/notify";

/** Ist der KI-Neutralitäts-Check für diesen Tenant aktiv? Eine Quelle. */
export function kiPruefungAktiv(tenantRow: { kiNeutralitaetsPflicht: boolean }): boolean {
  return tenantRow.kiNeutralitaetsPflicht === true;
}

export type Verdict = "neutral" | "angehalten";

export interface PruefungInput {
  pollId: string;
  verdict: Verdict;
  /** Kurzbegründung (max. 2 Sätze) — Länge wird vom Aufrufer (zod) begrenzt. */
  begruendung: string;
  /** Nur bei 'angehalten' relevant; sonst ignoriert/null. */
  verletzteRegel: string | null;
  /** Menschlicher Override (wiederholte Einreichung) — auditierter Marker. */
  istOverride: boolean;
  /** UserId des prüfenden Betreibers (Audit-actorRef, SoD-Vergleich, geprueft_von). */
  callerUserId: string;
  /**
   * true NUR über isSelfApprovalAllowed() (ALLOW_SELF_APPROVAL=true). Hebt bei der
   * FREIGABE die Prüfer≠Ersteller-Sperre auf (Pilot-Ein-Personen-Betrieb).
   */
  allowSelfApproval: boolean;
}

export type PruefungResult =
  | { ok: true; verdict: Verdict; notify: NotifyPoll | null }
  | { ok: false; error: string };

const SOD_FEHLER =
  "Vier-Augen-Prinzip: Die Freigabe muss durch eine andere Person erfolgen als " +
  "die, die diese Umfrage erstellt hat.";

/**
 * Schließt die Neutralitätsprüfung einer Umfrage ab. Erwartet, dass der Aufrufer
 * Auth/Rolle/Gebiets-Autorität + zod-Validierung BEREITS erzwungen hat.
 *
 * neutral    → Poll `in_pruefung` → `aktiv` (opens_at = COALESCE(opens_at, now())),
 *              Log-Zeile, Audit `poll.review_passed`. notify wird ZURÜCKGEGEBEN,
 *              damit der Wrapper die Benachrichtigung best-effort außerhalb der Tx fährt.
 * angehalten → Poll `in_pruefung` → `entwurf`, Log-Zeile mit verletzter Regel,
 *              Audit `poll.review_held`. KEIN notify (notify = null).
 */
export async function pruefungAbschliessenCore(
  db: Db,
  tenantId: string,
  input: PruefungInput,
): Promise<PruefungResult> {
  const { pollId, verdict, begruendung, callerUserId, allowSelfApproval } = input;
  const verletzteRegel = verdict === "angehalten" ? input.verletzteRegel : null;
  const istOverride = input.istOverride === true;

  // Poll tenant-scoped laden (Anzeige-/Fehlerpfad + SoD-Vorprüfung; der atomare
  // Backstop steckt zusätzlich im UPDATE-WHERE unten).
  const pollRows = await db
    .select({
      id: polls.id,
      status: polls.status,
      erstelltVon: polls.erstelltVon,
    })
    .from(polls)
    .where(and(eq(polls.id, pollId), eq(polls.tenantId, tenantId)))
    .limit(1);

  const poll = pollRows[0];
  if (!poll) return { ok: false, error: "Umfrage nicht gefunden." };
  if (poll.status !== "in_pruefung") {
    return { ok: false, error: "Diese Umfrage ist nicht (mehr) in Prüfung." };
  }

  // SoD nur bei der FREIGABE: der Prüfer darf nicht der Ersteller sein — außer die
  // Pilot-Überbrückung ist aktiv. erstelltVon=null (Ersteller gelöscht) ⇒ kein
  // Selbstfreigabe-Konflikt. istOverride hebt die SoD NICHT auf (nur Audit-Marker).
  const selbstFreigabe = verdict === "neutral" && poll.erstelltVon === callerUserId;
  if (selbstFreigabe && !allowSelfApproval) {
    return { ok: false, error: SOD_FEHLER };
  }

  return db.transaction(async (tx: Db) => {
    if (verdict === "neutral") {
      // Atomarer CAS in_pruefung → aktiv. SoD-Backstop im WHERE: erstelltVon
      // IS DISTINCT FROM caller (deckt erstelltVon=null mit), außer Überbrückung.
      const sodGuard = allowSelfApproval
        ? undefined
        : sql`${polls.erstelltVon} IS DISTINCT FROM ${callerUserId}`;

      const updated = await tx
        .update(polls)
        .set({ status: "aktiv", opensAt: sql`COALESCE(${polls.opensAt}, now())` })
        .where(
          and(
            eq(polls.id, pollId),
            eq(polls.tenantId, tenantId),
            eq(polls.status, "in_pruefung"),
            sodGuard,
          ),
        )
        .returning({ id: polls.id, frage: polls.frage, regionId: polls.regionId });

      if (updated.length === 0) {
        // Übergang scheiterte: entweder Status verändert (Concurrency) oder SoD-Backstop.
        return selbstFreigabe && !allowSelfApproval
          ? { ok: false as const, error: SOD_FEHLER }
          : { ok: false as const, error: "Diese Umfrage ist nicht (mehr) in Prüfung." };
      }

      await tx.insert(kiPruefungen).values({
        tenantId,
        pollId,
        verdict: "neutral",
        begruendung,
        verletzteRegel: null,
        promptVersion: PROMPT_VERSION,
        modell: PROMPT_MODELL,
        geprueftVon: callerUserId,
        istOverride,
      });

      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "admin",
        actorRef: callerUserId,
        action: "poll.review_passed",
        targetType: "poll",
        targetId: pollId,
        // PII-frei: nur Marker, keine Frage/Adresse. selfApproval nur wenn genutzt.
        metadata: {
          pollId,
          istOverride,
          ...(allowSelfApproval && selbstFreigabe ? { selfApproval: true } : {}),
        },
      });

      return {
        ok: true as const,
        verdict: "neutral" as const,
        notify: { id: updated[0].id, frage: updated[0].frage, regionId: updated[0].regionId },
      };
    }

    // verdict === 'angehalten': zurück auf entwurf (konservativ, kein SoD).
    const updated = await tx
      .update(polls)
      .set({ status: "entwurf" })
      .where(
        and(
          eq(polls.id, pollId),
          eq(polls.tenantId, tenantId),
          eq(polls.status, "in_pruefung"),
        ),
      )
      .returning({ id: polls.id });

    if (updated.length === 0) {
      return { ok: false as const, error: "Diese Umfrage ist nicht (mehr) in Prüfung." };
    }

    await tx.insert(kiPruefungen).values({
      tenantId,
      pollId,
      verdict: "angehalten",
      begruendung,
      verletzteRegel,
      promptVersion: PROMPT_VERSION,
      modell: PROMPT_MODELL,
      geprueftVon: callerUserId,
      istOverride,
    });

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "poll.review_held",
      targetType: "poll",
      targetId: pollId,
      metadata: { pollId, istOverride },
    });

    return { ok: true as const, verdict: "angehalten" as const, notify: null };
  });
}
