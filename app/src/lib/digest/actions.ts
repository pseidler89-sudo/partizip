/**
 * actions.ts — Server Actions für Digest-Freigabe-Gate (M7)
 *
 * Gate-B-Pflicht: Server Actions sind eigenständige Endpoints!
 * Jede Action prüft: Auth + Rolle + Tenant-Isolierung + Status-Validierung.
 *
 * Freigabe-Gate (Konzept Kap. 10, nicht verhandelbar):
 *   - Freigeben: nur kommune_admin oder super_admin
 *   - Vier-Augen-Sperre (SoD): Wer Aussagen selbst geprüft hat, darf den
 *     Digest NICHT freigeben — atomar erzwungen in freigabe-core.ts;
 *     Pilot-Überbrückung nur per ALLOW_SELF_APPROVAL=true (fail-closed,
 *     im Audit als selfApproval markiert)
 *   - Veröffentlichen: nur aus Status 'freigegeben'
 *   - KEIN Pfad entwurf → veroeffentlicht ohne approved_at
 *   - DB-CHECK als letzte Verteidigungslinie (Migration 0006)
 *
 * M2: TOCTOU-Guard: UPDATE WHERE id+tenant+status=<expected>; rowCount prüfen.
 * H4: Status-UPDATE + Audit-Insert in gemeinsamer Transaktion.
 * N1: approved_content_hash bei Freigabe; Vergleich bei Veröffentlichung.
 * M3: digest_statements laden und an die Kanal-Schicht übergeben (ADR-021).
 *
 * Jede Statusänderung → audit_event (PII-frei, actor_ref = User-UUID).
 */

"use server";

import { eq, and, isNull, sql } from "drizzle-orm";
import { type Db } from "@/db/client";
import { digests, digestStatements, auditEvents } from "@/db/schema";
import { isDemoTenant } from "@/lib/demo/config";
import { istMusterstadtSeedDigestId } from "@/lib/demo/seed-ids";
import { freigebenCore, isSelfApprovalAllowed } from "@/lib/digest/freigabe-core";
import { veroeffentlichenCore } from "@/lib/digest/veroeffentlichen-core";
import {
  requireAdminStepUpCtx,
  requireRedaktionCtx,
  type ZweiFaktorBedarf,
} from "@/lib/auth/action-context";

/**
 * Ergebnis der Redaktions-Actions.
 *
 * `zweiFaktor` (#59) sagt der UI, dass nicht die Berechtigung fehlt, sondern der
 * zweite Faktor — und WELCHER Weg hilft ("code" = bestätigen, "einrichten" =
 * einrichten). Das Feld kommt unverändert aus den Gates in
 * lib/auth/action-context.ts; hier wird es nur DURCHGEREICHT statt verworfen.
 * Ohne die Weitergabe sieht ein Admin, dessen Step-up nach 15 Minuten abläuft,
 * nur „frische Bestätigung erforderlich" — ohne Link, ohne Knopf.
 *
 * Optional, damit bestehende Aufrufer (u. a. die Betreiber-CLI und die Tests
 * gegen die *Core-Funktionen) unverändert bleiben.
 */
export type DigestActionResult = {
  ok: boolean;
  error?: string;
  zweiFaktor?: ZweiFaktorBedarf;
};

// ---------------------------------------------------------------------------
// Auth — AUSSCHLIESSLICH über @/lib/auth/action-context
//
// KEIN EIGENER SESSION-RESOLVER (Gate-B 2026-08-06, BLOCKER): Diese Datei hatte
// eine eigene Kopie des Session-Lookups und kam damit an der Zwei-Faktor-Pflicht
// (#59) vorbei. Wächter:
// lib/auth/__tests__/kein-eigener-session-resolver.test.ts.
// ---------------------------------------------------------------------------


// N1: Content-Hash über alle Statements — liegt jetzt (mit der gesamten
// Freigabe-Kern-Logik) testbar in @/lib/digest/freigabe-core.

// ---------------------------------------------------------------------------
// Action: Aussage als quellen-geprüft markieren / Markierung aufheben
// ---------------------------------------------------------------------------

export async function setStatementGeprueft(
  statementId: string,
  geprueft: boolean,
): Promise<DigestActionResult> {
  // KEIN Step-up: Das Prüf-Häkchen ist der laufende Redaktionsschritt (Dutzende
  // pro Sitzung) und in beide Richtungen umkehrbar; nach außen geht nichts. Die
  // folgenreiche Stelle ist die Freigabe — dort sitzt das Step-up.
  //
  // Das Signal wird trotzdem durchgereicht: requireRedaktionCtx blockt einen
  // ADMIN, dessen Kulanzfrist mitten in der Sitzung abläuft ("einrichten"). Das
  // Layout-Gate unter /admin fängt das erst beim nächsten Rendern ab — der Klick
  // hier passiert vorher.
  const auth = await requireRedaktionCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  // Sicherheitsprüfung: Statement gehört zu einem Digest dieses Tenants und ist im Status 'entwurf'
  // Join: digestStatements → digests → Tenant-Bindung
  const rows = await ctx.db
    .select({ digestId: digests.id, digestStatus: digests.status })
    .from(digestStatements)
    .innerJoin(digests, eq(digestStatements.digestId, digests.id))
    .where(
      and(
        eq(digestStatements.id, statementId),
        eq(digests.tenantId, ctx.tenant.id),
      )
    )
    .limit(1);

  if (rows.length === 0) return { ok: false, error: "Aussage nicht gefunden." };
  if (rows[0].digestStatus !== "entwurf") return { ok: false, error: "Prüf-Markierung nur im Status 'entwurf' möglich." };

  await ctx.db
    .update(digestStatements)
    .set({
      geprueftAt: geprueft ? new Date() : null,
      // H1 Vier-Augen: festhalten, WER geprüft hat (beim Aufheben zurücksetzen)
      geprueftBy: geprueft ? ctx.userId : null,
    })
    .where(eq(digestStatements.id, statementId));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Action: Alle Aussagen eines Digests als geprüft markieren
// ---------------------------------------------------------------------------

export async function setAlleStatementsGeprueft(
  digestId: string,
): Promise<DigestActionResult> {
  // KEIN Step-up: Sammel-Variante von setStatementGeprueft — dieselbe Wirkung in
  // einem Zug, dieselbe Umkehrbarkeit, keine Außenwirkung. Zwei-Faktor-Signal
  // wie dort durchgereicht.
  const auth = await requireRedaktionCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  // Digest-Prüfung: existiert und gehört zu diesem Tenant, Status muss 'entwurf' sein
  const digestRows = await ctx.db
    .select({ id: digests.id, status: digests.status })
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };
  if (digestRows[0].status !== "entwurf") return { ok: false, error: "Prüf-Markierung nur im Status 'entwurf' möglich." };

  const now = new Date();

  await ctx.db.transaction(async (tx: Db) => {
    // Audit m7: NUR noch ungeprüfte Aussagen stempeln (geprueft_at IS NULL). Sonst
    // überschriebe „Alle als geprüft" die Prüf-Spur (geprueft_by) eines früheren
    // Prüfers und löschte dessen Vier-Augen-/SoD-Mitwirkung restlos. RETURNING →
    // exakte Anzahl der TATSÄCHLICH neu markierten Aussagen fürs Audit.
    const neu = await tx
      .update(digestStatements)
      .set({ geprueftAt: now, geprueftBy: ctx.userId })
      .where(
        and(
          eq(digestStatements.digestId, digestId),
          isNull(digestStatements.geprueftAt),
        ),
      )
      .returning({ id: digestStatements.id });
    const anzahl = neu.length;

    // Audit-Event: PII-frei, Muster der bestehenden Events
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "digest.statements_geprueft",
      targetType: "digest",
      targetId: digestId,
      metadata: { digestId, anzahl },
    });
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Action: Aussage als Highlight markieren / Markierung aufheben
// ---------------------------------------------------------------------------

export async function setStatementHighlight(
  statementId: string,
  istHighlight: boolean,
): Promise<DigestActionResult> {
  // KEIN Step-up: redaktionelle Gewichtung im Entwurf, nach außen wird nichts
  // sichtbar (der Digest ist noch nicht veröffentlicht). Die SoD-Spur
  // (highlighted_by) trägt die Verantwortung, nicht ein zweiter Faktor.
  // Zwei-Faktor-Signal wie bei setStatementGeprueft durchgereicht.
  const auth = await requireRedaktionCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  // Sicherheitsprüfung: Statement gehört zu einem Digest dieses Tenants und ist im Status 'entwurf'
  const rows = await ctx.db
    .select({ digestId: digests.id, digestStatus: digests.status })
    .from(digestStatements)
    .innerJoin(digests, eq(digestStatements.digestId, digests.id))
    .where(
      and(
        eq(digestStatements.id, statementId),
        eq(digests.tenantId, ctx.tenant.id),
      )
    )
    .limit(1);

  if (rows.length === 0) return { ok: false, error: "Aussage nicht gefunden." };
  if (rows[0].digestStatus !== "entwurf") return { ok: false, error: "Highlight-Markierung nur im Status 'entwurf' möglich." };

  // Seed-Schutz (Demo-Spielwiese): der kuratierte Beispiel-Digest bleibt
  // unverändert — defensiv (er ist veröffentlicht, der Status-Guard griffe schon).
  if (isDemoTenant(ctx.tenant.slug) && istMusterstadtSeedDigestId(ctx.tenant.slug, rows[0].digestId)) {
    return { ok: false, error: "Dieser Beispiel-Digest gehört zum Demo-Rundgang und bleibt unverändert." };
  }

  // SoD-Spur (Separation of Duties): beim SETZEN eines Highlights halten wir fest,
  // WER es gesetzt hat — redaktionelle Gewichtung zählt als Mitgestaltung, und die
  // Selbstfreigabe-Sperre in freigebenCore konsultiert diese Spur.
  // ABSICHTLICH persistent UND nicht überschreibbar:
  //   - istHighlight=false setzt highlightedBy NICHT zurück (Mitwirkungs-Spur
  //     bleibt), sonst ließe sich die Sperre durch Setzen+Entfernen umgehen.
  //   - Ein ZWEITER Setzer überschreibt eine bereits vorhandene Spur NICHT
  //     (COALESCE: nur schreiben, wenn aktuell NULL) — sonst würde die Spur des
  //     ERSTEN Highlighters verloren gehen und dieser könnte doch selbst
  //     freigeben. Der erste Highlighter bleibt die verbindliche SoD-Spur.
  //   Bewusst anders als geprueftBy, das durch das Vollständigkeits-Gate ohnehin
  //   gebunden ist (fail-closed).
  await ctx.db
    .update(digestStatements)
    .set(
      istHighlight
        ? {
            istHighlight,
            highlightedBy: sql`coalesce(${digestStatements.highlightedBy}, ${ctx.userId}::uuid)`,
          }
        : { istHighlight },
    )
    .where(eq(digestStatements.id, statementId));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Action: Digest freigeben
// ---------------------------------------------------------------------------

export async function freigeben(digestId: string): Promise<DigestActionResult> {
  // STEP-UP (#59): Die Freigabe entscheidet, was als geprüfter Stand gilt, und ist
  // die Vorbedingung der Veröffentlichung — dafür verlangen wir eine frische
  // Bestätigung mit dem Einmalcode. Freigeben ist ohnehin admin-only
  // (canFreigeben), das Admin-Gate ändert an der Berechtigung nichts.
  //
  // Das `zweiFaktor`-Signal WEITERREICHEN, nicht verwerfen (Review #59, Befund 2):
  // Genau hier — nach 20 Minuten Redaktionsarbeit — läuft das Step-up ab, und
  // ohne das Feld bleibt der Nutzer mit einem Satz ohne Weg zurück.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  // Seed-Schutz (Demo-Spielwiese): der kuratierte Beispiel-Digest ist der
  // Anschauungs-Moment des Rundgangs und bleibt unverändert — rein defensiv
  // (er ist bereits veröffentlicht, der Status-Guard griffe ohnehin).
  if (isDemoTenant(ctx.tenant.slug) && istMusterstadtSeedDigestId(ctx.tenant.slug, digestId)) {
    return { ok: false, error: "Dieser Beispiel-Digest gehört zum Demo-Rundgang und bleibt unverändert." };
  }

  // Gesamte Kern-Logik (Rolle, Vollständigkeit, Vier-Augen-Sperre/SoD atomar im
  // Status-UPDATE, Audit) liegt testbar in freigabe-core.ts. Die Pilot-
  // Überbrückung kommt AUSSCHLIESSLICH aus der Env (fail-closed). Die Rollen
  // kommen aus dem Gate (ctx.roleTypes) — kein zweiter Lookup.
  return freigebenCore(ctx.db, ctx.tenant.id, {
    digestId,
    callerUserId: ctx.userId,
    callerRoleTypes: ctx.roleTypes,
    allowSelfApproval: isSelfApprovalAllowed(),
  });
}

// ---------------------------------------------------------------------------
// Action: Digest veröffentlichen
// ---------------------------------------------------------------------------

export async function veroeffentlichen(digestId: string): Promise<DigestActionResult> {
  // STEP-UP (#59): Die Veröffentlichung geht an Kanäle nach außen (Mastodon,
  // Bluesky, RSS) und ist nicht zurückholbar — dafür verlangen wir eine frische
  // Bestätigung mit dem Einmalcode. Admin-only wie freigeben (canFreigeben).
  // Signal durchreichen — siehe freigeben().
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  // Seed-Schutz (Demo-Spielwiese): analog freigeben() — der Beispiel-Digest
  // des Rundgangs bleibt für alle Besucher unverändert.
  if (isDemoTenant(ctx.tenant.slug) && istMusterstadtSeedDigestId(ctx.tenant.slug, digestId)) {
    return { ok: false, error: "Dieser Beispiel-Digest gehört zum Demo-Rundgang und bleibt unverändert." };
  }

  // Gesamte Veröffentlichungs-Logik (Rolle, approved_at/N1-Hash, atomarer CAS,
  // Demo-Side-Effect-Fence, best-effort Kanal-Versand) liegt testbar und
  // wiederverwendbar in veroeffentlichen-core.ts. Action UND Betreiber-CLI
  // (digest:publish) delegieren hierher — EIN Übergang, kein Copy-Paste.
  return veroeffentlichenCore(ctx.db, ctx.tenant.id, {
    digestId,
    callerUserId: ctx.userId,
    callerRoleTypes: ctx.roleTypes,
    tenantSlug: ctx.tenant.slug,
  });
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Digest mit Berechtigungsprüfung laden
// ---------------------------------------------------------------------------

export async function loadDigestForAdmin(digestId: string) {
  // REIN LESEND — kein Step-up. Gate trotzdem, weil die Antwort den Entwurf
  // enthält: gleiche Schwelle wie die übrigen Redaktions-Actions (inkl.
  // Zwei-Faktor-Pflicht für Admins).
  const auth = await requireRedaktionCtx();
  if (!auth.ok) return null;
  const { ctx } = auth;

  const digestRows = await ctx.db
    .select()
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
    .limit(1);

  return digestRows[0] ?? null;
}

