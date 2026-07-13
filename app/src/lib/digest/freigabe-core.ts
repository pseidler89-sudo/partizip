/**
 * freigabe-core.ts — Kern-Logik der Digest-Freigabe (Separation of Duties).
 *
 * KEIN "use server": direkt unit-/integration-testbar (Muster aus
 * admin/role-actions.ts, verification/qr-core.ts). Der dünne Wrapper
 * `freigeben` in digest/actions.ts löst den Auth-Kontext auf und ruft hierher.
 *
 * VIER-AUGEN-PRINZIP, serverseitig HART (Rollen-Governance):
 *   - Wer einen Digest redaktionell bearbeitet hat, darf ihn NICHT freigeben.
 *     Belastbare Spur: `digest_statements.geprueft_by` — die Prüf-Aktionen
 *     (setStatementGeprueft / setAlleStatementsGeprueft) halten fest, WER
 *     eine Aussage quellen-geprüft hat. Da die Freigabe ohnehin verlangt,
 *     dass JEDE Aussage geprüft ist, ist geprueft_by die vollständige
 *     Bearbeitungs-Spur des freigabe-relevanten Inhalts.
 *   - ATOMAR (kein TOCTOU): Die Sperre steht als NOT-EXISTS-Bedingung in der
 *     WHERE-Klausel DESSELBEN UPDATEs, das den Statusübergang macht
 *     (bestehendes Muster „UPDATE ... WHERE status='entwurf' ... RETURNING").
 *     Prüfung + Übergang + Audit laufen in EINER Transaktion.
 *   - FAIL-CLOSED: Nur ALLOW_SELF_APPROVAL=true (exakt) hebt die Sperre auf —
 *     fehlende/leere/ungültige Env ⇒ Sperre aktiv. Wird überbrückt UND hat
 *     die freigebende Person selbst bearbeitet, steht das im Audit-Event
 *     (metadata.selfApproval = true) — nachvollziehbar, nie unsichtbar.
 *   - Der Tenant-Schalter `tenants.vier_augen_pflicht` (H1) bleibt als
 *     ZUSÄTZLICHE, strengere Stufe bestehen (verlangt außerdem einen
 *     erfassten Prüfer je Aussage) und ist per Env NICHT überbrückbar.
 */

import { and, eq, isNull, or, notExists } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@/db/client";
import { digests, digestStatements, tenants, auditEvents } from "@/db/schema";
import { canFreigeben } from "@/lib/auth/roles";

/**
 * Pilot-Überbrückung (Ein-Personen-Betrieb): NUR der exakte Wert "true"
 * (case-insensitiv, getrimmt) hebt die Selbstfreigabe-Sperre auf.
 * Alles andere — fehlend, leer, "1", "yes", Tippfehler — ⇒ Sperre aktiv
 * (fail-closed). Reine Funktion, Env injizierbar für Tests.
 */
export function isSelfApprovalAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.ALLOW_SELF_APPROVAL ?? "").trim().toLowerCase() === "true";
}

/**
 * Hat dieser User den Digest redaktionell bearbeitet (mindestens eine Aussage
 * quellen-geprüft)? Tenant-scoped über den Digest-Join. Für die UI-Anzeige
 * („Freigabe durch eine zweite Person") — die Sperre selbst wirkt atomar im
 * UPDATE von freigebenCore, nie nur hier.
 */
export async function hatDigestRedigiert(
  db: Db,
  tenantId: string,
  digestId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: digestStatements.id })
    .from(digestStatements)
    .innerJoin(digests, eq(digestStatements.digestId, digests.id))
    .where(
      and(
        eq(digests.id, digestId),
        eq(digests.tenantId, tenantId),
        eq(digestStatements.geprueftBy, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * N1: sha256-Hash über alle Statements eines Digests.
 * Deterministisch serialisiert: position|text|source_url, sortiert nach position.
 */
export function computeStatementsHash(
  stmts: Array<{ position: number; text: string; sourceUrl: string }>,
): string {
  const sorted = [...stmts].sort((a, b) => a.position - b.position);
  const canonical = sorted.map((s) => `${s.position}|${s.text}|${s.sourceUrl}`).join("\n");
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

export interface FreigabeInput {
  digestId: string;
  /** UserId der freigebenden Person (Audit-actorRef, SoD-Vergleich). */
  callerUserId: string;
  /** Rollen des Callers — canFreigeben wird HIER erneut erzwungen. */
  callerRoleTypes: string[];
  /**
   * true NUR über isSelfApprovalAllowed() (ALLOW_SELF_APPROVAL=true).
   * Default false = Vier-Augen-Sperre erzwungen (fail-closed).
   */
  allowSelfApproval?: boolean;
}

export type FreigabeResult = { ok: boolean; error?: string };

const SOD_FEHLER =
  "Vier-Augen-Prinzip: Sie haben Aussagen dieses Digests selbst quellen-geprüft. " +
  "Die Freigabe muss durch eine zweite Person erfolgen.";

/**
 * Digest freigeben: entwurf → freigegeben. Enthält ALLE serverseitigen Gates:
 * Rolle, Tenant-Isolation, Vollständigkeits-Prüfung, Vier-Augen-Sperre (SoD),
 * Tenant-Vier-Augen-Pflicht (H1) — atomar im Status-UPDATE, Audit in derselben
 * Transaktion.
 */
export async function freigebenCore(
  db: Db,
  tenantId: string,
  input: FreigabeInput,
): Promise<FreigabeResult> {
  const { digestId, callerUserId, callerRoleTypes } = input;
  const allowSelfApproval = input.allowSelfApproval ?? false;

  if (!canFreigeben(callerRoleTypes)) {
    return {
      ok: false,
      error:
        "Freigabe nur durch kommune_admin/super_admin. Redakteure dürfen Aussagen prüfen, aber nicht freigeben (Vier-Augen-Prinzip).",
    };
  }

  // Digest tenant-scoped laden (Anzeige-/Fehlerpfad; sicherheitskritisch ist das atomare UPDATE unten).
  const digestRows = await db
    .select({ id: digests.id, status: digests.status })
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenantId)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };

  const stmts = await db
    .select({
      position: digestStatements.position,
      text: digestStatements.text,
      sourceUrl: digestStatements.sourceUrl,
      geprueftAt: digestStatements.geprueftAt,
      geprueftBy: digestStatements.geprueftBy,
    })
    .from(digestStatements)
    .where(eq(digestStatements.digestId, digestId));

  // M1: Leerer Digest nicht freigebbar
  if (stmts.length === 0) {
    return { ok: false, error: "Ein Digest ohne Aussagen kann nicht freigegeben werden." };
  }

  // Anzeige-Zählung (nur für Fehlermeldung; sicherheitskritische Prüfung erfolgt atomar im UPDATE)
  const gesamtAnzahl = stmts.length;
  const geprueftAnzahl = stmts.filter((s: { geprueftAt: Date | null }) => s.geprueftAt !== null).length;
  if (geprueftAnzahl < gesamtAnzahl) {
    return {
      ok: false,
      error: `Freigabe erst möglich, wenn alle Aussagen quellen-geprüft sind (${geprueftAnzahl} von ${gesamtAnzahl} geprüft).`,
    };
  }

  // SoD-Vorprüfung (freundliche Fehlermeldung; atomarer Backstop im UPDATE unten).
  const selbstGeprueft = stmts.some(
    (s: { geprueftBy: string | null }) => s.geprueftBy === callerUserId,
  );
  if (!allowSelfApproval && selbstGeprueft) {
    return { ok: false, error: SOD_FEHLER };
  }

  // H1 Vier-Augen-Toggle des Tenants: strengere Stufe (verlangt zusätzlich einen
  // ERFASSTEN anderen Prüfer je Aussage) — per Env bewusst NICHT überbrückbar.
  const tenantRow = await db
    .select({ vierAugen: tenants.vierAugenPflicht })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const vierAugenPflicht = tenantRow[0]?.vierAugen ?? false;

  if (vierAugenPflicht) {
    const selbstOderUngeprueft = stmts.some(
      (s: { geprueftBy: string | null }) =>
        s.geprueftBy === null || s.geprueftBy === callerUserId,
    );
    if (selbstOderUngeprueft) {
      return {
        ok: false,
        error:
          "Vier-Augen-Prinzip aktiv: Der Freigeber darf keine Aussage dieses Digests selbst geprüft haben — jede Aussage muss von einer anderen Person geprüft sein.",
      };
    }
  }

  const contentHash = computeStatementsHash(stmts);
  const now = new Date();

  // H4: Status-UPDATE + Audit in gemeinsamer Transaktion.
  // ALLE Gates stehen als Bedingungen in der WHERE-Klausel DESSELBEN UPDATEs —
  // Prüfung + Statusübergang sind damit atomar (kein TOCTOU-Fenster zwischen
  // Vorprüfung oben und Übergang hier).
  const result = await db.transaction(async (tx: Db) => {
    // Für das Audit: hat die freigebende Person selbst bearbeitet? (Innerhalb
    // der Transaktion erhoben, damit metadata.selfApproval zum Übergang passt.)
    const selfEditedRows = await tx
      .select({ id: digestStatements.id })
      .from(digestStatements)
      .where(
        and(
          eq(digestStatements.digestId, digestId),
          eq(digestStatements.geprueftBy, callerUserId),
        ),
      )
      .limit(1);
    const selfEdited = selfEditedRows.length > 0;

    // SoD-Sperre (Rollen-Governance): Das UPDATE schlägt fehl, wenn die
    // freigebende Person irgendeine Aussage selbst geprüft hat — außer die
    // Pilot-Überbrückung ist EXPLIZIT aktiv (Default: Sperre an, fail-closed).
    const sodGuard = allowSelfApproval
      ? undefined
      : notExists(
          tx
            .select({ id: digestStatements.id })
            .from(digestStatements)
            .where(
              and(
                eq(digestStatements.digestId, digestId),
                eq(digestStatements.geprueftBy, callerUserId),
              ),
            ),
        );

    // H1 Vier-Augen (Tenant-Toggle): atomarer Backstop — wenn aktiv, schlägt das
    // UPDATE fehl, falls irgendeine Aussage keinen (anderen) Prüfer hat.
    const vierAugenGuard = vierAugenPflicht
      ? notExists(
          tx
            .select({ id: digestStatements.id })
            .from(digestStatements)
            .where(
              and(
                eq(digestStatements.digestId, digestId),
                or(
                  isNull(digestStatements.geprueftBy),
                  eq(digestStatements.geprueftBy, callerUserId),
                ),
              ),
            ),
        )
      : undefined;

    const updated = await tx
      .update(digests)
      .set({
        status: "freigegeben",
        approvedBy: callerUserId,
        approvedAt: now,
        approvedContentHash: contentHash, // N1
      })
      .where(
        and(
          eq(digests.id, digestId),
          eq(digests.tenantId, tenantId),
          eq(digests.status, "entwurf"),
          // B1: atomares Gate — UPDATE schlägt fehl, wenn irgendein Statement ungeprüft ist
          notExists(
            tx
              .select({ id: digestStatements.id })
              .from(digestStatements)
              .where(
                and(
                  eq(digestStatements.digestId, digestId),
                  isNull(digestStatements.geprueftAt),
                ),
              ),
          ),
          // SoD: Selbstfreigabe-Sperre (undefined nur bei expliziter Überbrückung)
          sodGuard,
          // H1: atomarer Vier-Augen-Backstop (undefined wenn Toggle aus → von and() ignoriert)
          vierAugenGuard,
        ),
      )
      .returning({ id: digests.id });

    if (updated.length === 0) {
      // Ursache unterscheiden: Status, ungeprüfte Aussagen oder Vier-Augen-Sperre
      const current = await tx
        .select({ status: digests.status })
        .from(digests)
        .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenantId)))
        .limit(1);

      if (current.length === 0 || current[0].status !== "entwurf") {
        return {
          ok: false as const,
          error: "Ungültiger Statusübergang: Freigabe nur aus Status 'entwurf' möglich.",
        };
      }

      const ungeprueft = await tx
        .select({ id: digestStatements.id })
        .from(digestStatements)
        .where(
          and(eq(digestStatements.digestId, digestId), isNull(digestStatements.geprueftAt)),
        )
        .limit(1);
      if (ungeprueft.length > 0) {
        return {
          ok: false as const,
          error:
            "Freigabe abgelehnt: Es gibt noch ungeprüfte Aussagen (atomare Prüfung). Bitte alle Aussagen quellen-prüfen.",
        };
      }

      if (!allowSelfApproval && selfEdited) {
        return { ok: false as const, error: SOD_FEHLER };
      }

      // Übrig bleibt der Tenant-Vier-Augen-Backstop (z. B. Aussage ohne erfassten Prüfer).
      return {
        ok: false as const,
        error:
          "Vier-Augen-Prinzip aktiv: Der Freigeber darf keine Aussage dieses Digests selbst geprüft haben — jede Aussage muss von einer anderen Person geprüft sein.",
      };
    }

    // Audit (PII-frei: actor_ref = User-UUID, niemals E-Mail).
    // Überbrückte Selbstfreigabe wird EXPLIZIT sichtbar gemacht (selfApproval).
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "digest.approved",
      targetType: "digest",
      targetId: digestId,
      metadata: {
        digestId,
        contentHash,
        ...(allowSelfApproval && selfEdited ? { selfApproval: true } : {}),
      },
    });

    return { ok: true as const };
  });

  return result;
}
