/**
 * action-context.ts — Gemeinsamer Auth-/Tenant-/Session-Resolver für Server Actions.
 *
 * KEIN "use server": Dies ist ein Server-Hilfsmodul (kein RPC-Endpoint), das von
 * den "use server"-Action-Dateien (polls/actions, verification/qr-actions,
 * verification/booking-actions) importiert wird. Vorher lag dieser Resolver in
 * jeder dieser Dateien dupliziert — hier ist er EINMAL, damit Session-Auflösung,
 * Tenant-Isolation und die Berechtigungs-Gates garantiert identisch sind.
 *
 * SICHERHEITS-KERN (Gate-B):
 *   - Tenant aus dem Host (Pflicht); Session OPTIONAL (anonyme Besucher erlaubt).
 *   - Session-Validierung: tokenHash-Lookup tenant-scoped + revoked/expiry-Prüfung.
 *   - User tenant-scoped nachgeladen; userId/user NIE aus Client-Eingaben.
 *   - Die require*-Gates erzwingen Stufe bzw. Rolle SERVERSEITIG (kein
 *     Selbst-Hochstufen, kein Vertrauen in Client-Daten).
 */

import { cookies, headers } from "next/headers";
import { and, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost, type TenantRow } from "@/lib/tenant";
import { clientIpFromForwardedFor } from "@/lib/client-ip";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getStufe } from "@/lib/eligibility/stufe";
import { getUserRoleTypes, canVerify, isAdmin, isSuperAdmin } from "@/lib/auth/roles";
import {
  bewerteZweiFaktor,
  zugangErlaubt,
  stepUpErfuellt,
  type ZweiFaktorLage,
} from "@/lib/auth/zwei-faktor";

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

/** Standard-DB-URL (lokaler Dev-Fallback); in prod/staging aus der Umgebung. */
export function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export interface OptionalAuthContext {
  tenant: TenantRow;
  db: Db;
  /** null bei anonymen Besuchern (keine/ungültige Session). */
  userId: string | null;
  user: UserRow | null;
  /**
   * Die gültige Session-Zeile (null bei anonymem Zugriff). Wird für die
   * Zwei-Faktor-Pflicht gebraucht: `totp_verified_at` hängt an der Session, nicht
   * am Nutzer — ein zweiter Browser bekommt keinen Freifahrtschein.
   */
  session: SessionRow | null;
}

/** Eingeloggter Kontext (userId garantiert gesetzt) — Rückgabe der require*-Gates. */
export type AuthedContext = OptionalAuthContext & { userId: string };

/**
 * Auflöser für anonym-fähigen Kontext: Tenant aus Host (Pflicht), Session OPTIONAL.
 * Ohne gültige Session → userId/user = null (anonymer Zugriff erlaubt). null nur,
 * wenn der Host zu keinem Tenant auflöst (Seite nicht erreichbar).
 */
export async function getOptionalAuthContext(): Promise<OptionalAuthContext | null> {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return null;

  const db = createDb(databaseUrl());

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return { tenant, db, userId: null, user: null, session: null };

  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) {
    return { tenant, db, userId: null, user: null, session: null };
  }

  const userRows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
    .limit(1);

  const user = userRows[0] ?? null;
  if (!user) return { tenant, db, userId: null, user: null, session: null };
  return { tenant, db, userId: user.id, user, session };
}

/**
 * Ermittelt die Zwei-Faktor-Lage eines Admins und setzt beim ersten Zugriff die
 * Kulanzfrist (#59).
 *
 * Der Schreibvorgang steht bewusst hier und nicht im Login: Die Frist soll ab dem
 * ersten Admin-ZUGRIFF laufen, nicht ab dem Rollout — sonst wäre sie für einen
 * Admin, der zwei Wochen im Urlaub war, schon abgelaufen, bevor er sie je
 * gesehen hat. Das `WHERE totp_grace_until IS NULL` macht den Vorgang idempotent
 * und rennt nicht mit einem parallelen Request um die Wette.
 */
export async function zweiFaktorLage(
  ctx: OptionalAuthContext,
  istAdmin: boolean
): Promise<ZweiFaktorLage> {
  if (!ctx.user || !ctx.session) return { status: "nicht_noetig" };

  const lage = bewerteZweiFaktor({
    istAdmin,
    user: ctx.user,
    session: ctx.session,
  });

  if (lage.status === "frist_setzen") {
    await ctx.db
      .update(users)
      .set({ totpGraceUntil: lage.vorschlag })
      .where(and(eq(users.id, ctx.user.id), isNull(users.totpGraceUntil)));
    return { status: "einrichtung_offen", frist: lage.vorschlag };
  }
  return lage;
}

/**
 * Client-IP aus Request-Headern — LETZTES x-forwarded-for-Element (vom eigenen
 * Proxy angehängt), identische Semantik wie die Auth-Routen. Vorher wurde hier
 * das ERSTE (client-kontrollierbare) Element gelesen → Rate-Limits per Header
 * rotierbar (Projekt-Review 2026-07-02, P1-2). Details: lib/client-ip.ts.
 */
export async function getClientIp(): Promise<string | null> {
  const headerStore = await headers();
  return clientIpFromForwardedFor(headerStore.get("x-forwarded-for"));
}

/** Verlangt einen eingeloggten Caller mit Stufe ≥ 1 (Konto, Mindestalter, aktiv). */
export async function requireStufe1Ctx(): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; needLogin?: boolean; error: string }
> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (!ctx.userId || !ctx.user || getStufe(ctx.user) < 1) {
    return {
      ok: false,
      needLogin: true,
      error: "Bitte melden Sie sich an.",
    };
  }
  return { ok: true, ctx: { ...ctx, userId: ctx.userId } };
}

/** Verlangt einen eingeloggten canVerify-Caller (verifier/admin), tenant-scoped. */
export async function requireVerifierCtx(): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; error: string }
> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (!ctx.userId) return { ok: false, error: "Nicht authentifiziert." };
  const allowed = canVerify(await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId));
  if (!allowed) {
    return {
      ok: false,
      error: "Keine Berechtigung (verifier, kommune_admin oder super_admin erforderlich).",
    };
  }
  return { ok: true, ctx: { ...ctx, userId: ctx.userId } };
}

/**
 * Signal für die aufrufende Fläche, dass nicht die Berechtigung fehlt, sondern
 * der zweite Faktor. UI und Seiten leiten darauf gezielt weiter, statt einen
 * unspezifischen Berechtigungsfehler anzuzeigen.
 */
export type ZweiFaktorBedarf = "code" | "einrichten";

/** Verlangt einen eingeloggten Admin-Caller (kommune_admin/super_admin), tenant-scoped. */
export async function requireAdminCtx(): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; error: string; zweiFaktor?: ZweiFaktorBedarf }
> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (!ctx.userId) return { ok: false, error: "Nicht authentifiziert." };
  const admin = isAdmin(await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId));
  if (!admin) {
    return { ok: false, error: "Keine Berechtigung (kommune_admin oder super_admin erforderlich)." };
  }
  const lage = await zweiFaktorLage(ctx, true);
  if (!zugangErlaubt(lage)) {
    return lage.status === "code_faellig"
      ? { ok: false, error: "Zwei-Faktor-Bestätigung erforderlich.", zweiFaktor: "code" }
      : {
          ok: false,
          error: "Zwei-Faktor-Authentisierung muss für Admin-Konten eingerichtet werden.",
          zweiFaktor: "einrichten",
        };
  }
  return { ok: true, ctx: { ...ctx, userId: ctx.userId } };
}

/**
 * Eigenständiges Step-up-Gate für Actions, die ihren Kontext bereits auf einem
 * anderen Weg auflösen (Digest- und Rollen-Actions haben eigene Resolver).
 *
 * Bewusst als Zusatz-Zeile am Anfang der Action und nicht als Umbau ihrer
 * Kontext-Auflösung: Der Eingriff bleibt sichtbar und einzeln überprüfbar, und
 * die bestehende Autorisierungslogik bleibt unangetastet.
 *
 * Ist der Aufrufer kein Admin, greift das Gate NICHT — dann entscheidet die
 * ohnehin vorhandene Rollenprüfung der Action.
 */
export async function verlangeFrischeBestaetigung(): Promise<
  { ok: true } | { ok: false; error: string; zweiFaktor: ZweiFaktorBedarf }
> {
  const ctx = await getOptionalAuthContext();
  if (!ctx || !ctx.userId || !ctx.user || !ctx.session) return { ok: true };
  const admin = isAdmin(await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId));
  if (!admin) return { ok: true };

  if (stepUpErfuellt({ user: ctx.user, session: ctx.session })) return { ok: true };
  return {
    ok: false,
    error: "Diese Aktion verlangt eine frische Bestätigung mit Ihrem Einmalcode.",
    zweiFaktor: ctx.user.totpSecretEnc && ctx.user.totpConfirmedAt ? "code" : "einrichten",
  };
}

/**
 * Wie requireAdminCtx, verlangt zusätzlich eine FRISCHE TOTP-Prüfung (Step-up).
 *
 * Für Aktionen, deren Folgen sich nicht zurücknehmen lassen — Owner-Entscheid
 * 2026-08-05: Rollenvergabe sowie Veröffentlichen/Freigeben. Rollenvergabe ist
 * dabei der wichtigste Fall: Über sie könnte ein übernommenes Konto sich selbst
 * dauerhaft festsetzen.
 */
export async function requireAdminStepUpCtx(): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; error: string; zweiFaktor?: ZweiFaktorBedarf }
> {
  const basis = await requireAdminCtx();
  if (!basis.ok) return basis;
  const { ctx } = basis;
  if (!ctx.user || !ctx.session) {
    return { ok: false, error: "Nicht authentifiziert." };
  }
  if (!stepUpErfuellt({ user: ctx.user, session: ctx.session })) {
    // Ohne aktives TOTP ist Step-up grundsätzlich nicht erfüllbar — dann fehlt
    // die Einrichtung, nicht der Code.
    const bedarf: ZweiFaktorBedarf =
      ctx.user.totpSecretEnc && ctx.user.totpConfirmedAt ? "code" : "einrichten";
    return {
      ok: false,
      error: "Diese Aktion verlangt eine frische Bestätigung mit Ihrem Einmalcode.",
      zweiFaktor: bedarf,
    };
  }
  return basis;
}

/**
 * Verlangt einen eingeloggten super_admin-Caller (Betreiber). ENGER als
 * requireAdminCtx — für tenant-übergreifende Betreiber-Sichten (Block N:
 * Interessenten-Leads). Die Rollen werden account-status-gefiltert geladen
 * (gesperrtes Konto ⇒ [] ⇒ kein Zugriff, selbst bei gültiger Session).
 *
 * GUARDRAIL (Multi-Tenant-Skalierung): Die Rolle `super_admin` ist
 * BETREIBER-EXKLUSIV und darf NIE an Kunden-/Kommunen-Tenants vergeben werden.
 * Sie ist das Gate für tenant-FREIE Sichten (z. B. die Roh-Lead-PII aller
 * Interessenten, s. app/[tenant]/admin/interessenten/page.tsx) — ein super_admin
 * in einem Kunden-Tenant erhielte damit globale Sicht auf fremde Roh-Leads.
 * Heute unkritisch (nur der Plattform-Betreiber ist super_admin; ein kommune_admin
 * kann sich nicht selbst hochstufen), aber beim Onboarding weiterer Tenants strikt
 * einzuhalten: super_admin bleibt ausschließlich beim Betreiber.
 */
export async function requireSuperAdminCtx(): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; error: string; zweiFaktor?: ZweiFaktorBedarf }
> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (!ctx.userId) return { ok: false, error: "Nicht authentifiziert." };
  const superAdmin = isSuperAdmin(await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId));
  if (!superAdmin) {
    return { ok: false, error: "Keine Berechtigung (super_admin erforderlich)." };
  }
  const lage = await zweiFaktorLage(ctx, true);
  if (!zugangErlaubt(lage)) {
    return lage.status === "code_faellig"
      ? { ok: false, error: "Zwei-Faktor-Bestätigung erforderlich.", zweiFaktor: "code" }
      : {
          ok: false,
          error: "Zwei-Faktor-Authentisierung muss für Admin-Konten eingerichtet werden.",
          zweiFaktor: "einrichten",
        };
  }
  return { ok: true, ctx: { ...ctx, userId: ctx.userId } };
}
