/**
 * actions.ts — Server Actions für Digest-Freigabe-Gate (M7)
 *
 * Gate-B-Pflicht: Server Actions sind eigenständige Endpoints!
 * Jede Action prüft: Auth + Rolle + Tenant-Isolierung + Status-Validierung.
 *
 * Freigabe-Gate (Konzept Kap. 10, nicht verhandelbar):
 *   - Freigeben: nur kommune_admin oder super_admin
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

import { cookies, headers } from "next/headers";
import { eq, and, count, notExists, isNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createDb, type Db } from "@/db/client";
import { digests, digestStatements, tenants, sessions, auditEvents } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { sendDigestToMastodon } from "@/lib/channels/mastodon";
import { sendDigestToBluesky } from "@/lib/channels/bluesky";
import type { DigestSummary } from "@/lib/channels/types";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes, canRedaktion, canFreigeben } from "@/lib/auth/roles";

// ---------------------------------------------------------------------------
// Auth-Hilfsfunktionen
// ---------------------------------------------------------------------------

async function getAuthContext() {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return null;

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const tokenHash = sha256Hex(rawToken);
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);

  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        eq(sessions.tenantId, tenant.id),
      )
    )
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) return null;

  return { tenant, userId: session.userId, db };
}

// Rollen-Logik liegt jetzt zentral in @/lib/auth/roles (canRedaktion / canFreigeben).

// ---------------------------------------------------------------------------
// N1: Content-Hash über alle Statements
// ---------------------------------------------------------------------------

/**
 * Berechnet einen sha256-Hash über alle Statements eines Digests.
 * Deterministisch serialisiert: position|text|source_url, sortiert nach position.
 */
function computeStatementsHash(
  stmts: Array<{ position: number; text: string; sourceUrl: string }>
): string {
  const sorted = [...stmts].sort((a, b) => a.position - b.position);
  const canonical = sorted.map((s) => `${s.position}|${s.text}|${s.sourceUrl}`).join("\n");
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Action: Aussage als quellen-geprüft markieren / Markierung aufheben
// ---------------------------------------------------------------------------

export async function setStatementGeprueft(
  statementId: string,
  geprueft: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  if (!canRedaktion(roleTypes)) return { ok: false, error: "Keine Berechtigung (Redakteur oder Admin erforderlich)." };

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
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  if (!canRedaktion(roleTypes)) return { ok: false, error: "Keine Berechtigung (Redakteur oder Admin erforderlich)." };

  // Digest-Prüfung: existiert und gehört zu diesem Tenant, Status muss 'entwurf' sein
  const digestRows = await ctx.db
    .select({ id: digests.id, status: digests.status })
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };
  if (digestRows[0].status !== "entwurf") return { ok: false, error: "Prüf-Markierung nur im Status 'entwurf' möglich." };

  // Alle Statements auf jetzt geprüft setzen + Anzahl zählen
  const stmtCount = await ctx.db
    .select({ count: count() })
    .from(digestStatements)
    .where(eq(digestStatements.digestId, digestId));

  const anzahl = stmtCount[0]?.count ?? 0;
  const now = new Date();

  await ctx.db.transaction(async (tx: Db) => {
    await tx
      .update(digestStatements)
      .set({ geprueftAt: now, geprueftBy: ctx.userId })
      .where(eq(digestStatements.digestId, digestId));

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
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  if (!canRedaktion(roleTypes)) return { ok: false, error: "Keine Berechtigung (Redakteur oder Admin erforderlich)." };

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

  await ctx.db
    .update(digestStatements)
    .set({ istHighlight })
    .where(eq(digestStatements.id, statementId));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Action: Digest freigeben
// ---------------------------------------------------------------------------

export async function freigeben(digestId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  if (!canFreigeben(roleTypes)) {
    return {
      ok: false,
      error: "Freigabe nur durch kommune_admin/super_admin. Redakteure dürfen Aussagen prüfen, aber nicht freigeben (Vier-Augen-Prinzip).",
    };
  }

  // Statements laden für N1 Content-Hash und Anzeige-Zählung (nicht sicherheitskritisch)
  const digestRows = await ctx.db
    .select({ id: digests.id, status: digests.status })
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };

  const stmts = await ctx.db
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

  // H1 Vier-Augen-Toggle: wenn für den Tenant aktiv, darf der Freigeber keine der
  // Aussagen selbst geprüft haben (Freigeber ≠ Bearbeiter), und jede Aussage muss
  // einen erfassten (anderen) Prüfer haben. Pilot-Default: false (Ein-Personen-Betrieb).
  const tenantRow = await ctx.db
    .select({ vierAugen: tenants.vierAugenPflicht })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenant.id))
    .limit(1);
  const vierAugenPflicht = tenantRow[0]?.vierAugen ?? false;

  if (vierAugenPflicht) {
    const selbstOderUngeprueft = stmts.some(
      (s: { geprueftBy: string | null }) => s.geprueftBy === null || s.geprueftBy === ctx.userId,
    );
    if (selbstOderUngeprueft) {
      return {
        ok: false,
        error: "Vier-Augen-Prinzip aktiv: Der Freigeber darf keine Aussage dieses Digests selbst geprüft haben — jede Aussage muss von einer anderen Person geprüft sein.",
      };
    }
  }

  const contentHash = computeStatementsHash(stmts);
  const now = new Date();

  // H4: Status-UPDATE + Audit in gemeinsamer Transaktion
  // B1-Fix: atomares Gate — NOT EXISTS stellt sicher, dass kein Statement ungeprüft ist,
  // auch wenn zwischen der Anzeige-Zählung oben und diesem UPDATE ein nebenläufiges
  // setStatementGeprueft(stmt, false) ausgeführt wurde (TOCTOU-Schutz).
  const result = await ctx.db.transaction(async (tx: Db) => {
    // H1 Vier-Augen: atomarer Backstop — wenn aktiv, schlägt das UPDATE fehl, falls
    // irgendeine Aussage keinen (anderen) Prüfer hat (TOCTOU-Schutz zur Vorprüfung).
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
                  eq(digestStatements.geprueftBy, ctx.userId),
                ),
              ),
            ),
        )
      : undefined;

    const updated = await tx
      .update(digests)
      .set({
        status: "freigegeben",
        approvedBy: ctx.userId,
        approvedAt: now,
        approvedContentHash: contentHash, // N1
      })
      .where(
        and(
          eq(digests.id, digestId),
          eq(digests.tenantId, ctx.tenant.id),
          eq(digests.status, "entwurf"),
          // B1: atomares Gate — UPDATE schlägt fehl, wenn irgendein Statement ungeprueft ist
          notExists(
            tx.select({ id: digestStatements.id })
              .from(digestStatements)
              .where(
                and(
                  eq(digestStatements.digestId, digestId),
                  isNull(digestStatements.geprueftAt)
                )
              )
          ),
          // H1: atomarer Vier-Augen-Backstop (undefined wenn Toggle aus → von and() ignoriert)
          vierAugenGuard
        )
      )
      .returning({ id: digests.id });

    if (updated.length === 0) {
      // Ursache unterscheiden: Status nicht mehr 'entwurf' oder ungeprüfte Statements
      const current = await tx
        .select({ status: digests.status })
        .from(digests)
        .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
        .limit(1);

      if (current.length === 0 || current[0].status !== "entwurf") {
        return { ok: false as const, error: "Ungültiger Statusübergang: Freigabe nur aus Status 'entwurf' möglich." };
      }
      // Status ist 'entwurf', aber NOT EXISTS hat angeschlagen → ungeprüfte Statements
      return {
        ok: false as const,
        error: `Freigabe abgelehnt: Es gibt noch ungeprüfte Aussagen (atomare Prüfung). Bitte alle Aussagen quellen-prüfen.`,
      };
    }

    // Audit (PII-frei: actor_ref = User-UUID)
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "digest.approved",
      targetType: "digest",
      targetId: digestId,
      metadata: { digestId, contentHash },
    });

    return { ok: true as const };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Action: Digest veröffentlichen
// ---------------------------------------------------------------------------

export async function veroeffentlichen(digestId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  if (!canFreigeben(roleTypes)) {
    return {
      ok: false,
      error: "Veröffentlichen nur durch kommune_admin/super_admin (Redakteure dürfen nicht veröffentlichen).",
    };
  }

  // Digest + gespeicherten Content-Hash laden
  const digestRows = await ctx.db
    .select()
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };

  const digest = digestRows[0];

  // Sicherheitsprüfung: approved_at muss gesetzt sein (Gate-B-Anforderung)
  if (!digest.approvedAt) {
    return { ok: false, error: "Fehler: approved_at nicht gesetzt obwohl Status 'freigegeben'. DB-Inkonsistenz." };
  }

  // N1: Content-Hash prüfen (Mismatch → Inhalt nach Freigabe geändert)
  if (digest.approvedContentHash) {
    const currentStmts = await ctx.db
      .select({ position: digestStatements.position, text: digestStatements.text, sourceUrl: digestStatements.sourceUrl })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digestId));

    // M1: Leerer Digest nicht veröffentlichbar
    if (currentStmts.length === 0) {
      return { ok: false, error: "Ein Digest ohne Aussagen kann nicht veröffentlicht werden." };
    }

    const currentHash = computeStatementsHash(currentStmts);
    if (currentHash !== digest.approvedContentHash) {
      return { ok: false, error: "Inhalt nach Freigabe geändert: Digest muss erneut freigegeben werden." };
    }
  } else {
    // M1: Kein approvedContentHash → leerer Digest oder fehlender Hash
    const stmtCount = await ctx.db
      .select({ count: count() })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digestId));
    if ((stmtCount[0]?.count ?? 0) === 0) {
      return { ok: false, error: "Ein Digest ohne Aussagen kann nicht veröffentlicht werden." };
    }
  }

  // Statements für die Kanal-Anreißer laden (ADR-021: nur Titel + 1. Aussage + Permalink)
  const stmtsForChannels = await ctx.db
    .select({ position: digestStatements.position, text: digestStatements.text })
    .from(digestStatements)
    .where(eq(digestStatements.digestId, digestId))
    .orderBy(digestStatements.position);

  const now = new Date();

  // H4: Status-UPDATE + Audit in gemeinsamer Transaktion
  // B1-Fix (zweite Verteidigungslinie): NOT EXISTS verhindert Veröffentlichung wenn Statements ungeprüft
  // M2: TOCTOU-Guard: UPDATE WHERE id+tenant+status='freigegeben'
  const result = await ctx.db.transaction(async (tx: Db) => {
    const updated = await tx
      .update(digests)
      .set({
        status: "veroeffentlicht",
        publishedAt: now,
      })
      .where(
        and(
          eq(digests.id, digestId),
          eq(digests.tenantId, ctx.tenant.id),
          eq(digests.status, "freigegeben"),  // M2: Guard
          // B1: zweite Verteidigungslinie — kein Statement darf ungeprüft sein
          notExists(
            tx.select({ id: digestStatements.id })
              .from(digestStatements)
              .where(
                and(
                  eq(digestStatements.digestId, digestId),
                  isNull(digestStatements.geprueftAt)
                )
              )
          )
        )
      )
      .returning({ id: digests.id });

    if (updated.length === 0) {
      // Ursache unterscheiden
      const current = await tx
        .select({ status: digests.status })
        .from(digests)
        .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
        .limit(1);

      if (current.length === 0 || current[0].status !== "freigegeben") {
        return { ok: false as const, error: "Ungültiger Statusübergang: Veröffentlichen nur aus Status 'freigegeben' möglich." };
      }
      return {
        ok: false as const,
        error: "Veröffentlichung abgelehnt: Es gibt noch ungeprüfte Aussagen (atomare Prüfung).",
      };
    }

    // Audit
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "digest.published",
      targetType: "digest",
      targetId: digestId,
      metadata: { digestId },
    });

    return { ok: true as const };
  });

  if (!result.ok) return result;

  // Kanal-Versand (ADR-021): souveräne, offene Protokolle — Mastodon (ActivityPub,
  // primär) und Bluesky (AT, Reichweite). Beide sind no-op ohne env-Zugangsdaten.
  // BEST-EFFORT: Ein Kanal-Fehler darf die Veröffentlichung NIEMALS abbrechen —
  // der Digest steht bereits auf der eigenen Seite (die IST der Kanal).
  const summary: DigestSummary = {
    id: digestId,
    title: digest.title,
    statements: stmtsForChannels.map((s: { position: number; text: string }) => ({ text: s.text })),
    tenantSlug: ctx.tenant.slug,
  };

  const channelResults = await Promise.allSettled([
    sendDigestToMastodon(summary),
    sendDigestToBluesky(summary),
  ]);

  // Audit der Kanal-Ergebnisse ist selbst best-effort: Der Digest ist bereits
  // live — ein Audit-Fehlschlag darf die Action nicht mehr scheitern lassen.
  // try/catch PRO Kanal: Scheitert ein Insert (z. B. transient), gehen die
  // Audit-Einträge der übrigen Kanäle nicht mit verloren.
  for (const settled of channelResults) {
    if (settled.status === "rejected") {
      console.error("[Kanal] Unerwarteter Fehler:", settled.reason);
      continue;
    }
    const r = settled.value;
    try {
      if (r.sent) {
        // Erfolg PII-frei ins Audit (url kann fehlen, z. B. Bluesky ohne uri).
        await ctx.db.insert(auditEvents).values({
          tenantId: ctx.tenant.id,
          actorType: "system",
          actorRef: null,
          action: "digest.channel_published",
          targetType: "digest",
          targetId: digestId,
          metadata: { channel: r.channel, url: r.url },
        });
      } else if (r.error) {
        // Fehler PII-frei ins Audit; Veröffentlichung läuft weiter.
        await ctx.db.insert(auditEvents).values({
          tenantId: ctx.tenant.id,
          actorType: "system",
          actorRef: null,
          action: "digest.channel_error",
          targetType: "digest",
          targetId: digestId,
          metadata: { channel: r.channel, error: r.error },
        });
      }
    } catch (err) {
      console.error(`[Kanal] Audit-Eintrag für "${r.channel}" fehlgeschlagen:`, err);
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Digest mit Berechtigungsprüfung laden
// ---------------------------------------------------------------------------

export async function loadDigestForAdmin(digestId: string) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
  if (!canRedaktion(roleTypes)) return null;

  const digestRows = await ctx.db
    .select()
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, ctx.tenant.id)))
    .limit(1);

  return digestRows[0] ?? null;
}

