/**
 * notify-actions.ts — Server Action zum Verwalten der Benachrichtigungs-
 * Einstellung des eigenen Kontos (Benachrichtigungs-Motor, Opt-out).
 *
 * Gate-B: Server Actions sind eigenständige Endpoints — Auth/Tenant werden
 * serverseitig erzwungen, nie dem Client vertraut. Das UPDATE ist self-scoped
 * (eigene userId aus der Session) UND tenant-scoped.
 *
 * Dünne Auth-Auflösung (Tenant aus Host, Session aus Cookie) wie in der
 * Konto-Lösch-Action; die eigentliche Mutation ist ein einzeiliges,
 * doppelt-gescoptes UPDATE.
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { sessions, users, auditEvents } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

type AuthContext = {
  tenant: { id: string; slug: string };
  userId: string;
  db: Db;
};

async function getAuthContext(): Promise<AuthContext | null> {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return null;

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);

  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) return null;

  return { tenant: { id: tenant.id, slug: tenant.slug }, userId: session.userId, db };
}

/**
 * Setzt das Flag „E-Mail bei neuen Abstimmungen in meinem Gebiet" für das eigene
 * Konto (eingeloggt, self + tenant-scoped). Audit PII-frei (nur Flag-Wert).
 *
 * @param aktiv  true = Benachrichtigungen erhalten, false = abbestellen.
 */
export async function setNeuePollBenachrichtigung(
  aktiv: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  // Doppelt-gescoptes UPDATE: eigener User (Session) + Tenant. RETURNING als
  // Treffer-Bestätigung (0 Zeilen ⇒ User existiert nicht im Tenant).
  const updated = await ctx.db
    .update(users)
    .set({ notifyNewPolls: aktiv })
    .where(and(eq(users.tenantId, ctx.tenant.id), eq(users.id, ctx.userId)))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return { ok: false, error: "Benutzer nicht gefunden." };
  }

  // Audit PII-frei: nur der neue Flag-Wert, keine E-Mail.
  await ctx.db.insert(auditEvents).values({
    tenantId: ctx.tenant.id,
    actorType: "user",
    actorRef: ctx.userId,
    action: "konto.notify_new_polls",
    targetType: "user",
    targetId: ctx.userId,
    metadata: { notifyNewPolls: aktiv },
  });

  return { ok: true };
}

/**
 * Setzt das Flag „E-Mail bei Statusänderung meiner gefolgten Anliegen" für das
 * eigene Konto (eingeloggt, self + tenant-scoped). Wirkt als Versandfilter in
 * lib/anliegen/follower-recipients.ts. Audit PII-frei (nur Flag-Wert).
 *
 * @param aktiv  true = Status-Mails erhalten, false = abbestellen.
 */
export async function setAnliegenBenachrichtigung(
  aktiv: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const updated = await ctx.db
    .update(users)
    .set({ notifyAnliegenUpdates: aktiv })
    .where(and(eq(users.tenantId, ctx.tenant.id), eq(users.id, ctx.userId)))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return { ok: false, error: "Benutzer nicht gefunden." };
  }

  await ctx.db.insert(auditEvents).values({
    tenantId: ctx.tenant.id,
    actorType: "user",
    actorRef: ctx.userId,
    action: "konto.notify_anliegen_updates",
    targetType: "user",
    targetId: ctx.userId,
    metadata: { notifyAnliegenUpdates: aktiv },
  });

  return { ok: true };
}

/**
 * Setzt das Flag „Erinnerung, wenn meine Wohnsitz-Verifizierung ausläuft" für das
 * eigene Konto (eingeloggt, self + tenant-scoped). Wirkt als Versandfilter in
 * lib/verification/reverify-reminders.ts. Audit PII-frei (nur Flag-Wert).
 *
 * @param aktiv  true = Erinnerung erhalten, false = abbestellen.
 */
export async function setReverifyBenachrichtigung(
  aktiv: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const updated = await ctx.db
    .update(users)
    .set({ notifyReverify: aktiv })
    .where(and(eq(users.tenantId, ctx.tenant.id), eq(users.id, ctx.userId)))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return { ok: false, error: "Benutzer nicht gefunden." };
  }

  await ctx.db.insert(auditEvents).values({
    tenantId: ctx.tenant.id,
    actorType: "user",
    actorRef: ctx.userId,
    action: "konto.notify_reverify",
    targetType: "user",
    targetId: ctx.userId,
    metadata: { notifyReverify: aktiv },
  });

  return { ok: true };
}
