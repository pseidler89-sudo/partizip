/**
 * veroeffentlichen-core.ts — Kern-Logik der Digest-Veröffentlichung.
 *
 * KEIN "use server": direkt unit-/integration-testbar (Muster wie freigabe-core.ts).
 * Die dünne Server-Action `veroeffentlichen` in digest/actions.ts löst den
 * Auth-Kontext + den Demo-Seed-Schutz auf und delegiert hierher; das Betreiber-CLI
 * `digest:publish` (scripts/digest-publish.ts) ruft dieselbe Funktion. KEIN
 * Copy-Paste, EIN Übergang — Action und CLI verhalten sich bit-genau gleich.
 *
 * Übergang (unverändert übernommen aus der früheren Inline-Action):
 *   - freigegeben → veroeffentlicht, ATOMARER CAS (UPDATE WHERE status='freigegeben'),
 *     zweite Verteidigungslinie NOT EXISTS(ungeprüftes Statement), TOCTOU-fest.
 *   - approved_at-Konsistenz + N1-Content-Hash-Vergleich (Inhalt nach Freigabe
 *     geändert ⇒ Ablehnung), M1 leerer Digest ⇒ Ablehnung.
 *   - H4: Status-UPDATE + digest.published-Audit in EINER Transaktion.
 *   - SIDE-EFFECT-FENCE (Demo-Mandant, fail-closed): KEIN Kanal-Versand, statt-
 *     dessen digest.channels_skipped-Audit — die echten MASTODON_/BLUESKY_-Tokens
 *     liegen prozessglobal, Demo darf NIE nach außen posten.
 *   - Kanal-Versand (ADR-021) best-effort AUSSERHALB der Transaktion: ein
 *     Kanal-/Audit-Fehler bricht die Veröffentlichung NIEMALS ab.
 */

import { and, count, eq, isNull, notExists } from "drizzle-orm";
import type { Db } from "@/db/client";
import { digests, digestStatements, auditEvents } from "@/db/schema";
import { sendDigestToMastodon } from "@/lib/channels/mastodon";
import { sendDigestToBluesky } from "@/lib/channels/bluesky";
import type { DigestSummary } from "@/lib/channels/types";
import { isDemoTenant } from "@/lib/demo/config";
import { canFreigeben } from "@/lib/auth/roles";
import { computeStatementsHash, type FreigabeResult } from "@/lib/digest/freigabe-core";

export interface VeroeffentlichenInput {
  digestId: string;
  /** UserId der veröffentlichenden Person (Audit-actorRef, Rollen-Gate). */
  callerUserId: string;
  /** Rollen des Callers — canFreigeben wird HIER erneut erzwungen. */
  callerRoleTypes: string[];
  /** Slug des Tenants — steuert die Demo-Side-Effect-Fence (isDemoTenant). */
  tenantSlug: string;
}

/**
 * Digest veröffentlichen: freigegeben → veroeffentlicht. Enthält ALLE Gates
 * (Rolle, Tenant-Isolation, approved_at-Konsistenz, N1-Hash, atomarer CAS,
 * Demo-Fence) und den best-effort-Kanal-Versand — bit-genau wie die frühere
 * Inline-Action. Die Demo-Seed-Schutz-Vorprüfung bleibt bewusst im Action-/CLI-
 * Rand (nicht hier), analog freigebenCore.
 */
export async function veroeffentlichenCore(
  db: Db,
  tenantId: string,
  input: VeroeffentlichenInput,
): Promise<FreigabeResult> {
  const { digestId, callerUserId, callerRoleTypes, tenantSlug } = input;

  if (!canFreigeben(callerRoleTypes)) {
    return {
      ok: false,
      error:
        "Veröffentlichen nur durch kommune_admin/super_admin (Redakteure dürfen nicht veröffentlichen).",
    };
  }

  // Digest + gespeicherten Content-Hash laden
  const digestRows = await db
    .select()
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenantId)))
    .limit(1);

  if (digestRows.length === 0) return { ok: false, error: "Digest nicht gefunden." };

  const digest = digestRows[0];

  // Sicherheitsprüfung: approved_at muss gesetzt sein (Gate-B-Anforderung)
  if (!digest.approvedAt) {
    return { ok: false, error: "Fehler: approved_at nicht gesetzt obwohl Status 'freigegeben'. DB-Inkonsistenz." };
  }

  // N1: Content-Hash prüfen (Mismatch → Inhalt nach Freigabe geändert)
  if (digest.approvedContentHash) {
    const currentStmts = await db
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
    const stmtCount = await db
      .select({ count: count() })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digestId));
    if ((stmtCount[0]?.count ?? 0) === 0) {
      return { ok: false, error: "Ein Digest ohne Aussagen kann nicht veröffentlicht werden." };
    }
  }

  // Statements für die Kanal-Anreißer laden (ADR-021: nur Titel + 1. Aussage + Permalink)
  const stmtsForChannels = await db
    .select({ position: digestStatements.position, text: digestStatements.text })
    .from(digestStatements)
    .where(eq(digestStatements.digestId, digestId))
    .orderBy(digestStatements.position);

  const now = new Date();

  // H4: Status-UPDATE + Audit in gemeinsamer Transaktion
  // B1-Fix (zweite Verteidigungslinie): NOT EXISTS verhindert Veröffentlichung wenn Statements ungeprüft
  // M2: TOCTOU-Guard: UPDATE WHERE id+tenant+status='freigegeben'
  const result = await db.transaction(async (tx: Db) => {
    const updated = await tx
      .update(digests)
      .set({
        status: "veroeffentlicht",
        publishedAt: now,
      })
      .where(
        and(
          eq(digests.id, digestId),
          eq(digests.tenantId, tenantId),
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
        .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenantId)))
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
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "digest.published",
      targetType: "digest",
      targetId: digestId,
      metadata: { digestId },
    });

    return { ok: true as const };
  });

  if (!result.ok) return result;

  // SIDE-EFFECT-FENCE (Demo-Spielwiese, fail-closed): Auf dem Demo-Mandanten
  // wird der Kanal-Versand KOMPLETT übersprungen. Die ECHTEN MASTODON_/BLUESKY_-
  // Zugangsdaten liegen im selben Prozess (env-Gates sind prozessglobal) — ohne
  // diesen Fence könnte jeder Demo-Besucher mit ephemerem Wegwerf-Admin über
  // die souveränen Kanäle der Installation NACH AUSSEN posten. Die
  // Veröffentlichung selbst (Status, eigene Seite) bleibt erlaubt: die Demo
  // zeigt die volle Kette, nur die Außenwirkung ist gekappt. Im Zweifel gilt:
  // isDemoTenant ⇒ keine Außenwirkung.
  if (isDemoTenant(tenantSlug)) {
    try {
      await db.insert(auditEvents).values({
        tenantId,
        actorType: "system",
        actorRef: null,
        action: "digest.channels_skipped",
        targetType: "digest",
        targetId: digestId,
        metadata: { grund: "demo_tenant" },
      });
    } catch (err) {
      // Audit best-effort — der Digest ist bereits live, die Action bleibt ok.
      console.error("[Kanal] Audit digest.channels_skipped fehlgeschlagen:", err);
    }
    return { ok: true };
  }

  // Kanal-Versand (ADR-021): souveräne, offene Protokolle — Mastodon (ActivityPub,
  // primär) und Bluesky (AT, Reichweite). Beide sind no-op ohne env-Zugangsdaten.
  // BEST-EFFORT: Ein Kanal-Fehler darf die Veröffentlichung NIEMALS abbrechen —
  // der Digest steht bereits auf der eigenen Seite (die IST der Kanal).
  const summary: DigestSummary = {
    id: digestId,
    title: digest.title,
    statements: stmtsForChannels.map((s: { position: number; text: string }) => ({ text: s.text })),
    tenantSlug,
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
        await db.insert(auditEvents).values({
          tenantId,
          actorType: "system",
          actorRef: null,
          action: "digest.channel_published",
          targetType: "digest",
          targetId: digestId,
          metadata: { channel: r.channel, url: r.url },
        });
      } else if (r.error) {
        // Fehler PII-frei ins Audit; Veröffentlichung läuft weiter.
        await db.insert(auditEvents).values({
          tenantId,
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
