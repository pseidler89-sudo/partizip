/**
 * actions.ts — Server Actions für Anliegen-Tracker (M8)
 *
 * Gate-B-Pflicht: Server Actions sind eigenständige Endpoints!
 * Jede Action prüft: Auth + Rolle + Tenant DB-seitig.
 *
 * Patterns aus M7 digest/actions.ts:
 *   - Session + Rolle aus DB (kein Client-Trust)
 *   - TOCTOU-Guard: UPDATE WHERE status=<expected>, rowCount prüfen
 *   - Status-UPDATE + Audit in Transaktion
 *   - Audit-Events PII-frei (actor_ref = User-UUID, keine E-Mail)
 *
 * createAnliegen: requireStufe(2) — bestätigter Wohnsitz, Zod-Validierung, scopedDb
 * changeStatus: nur kommune_admin|super_admin, Status-Guard im WHERE
 * confirmMatch / rejectMatch: nur Admins, Match-Status-Guard
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "@/db/client";
import {
  anliegen,
  anliegenEvents,
  anliegenFollowers,
  anliegenMatches,
  auditEvents,
  ortsteile,
  sessions,
  users,
} from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getStufe } from "@/lib/eligibility/stufe";
import { getUserRoleTypes, isAdmin } from "@/lib/auth/roles";
import { computeCreatorRef } from "@/lib/anliegen/creator-ref";
import { getAnliegenFollowerEmails } from "@/lib/anliegen/follower-recipients";
import { generateUniqueTrackingCode } from "@/lib/anliegen/tracking-code";
import { checkAnliegenRateLimit } from "@/lib/anliegen/rate-limit";
import { clientIpFromForwardedFor } from "@/lib/client-ip";
import { notifyFollowersStatusChanged, sendTrackingCodeEmail } from "@/lib/anliegen/notify";
import type { NotifyTransport } from "@/lib/anliegen/notify";
import { FEATURE_ANLIEGEN_EINREICHEN } from "@/lib/features";
import { isDemoTenant } from "@/lib/demo/config";

// ---------------------------------------------------------------------------
// Auth-Hilfsfunktionen (nach Muster aus digest/actions.ts)
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

  // User für Stufen-Check laden
  const userRows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
    .limit(1);

  const user = userRows[0];
  if (!user) return null;

  return { tenant, userId: session.userId, user, db };
}

/**
 * Admin-Check über den zentralen Rollen-Helper (H1/M2).
 * Ersetzt das früher lokale `hasAdminRole` für Konsistenz mit dem Rest des Codes.
 */
async function requireAdmin(
  db: Db,
  tenantId: string,
  userId: string
): Promise<boolean> {
  return isAdmin(await getUserRoleTypes(db, tenantId, userId));
}

/**
 * Liest die Client-IP aus den Request-Headern — LETZTES x-forwarded-for-
 * Element (Proxy-Semantik, siehe lib/client-ip.ts; Projekt-Review P1-2).
 */
async function getClientIp(): Promise<string | null> {
  const headerStore = await headers();
  return clientIpFromForwardedFor(headerStore.get("x-forwarded-for"));
}

// ---------------------------------------------------------------------------
// Zod-Schemas
// ---------------------------------------------------------------------------

const createAnliegenSchema = z.object({
  titel: z.string().min(1, "Titel ist erforderlich.").max(200, "Titel darf maximal 200 Zeichen haben."),
  beschreibung: z.string().max(5000, "Beschreibung darf maximal 5000 Zeichen haben.").optional(),
  ortsteilId: z.string().uuid().optional().nullable(),
});

const changeStatusSchema = z.object({
  anliegenId: z.string().uuid(),
  newStatus: z.enum(["eingegangen", "in_pruefung", "im_gremium", "beantwortet", "umgesetzt", "abgelehnt"]),
  quelleUrl: z
    .string()
    .url()
    .refine(u => u.startsWith("http://") || u.startsWith("https://"), {
      message: "Quelle muss eine http/https-URL sein.",
    })
    .optional()
    .nullable(),
  notiz: z.string().max(1000).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Action: Anliegen erstellen (Stufe 2 — bestätigter Wohnsitz — erforderlich)
// ---------------------------------------------------------------------------

export async function createAnliegen(
  rawData: unknown,
  transport?: NotifyTransport
): Promise<{ ok: boolean; trackingCode?: string; error?: string }> {
  // Feature-Flag-Hard-Gate (ADR-014): auch serverseitig, damit die Action nicht
  // über einen Direktaufruf umgangen werden kann, solange das Modul deaktiviert ist.
  if (!FEATURE_ANLIEGEN_EINREICHEN) {
    return { ok: false, error: "Diese Funktion ist derzeit nicht aktiv." };
  }

  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  // Stufe-Prüfung: Anliegen einreichen erfordert einen bestätigten Wohnsitz
  // (Stufe 2). getStufe auf der vollen user-row (kein Client-Trust). Fail-closed.
  const stufe = getStufe(ctx.user);
  if (stufe < 2) {
    return { ok: false, error: "Anliegen können nur mit bestätigtem Wohnsitz (Stufe 2) eingereicht werden." };
  }

  // Zod-Validierung
  const parsed = createAnliegenSchema.safeParse(rawData);
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Ungültige Eingabe.";
    return { ok: false, error: msg };
  }

  const { titel, beschreibung, ortsteilId } = parsed.data;

  // H2a: Rate-Limit (vor dem Anlegen). IP aus Request-Headern.
  const ipAddress = await getClientIp();
  const rateLimit = await checkAnliegenRateLimit(ctx.db, {
    tenantId: ctx.tenant.id,
    userId: ctx.userId,
    ipAddress,
  });
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: "Zu viele Anliegen in kurzer Zeit. Bitte versuchen Sie es später erneut.",
    };
  }

  // Creator-Ref: HMAC(ANLIEGEN_REF_SALT, userId) — Pseudonym, kein User-FK
  let creatorRef: string;
  try {
    creatorRef = computeCreatorRef(ctx.userId);
  } catch (err) {
    console.error("[createAnliegen] Fehler bei creator_ref:", err);
    return { ok: false, error: "Konfigurationsfehler: ANLIEGEN_REF_SALT fehlt." };
  }

  // Tracking-Code generieren (CSPRNG, max. 5 Versuche)
  let trackingCode: string;
  try {
    trackingCode = await generateUniqueTrackingCode(async (code) => {
      const existing = await ctx.db
        .select({ id: anliegen.id })
        .from(anliegen)
        .where(eq(anliegen.trackingCode, code))
        .limit(1);
      return existing.length === 0;
    });
  } catch (err) {
    console.error("[createAnliegen] Tracking-Code-Generierung fehlgeschlagen:", err);
    return { ok: false, error: "Interner Fehler: Tracking-Code-Generierung." };
  }

  // Gate-B MINOR-1: ortsteilId muss zum Host-Tenant gehören (Tenant-Isolation)
  if (ortsteilId) {
    const ot = await ctx.db
      .select({ id: ortsteile.id })
      .from(ortsteile)
      .where(and(eq(ortsteile.id, ortsteilId), eq(ortsteile.tenantId, ctx.tenant.id)))
      .limit(1);
    if (ot.length === 0) {
      return { ok: false, error: "Ungültiger Ortsteil." };
    }
  }

  // Transaktion: Anliegen + erstes Event + Follower + Audit
  const newAnliegenId = await ctx.db.transaction(async (tx: Db) => {
    const [anliegenRow] = await tx
      .insert(anliegen)
      .values({
        tenantId: ctx.tenant.id,
        trackingCode,
        creatorRef,
        titel,
        beschreibung: beschreibung ?? null,
        ortsteilId: ortsteilId ?? null,
        status: "eingegangen",
      })
      .returning({ id: anliegen.id });

    const anliegenId = anliegenRow.id;

    // Erstes Event
    await tx.insert(anliegenEvents).values({
      anliegenId,
      status: "eingegangen",
      notiz: null,
      quelle: null,
    });

    // Ersteller als Follower (für Benachrichtigungen)
    await tx.insert(anliegenFollowers).values({
      anliegenId,
      userId: ctx.userId,
    });

    // Audit (PII- UND geheimnisfrei): der trackingCode ist das Zugangsgeheimnis
    // für den kontolosen Status-Abruf und gehört NICHT ins (retentionsfreie) Audit —
    // anliegenId/targetId genügen zur Korrelation.
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "user",
      actorRef: ctx.userId,
      action: "anliegen.created",
      targetType: "anliegen",
      targetId: anliegenId,
      metadata: { anliegenId },
    });

    return anliegenId;
  });

  // H4: Tracking-Code per E-Mail an den Ersteller (best effort).
  // Mailfehler darf createAnliegen NICHT scheitern lassen.
  try {
    const ok = await sendTrackingCodeEmail({
      email: ctx.user.email,
      trackingCode,
      tenantSlug: ctx.tenant.slug,
      transport,
    });
    if (!ok) {
      await ctx.db.insert(auditEvents).values({
        tenantId: ctx.tenant.id,
        actorType: "system",
        actorRef: null,
        action: "anliegen.tracking_mail_error",
        targetType: "anliegen",
        targetId: newAnliegenId,
        metadata: { anliegenId: newAnliegenId },
      });
    }
  } catch (err) {
    console.error("[createAnliegen] Tracking-Mail-Fehler:", err);
    try {
      await ctx.db.insert(auditEvents).values({
        tenantId: ctx.tenant.id,
        actorType: "system",
        actorRef: null,
        action: "anliegen.tracking_mail_error",
        targetType: "anliegen",
        targetId: newAnliegenId,
        metadata: { anliegenId: newAnliegenId },
      });
    } catch {
      // Audit-Schreibfehler darf die Haupterstellung nicht kippen.
    }
  }

  return { ok: true, trackingCode };
}

// ---------------------------------------------------------------------------
// Action: Status ändern (nur Admins)
// ---------------------------------------------------------------------------

export async function changeAnliegenStatus(
  rawData: unknown,
  transport?: NotifyTransport
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const admin = await requireAdmin(ctx.db, ctx.tenant.id, ctx.userId);
  if (!admin) {
    return { ok: false, error: "Keine Berechtigung (kommune_admin oder super_admin erforderlich)." };
  }

  const parsed = changeStatusSchema.safeParse(rawData);
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Ungültige Eingabe.";
    return { ok: false, error: msg };
  }

  const { anliegenId, newStatus, quelleUrl, notiz } = parsed.data;

  // Aktuelles Anliegen laden (Tenant-Scope)
  const anliegenRows = await ctx.db
    .select({ id: anliegen.id, status: anliegen.status, trackingCode: anliegen.trackingCode })
    .from(anliegen)
    .where(and(eq(anliegen.id, anliegenId), eq(anliegen.tenantId, ctx.tenant.id)))
    .limit(1);

  if (anliegenRows.length === 0) {
    return { ok: false, error: "Anliegen nicht gefunden." };
  }

  const currentAnliegen = anliegenRows[0];
  const previousStatus = currentAnliegen.status;

  // Transaktion: Status-Update (TOCTOU-Guard) + Event + Audit
  const result = await ctx.db.transaction(async (tx: Db) => {
    // TOCTOU-Guard: UPDATE WHERE status=<aktueller Status>
    const updated = await tx
      .update(anliegen)
      .set({ status: newStatus })
      .where(
        and(
          eq(anliegen.id, anliegenId),
          eq(anliegen.tenantId, ctx.tenant.id),
          eq(anliegen.status, previousStatus) // Guard!
        )
      )
      .returning({ id: anliegen.id });

    if (updated.length === 0) {
      return {
        ok: false as const,
        error: "Status wurde parallel geändert — bitte erneut versuchen.",
      };
    }

    // Event
    await tx.insert(anliegenEvents).values({
      anliegenId,
      status: newStatus,
      quelle: quelleUrl ?? null,
      notiz: notiz ?? null,
    });

    // Audit (PII-frei)
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "anliegen.status_changed",
      targetType: "anliegen",
      targetId: anliegenId,
      metadata: {
        anliegenId,
        previousStatus,
        newStatus,
        hasQuelle: !!quelleUrl,
      },
    });

    return { ok: true as const };
  });

  if (!result.ok) return result;

  // SIDE-EFFECT-FENCE (Block I): Auf dem Demo-Mandanten keine echten Mails an
  // Follower (Doktrin „isDemoTenant ⇒ keine Außenwirkung"). Der Statuswechsel
  // selbst ist erlaubt und bereits committet — nur der SMTP-Versand entfällt.
  if (isDemoTenant(ctx.tenant.slug)) return { ok: true };

  // Follower benachrichtigen (außerhalb Transaktion — Fehler blockieren nicht)
  try {
    // Block J2c: Versandfilter (Opt-out notify_anliegen_updates + Hygiene) im
    // testbaren Lese-Helfer — nur zustellbare Opt-in-Follower erhalten die Mail.
    const followerEmails = await getAnliegenFollowerEmails(ctx.db, ctx.tenant.id, anliegenId);

    const notifyResult = await notifyFollowersStatusChanged({
      trackingCode: currentAnliegen.trackingCode,
      tenantSlug: ctx.tenant.slug,
      previousStatus,
      newStatus,
      quelleUrl: quelleUrl ?? null,
      followerEmails,
      transport,
    });

    if (notifyResult.errors > 0) {
      // Audit-Event für Fehler (ohne PII: keine E-Mail-Adressen)
      await ctx.db.insert(auditEvents).values({
        tenantId: ctx.tenant.id,
        actorType: "system",
        actorRef: null,
        action: "anliegen.notify_error",
        targetType: "anliegen",
        targetId: anliegenId,
        metadata: {
          anliegenId,
          sent: notifyResult.sent,
          errors: notifyResult.errors,
        },
      });
    }
  } catch (err) {
    console.error("[changeAnliegenStatus] Notification-Fehler:", err);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Action: Match bestätigen (nur Admins)
// ---------------------------------------------------------------------------

export async function confirmMatch(
  matchId: string,
  createEvent: boolean = false
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const admin = await requireAdmin(ctx.db, ctx.tenant.id, ctx.userId);
  if (!admin) {
    return { ok: false, error: "Keine Berechtigung (kommune_admin oder super_admin erforderlich)." };
  }

  const now = new Date();

  // Match laden (Tenant-Scope über Anliegen)
  const matchRows = await ctx.db
    .select({
      id: anliegenMatches.id,
      anliegenId: anliegenMatches.anliegenId,
      risDocumentId: anliegenMatches.risDocumentId,
      status: anliegenMatches.status,
    })
    .from(anliegenMatches)
    .innerJoin(anliegen, eq(anliegenMatches.anliegenId, anliegen.id))
    .where(
      and(
        eq(anliegenMatches.id, matchId),
        eq(anliegen.tenantId, ctx.tenant.id)
      )
    )
    .limit(1);

  if (matchRows.length === 0) {
    return { ok: false, error: "Match nicht gefunden." };
  }

  const match = matchRows[0];

  if (match.status !== "vorgeschlagen") {
    return { ok: false, error: "Match ist bereits bearbeitet." };
  }

  await ctx.db.transaction(async (tx: Db) => {
    // TOCTOU-Guard: UPDATE WHERE status='vorgeschlagen'
    const updated = await tx
      .update(anliegenMatches)
      .set({
        status: "bestaetigt",
        decidedBy: ctx.userId,
        decidedAt: now,
      })
      .where(
        and(
          eq(anliegenMatches.id, matchId),
          eq(anliegenMatches.status, "vorgeschlagen") // Guard!
        )
      )
      .returning({ id: anliegenMatches.id });

    if (updated.length === 0) return;

    // Optional: anliegen_event im_gremium erzeugen
    if (createEvent) {
      // Dokument-URL als Quelle laden
      const { risDocuments } = await import("@/db/schema");
      const docRows = await tx
        .select({ sourceUrl: risDocuments.sourceUrl })
        .from(risDocuments)
        .where(eq(risDocuments.id, match.risDocumentId))
        .limit(1);

      await tx.insert(anliegenEvents).values({
        anliegenId: match.anliegenId,
        status: "im_gremium",
        quelle: docRows[0]?.sourceUrl ?? null,
        notiz: null,
      });

      // Anliegen-Status auch aktualisieren
      await tx
        .update(anliegen)
        .set({ status: "im_gremium" })
        .where(eq(anliegen.id, match.anliegenId));
    }

    // Audit
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "anliegen.match_confirmed",
      targetType: "anliegen_match",
      targetId: matchId,
      metadata: { matchId, anliegenId: match.anliegenId, createEvent },
    });
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Action: Match verwerfen (nur Admins)
// ---------------------------------------------------------------------------

export async function rejectMatch(
  matchId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const admin = await requireAdmin(ctx.db, ctx.tenant.id, ctx.userId);
  if (!admin) {
    return { ok: false, error: "Keine Berechtigung (kommune_admin oder super_admin erforderlich)." };
  }

  const now = new Date();

  const matchRows = await ctx.db
    .select({
      id: anliegenMatches.id,
      anliegenId: anliegenMatches.anliegenId,
      status: anliegenMatches.status,
    })
    .from(anliegenMatches)
    .innerJoin(anliegen, eq(anliegenMatches.anliegenId, anliegen.id))
    .where(
      and(
        eq(anliegenMatches.id, matchId),
        eq(anliegen.tenantId, ctx.tenant.id)
      )
    )
    .limit(1);

  if (matchRows.length === 0) {
    return { ok: false, error: "Match nicht gefunden." };
  }

  const match = matchRows[0];

  if (match.status !== "vorgeschlagen") {
    return { ok: false, error: "Match ist bereits bearbeitet." };
  }

  await ctx.db.transaction(async (tx: Db) => {
    const updated = await tx
      .update(anliegenMatches)
      .set({
        status: "verworfen",
        decidedBy: ctx.userId,
        decidedAt: now,
      })
      .where(
        and(
          eq(anliegenMatches.id, matchId),
          eq(anliegenMatches.status, "vorgeschlagen") // Guard!
        )
      )
      .returning({ id: anliegenMatches.id });

    if (updated.length === 0) return;

    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "anliegen.match_rejected",
      targetType: "anliegen_match",
      targetId: matchId,
      metadata: { matchId, anliegenId: match.anliegenId },
    });
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// H2b: Takedown — Anliegen verbergen / wiederherstellen (nur Admins)
//
// Moderation für missbräuchliche Anliegen. Der Grund landet NUR in der Spalte
// verborgen_grund, NIEMALS im Audit (könnte PII/freien Text enthalten).
// Wer verborgen/wiederhergestellt hat, steht PII-frei via actorRef im Audit.
// ---------------------------------------------------------------------------

const verbergenSchema = z.object({
  anliegenId: z.string().uuid(),
  grund: z
    .string()
    .trim()
    .min(1, "Bitte geben Sie einen Grund an.")
    .max(1000, "Der Grund darf maximal 1000 Zeichen haben."),
});

export async function verbergenAnliegen(
  anliegenId: string,
  grund: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const admin = await requireAdmin(ctx.db, ctx.tenant.id, ctx.userId);
  if (!admin) {
    return { ok: false, error: "Keine Berechtigung (kommune_admin oder super_admin erforderlich)." };
  }

  const parsed = verbergenSchema.safeParse({ anliegenId, grund });
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Ungültige Eingabe.";
    return { ok: false, error: msg };
  }

  const now = new Date();

  const result = await ctx.db.transaction(async (tx: Db) => {
    // Tenant-scoped UPDATE; setzt verborgen_at + verborgen_grund.
    const updated = await tx
      .update(anliegen)
      .set({ verborgenAt: now, verborgenGrund: parsed.data.grund })
      .where(
        and(
          eq(anliegen.id, parsed.data.anliegenId),
          eq(anliegen.tenantId, ctx.tenant.id)
        )
      )
      .returning({ id: anliegen.id });

    if (updated.length === 0) {
      return { ok: false as const, error: "Anliegen nicht gefunden." };
    }

    // Audit (PII-frei) — Grund NICHT in die Metadaten.
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "anliegen.verborgen",
      targetType: "anliegen",
      targetId: parsed.data.anliegenId,
      metadata: { anliegenId: parsed.data.anliegenId },
    });

    return { ok: true as const };
  });

  return result;
}

export async function wiederherstellenAnliegen(
  anliegenId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const admin = await requireAdmin(ctx.db, ctx.tenant.id, ctx.userId);
  if (!admin) {
    return { ok: false, error: "Keine Berechtigung (kommune_admin oder super_admin erforderlich)." };
  }

  const idParsed = z.string().uuid().safeParse(anliegenId);
  if (!idParsed.success) {
    return { ok: false, error: "Ungültige Anliegen-ID." };
  }

  const result = await ctx.db.transaction(async (tx: Db) => {
    const updated = await tx
      .update(anliegen)
      .set({ verborgenAt: null, verborgenGrund: null })
      .where(
        and(
          eq(anliegen.id, idParsed.data),
          eq(anliegen.tenantId, ctx.tenant.id)
        )
      )
      .returning({ id: anliegen.id });

    if (updated.length === 0) {
      return { ok: false as const, error: "Anliegen nicht gefunden." };
    }

    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "admin",
      actorRef: ctx.userId,
      action: "anliegen.wiederhergestellt",
      targetType: "anliegen",
      targetId: idParsed.data,
      metadata: { anliegenId: idParsed.data },
    });

    return { ok: true as const };
  });

  return result;
}

// ---------------------------------------------------------------------------
// M3: Zurückziehen — NUR der Ersteller (kein Hard-Delete)
//
// Ownership wird über das Pseudonym geprüft: anliegen.creator_ref muss
// computeCreatorRef(ctx.userId) entsprechen (kein User-FK am Anliegen).
//
// Erlaubte Ausgangszustände (Designentscheidung): aktive Bearbeitung darf
// zurückgezogen werden — eingegangen, in_pruefung, im_gremium, beantwortet.
// NICHT erlaubt aus terminalen Zuständen (umgesetzt, abgelehnt) und natürlich
// nicht aus 'zurueckgezogen' (Idempotenz/Doppelaktion vermeiden). Begründung:
// Ein bereits umgesetztes oder abgelehntes Anliegen ist abgeschlossen; ein
// nachträgliches Zurückziehen würde den dokumentierten Verlauf verfälschen.
// ---------------------------------------------------------------------------

const WITHDRAWABLE_STATES = [
  "eingegangen",
  "in_pruefung",
  "im_gremium",
  "beantwortet",
] as const;

export async function zurueckziehenAnliegen(
  anliegenId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const idParsed = z.string().uuid().safeParse(anliegenId);
  if (!idParsed.success) {
    return { ok: false, error: "Ungültige Anliegen-ID." };
  }

  // Ownership-Pseudonym berechnen.
  let creatorRef: string;
  try {
    creatorRef = computeCreatorRef(ctx.userId);
  } catch (err) {
    console.error("[zurueckziehenAnliegen] Fehler bei creator_ref:", err);
    return { ok: false, error: "Konfigurationsfehler: ANLIEGEN_REF_SALT fehlt." };
  }

  // Anliegen laden — tenant-scoped UND ownership-scoped (creator_ref).
  const rows = await ctx.db
    .select({ id: anliegen.id, status: anliegen.status })
    .from(anliegen)
    .where(
      and(
        eq(anliegen.id, idParsed.data),
        eq(anliegen.tenantId, ctx.tenant.id),
        eq(anliegen.creatorRef, creatorRef)
      )
    )
    .limit(1);

  if (rows.length === 0) {
    // Kein Unterschied zwischen "nicht vorhanden" und "nicht Ersteller".
    return { ok: false, error: "Anliegen nicht gefunden." };
  }

  const current = rows[0];
  const currentStatus = current.status;

  if (!(WITHDRAWABLE_STATES as readonly string[]).includes(currentStatus)) {
    return {
      ok: false,
      error: "Dieses Anliegen kann in seinem aktuellen Status nicht zurückgezogen werden.",
    };
  }

  const result = await ctx.db.transaction(async (tx: Db) => {
    // TOCTOU-Guard: WHERE id + tenant + creator_ref + status=<aktuell> + status != 'zurueckgezogen'.
    const updated = await tx
      .update(anliegen)
      .set({ status: "zurueckgezogen" })
      .where(
        and(
          eq(anliegen.id, idParsed.data),
          eq(anliegen.tenantId, ctx.tenant.id),
          eq(anliegen.creatorRef, creatorRef),
          eq(anliegen.status, currentStatus),
          ne(anliegen.status, "zurueckgezogen")
        )
      )
      .returning({ id: anliegen.id });

    if (updated.length === 0) {
      return {
        ok: false as const,
        error: "Status wurde parallel geändert — bitte erneut versuchen.",
      };
    }

    // Verlaufs-Event (append-only).
    await tx.insert(anliegenEvents).values({
      anliegenId: idParsed.data,
      status: "zurueckgezogen",
      quelle: null,
      notiz: null,
    });

    // Audit (PII-frei): actorRef = userId, Pseudonymität gewahrt.
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "user",
      actorRef: ctx.userId,
      action: "anliegen.withdrawn",
      targetType: "anliegen",
      targetId: idParsed.data,
      metadata: { anliegenId: idParsed.data, previousStatus: currentStatus },
    });

    return { ok: true as const };
  });

  return result;
}
