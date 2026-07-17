/**
 * demo/actions.ts — Ephemere Demo-Session für die Akquise-Spielwiese.
 *
 * Gate-B: Server Action = eigenständiger Endpoint. SICHERHEITS-KERN:
 *
 *   - Funktioniert AUSSCHLIESSLICH auf dem Demo-Mandanten (isDemoTenant, serverseitig
 *     hart über den Host aufgelöst — kein Client-Input). Auf jedem anderen Mandanten
 *     ist die Action ein No-Op mit Fehler. ADR-014 (Stufe-1-Pflicht beim Abstimmen)
 *     bleibt damit überall UNANGETASTET: auch Demo-Stimmen hängen an einem Konto mit
 *     Session; nur die KONTO-ERZEUGUNG ist auf der Spielwiese reibungsfrei.
 *   - Missbrauchsdeckel (fail-closed): IP-Rate-Limit (rate_limit_events, scope
 *     "demo_session") + globaler 24-h-Cap auf Demo-Konten je Tenant. Ohne Deckel
 *     wäre das eine offene Schreib-API (jede Anfrage = users-Zeile).
 *   - Demo-Konten sind synthetisch und markiert: E-Mail `demo-<token>@demo.invalid`
 *     (RFC-2606-TLD, nie zustellbar), notifyNewPolls=false (es geht NIE Mail an sie
 *     raus), kurze Session (12 h). Der nächtliche Reset (scripts/demo-reset.ts)
 *     löscht Konten samt Sessions (CASCADE) und die Spielwiesen-Stimmen.
 *   - minAgeConfirmedAt wird gesetzt: BEWUSSTE Demo-Ausnahme. Die 16+-Selbst-
 *     erklärung schützt echte Teilnahme; auf der Spielwiese gibt es keine echte
 *     Teilnahme (fiktive Fragen, nächtlicher Reset, Banner). Ohne das Feld wäre
 *     das Demo-Konto Stufe 0 und könnte den Kernmoment (abstimmen → Beleg) nicht
 *     zeigen. Gilt — wie alles hier — nur auf dem Demo-Mandanten.
 *   - Audit PII-frei (demo.session_created, actorRef = User-UUID).
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq, gt, like, sql } from "drizzle-orm";
import { count } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { users, sessions, roles, auditEvents, rateLimitEvents } from "@/db/schema";
import { generateRawToken, sha256Hex, hmacRateLimit } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getTenantFromHost } from "@/lib/tenant";
import { getClientIp, databaseUrl } from "@/lib/auth/action-context";
import { getUserRoleTypes, isAdmin } from "@/lib/auth/roles";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { isDemoTenant, DEMO_EMAIL_DOMAIN } from "@/lib/demo/config";

const DEMO_SESSION_TTL_HOURS = 12; // Reset läuft nächtlich — kurz halten.
const IP_WINDOW_MIN = 15;
const IP_MAX_SESSIONS = 5; // je IP und Viertelstunde
const DAILY_CAP = 500; // Demo-Konten je Tenant und 24 h (globaler Notdeckel)

// Deckel der VERWALTUNGS-Perspektive — bewusst STRENGER als die Bürger-Session:
// jedes Konto erhält eine echte kommune_admin-Rolle (Admin-Fläche = größere
// Angriffsfläche: Composer, Lebenszyklus, QR-Erzeugung). Die Side-Effect-Fences
// kappen die Außenwirkung, aber weniger Wegwerf-Admins = weniger Spielraum.
const ADMIN_IP_MAX_SESSIONS = 3; // je IP und Viertelstunde
const ADMIN_DAILY_CAP = 100; // Verwaltungs-Konten je Tenant und 24 h
const ADMIN_EMAIL_PREFIX = "demo-verwaltung-"; // unterscheidet Admin- von Bürger-Konten

export interface DemoSessionResult {
  ok: boolean;
  error?: string;
}

/**
 * Erzeugt ein ephemeres Demo-Konto (Stufe 1) + Session-Cookie — NUR auf dem
 * Demo-Mandanten. Idempotent: existiert bereits eine gültige Session, kein
 * neues Konto. Der Aufrufer (PollMitmachen im Demo-Modus) stimmt danach über
 * den normalen, unveränderten abstimmen()-Pfad ab.
 */
export async function demoSessionStarten(): Promise<DemoSessionResult> {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return { ok: false, error: "Diese Seite ist nicht erreichbar." };

  // HARTES Gate: nur der Demo-Mandant. Kein Client-Input, nur Host-Auflösung.
  if (!isDemoTenant(tenant.slug)) {
    return { ok: false, error: "Diese Funktion gibt es nur auf der Demo." };
  }

  const db = createDb(databaseUrl());

  // Idempotenz: gültige Session vorhanden → nichts zu tun.
  const cookieStore = await cookies();
  const existingRaw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (existingRaw) {
    const rows = await db
      .select({ revokedAt: sessions.revokedAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, sha256Hex(existingRaw)),
          eq(sessions.tenantId, tenant.id),
        ),
      )
      .limit(1);
    const s = rows[0];
    if (s && !s.revokedAt && s.expiresAt >= new Date()) return { ok: true };
  }

  // --- Missbrauchsdeckel 1: IP-Rate-Limit (Muster lib/auth/rate-limit) ---
  // getClientIp() (lib/client-ip.ts, seit PR #19) nimmt das LETZTE
  // x-forwarded-for-Element — das einzige, das Traefik als vertrauenswürdiger
  // Proxy selbst anhängt; client-gelieferte linke Einträge sind fälschbar.
  // Voraussetzung bleibt, dass der App-Port 3000 nicht direkt erreichbar ist.
  // Ohne IP greift NUR der 24-h-Cap unten.
  const ip = await getClientIp();
  if (ip) {
    const keyHash = hmacRateLimit(ip);
    await db.insert(rateLimitEvents).values([{ scope: "demo_session", keyHash }]);
    const since = new Date(Date.now() - IP_WINDOW_MIN * 60 * 1000);
    const n = await db
      .select({ n: count() })
      .from(rateLimitEvents)
      .where(
        and(
          eq(rateLimitEvents.scope, "demo_session"),
          eq(rateLimitEvents.keyHash, keyHash),
          gt(rateLimitEvents.createdAt, since),
        ),
      );
    if ((n[0]?.n ?? 0) > IP_MAX_SESSIONS) {
      return {
        ok: false,
        error: "Zu viele Demo-Starts in kurzer Zeit. Bitte versuchen Sie es später erneut.",
      };
    }
  }

  // --- Missbrauchsdeckel 2: globaler 24-h-Cap ---
  // NOTDECKEL, bewusst nicht atomar (check-then-insert ohne Lock): unter
  // Parallellast leicht überschreitbar, und der nächtliche Reset leert die
  // Zählbasis (effektiv ~2×DAILY_CAP über die Reset-Grenze). Er begrenzt die
  // Größenordnung (3 Zeilen je Konto), ersetzt aber keine exakte Quote
  // (Gate-B MINOR-2 — für eine Spielwiese ausreichend).
  const capRows = await db
    .select({ n: count() })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenant.id),
        like(users.email, `%@${DEMO_EMAIL_DOMAIN}`),
        gt(users.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  if ((capRows[0]?.n ?? 0) >= DAILY_CAP) {
    return {
      ok: false,
      error: "Die Demo ist gerade stark ausgelastet. Bitte versuchen Sie es später erneut.",
    };
  }

  // --- Demo-Konto + Session (kurzlebig) ---
  const emailToken = generateRawToken().slice(0, 16).toLowerCase();
  const email = `demo-${emailToken}@${DEMO_EMAIL_DOMAIN}`;
  const rawSessionToken = generateRawToken();
  const expiresAt = new Date(Date.now() + DEMO_SESSION_TTL_HOURS * 60 * 60 * 1000);

  const created = await db.transaction(async (tx: Db) => {
    const [user] = await tx
      .insert(users)
      .values({
        tenantId: tenant.id,
        email,
        // Demo-Ausnahme (siehe Kopfkommentar): synthetisches Konto, Stufe 1.
        minAgeConfirmedAt: new Date(),
        // NIE Mail an synthetische Adressen (Versand-Schutz zusätzlich zur .invalid-TLD).
        notifyNewPolls: false,
      })
      .returning({ id: users.id });

    await tx.insert(sessions).values({
      tenantId: tenant.id,
      userId: user.id,
      tokenHash: sha256Hex(rawSessionToken),
      expiresAt,
    });

    await tx.insert(auditEvents).values({
      tenantId: tenant.id,
      actorType: "user",
      actorRef: user.id,
      action: "demo.session_created",
      metadata: { tenant: tenant.slug },
    });

    return user;
  });
  if (!created) return { ok: false, error: "Demo-Start fehlgeschlagen." };

  cookieStore.set(SESSION_COOKIE_NAME, rawSessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    secure: process.env.NODE_ENV === "production",
  });

  return { ok: true };
}

/**
 * Erzeugt ein ephemeres VERWALTUNGS-Konto (kommune_admin) + Session-Cookie —
 * NUR auf dem Demo-Mandanten (Perspektiv-Umschalter des Demo-Rundgangs,
 * ONBOARDING-Spec Teil 1 §1: hands-on Frage erstellen → aktivieren → schließen).
 *
 * SICHERHEITS-KERN (zusätzlich zum Kopfkommentar der Datei):
 *   - Die Rolle ist IMMER kommune_admin, NIEMALS super_admin — die
 *     Eskalationsgrenze (canManageRole) bleibt damit auch auf der Spielwiese
 *     intakt; Reserve-Rollen sind unerreichbar.
 *   - Echte Außenwirkung verhindern NICHT diese Rolle, sondern die
 *     Side-Effect-Fences (digest/actions, polls/actions, invitation-actions):
 *     isDemoTenant ⇒ keine Kanal-Posts, keine Benachrichtigungs-/Einladungs-Mails.
 *   - Strengere Deckel als die Bürger-Session (eigener Scope
 *     "demo_admin_session", 3/15 min je IP, 100/24 h) — Admin-Fläche.
 *   - Der nächtliche Reset löscht die Konten (@demo.invalid, Rollen/Sessions
 *     CASCADE) UND ihre Spielstände (Nicht-Seed-Polls, QR-Codes).
 *
 * Idempotenz: besteht bereits eine gültige Session, deren User Admin im
 * Demo-Tenant ist → ok ohne Neuanlage. Eine BÜRGER-Demo-Session wird durch die
 * neue Verwaltungs-Session ersetzt (Cookie überschrieben; die alte Session
 * verwaist bewusst — TTL 12 h bzw. der nächtliche Reset räumen sie ab).
 */
export async function demoVerwaltungStarten(): Promise<DemoSessionResult> {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return { ok: false, error: "Diese Seite ist nicht erreichbar." };

  // HARTES Gate: nur der Demo-Mandant. Kein Client-Input, nur Host-Auflösung.
  if (!isDemoTenant(tenant.slug)) {
    return { ok: false, error: "Diese Funktion gibt es nur auf der Demo." };
  }

  const db = createDb(databaseUrl());

  // Idempotenz: gültige Session, deren Konto bereits Admin ist → nichts zu tun.
  // Eine gültige BÜRGER-Session fällt hier durch und wird unten ersetzt.
  const cookieStore = await cookies();
  const existingRaw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (existingRaw) {
    const rows = await db
      .select({
        userId: sessions.userId,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, sha256Hex(existingRaw)),
          eq(sessions.tenantId, tenant.id),
        ),
      )
      .limit(1);
    const s = rows[0];
    if (s && !s.revokedAt && s.expiresAt >= new Date()) {
      const roleTypes = await getUserRoleTypes(db, tenant.id, s.userId);
      if (isAdmin(roleTypes)) return { ok: true };
    }
  }

  // --- Missbrauchsdeckel 1: IP-Rate-Limit (eigener Scope, strenger) ---------
  // Gleiche IP-Semantik wie demoSessionStarten (letztes x-forwarded-for-Element
  // vom eigenen Proxy). Eigener Scope, damit Bürger-Demo-Starts den Admin-Deckel
  // nicht auffüllen und umgekehrt.
  const ip = await getClientIp();
  if (ip) {
    const keyHash = hmacRateLimit(ip);
    await db.insert(rateLimitEvents).values([{ scope: "demo_admin_session", keyHash }]);
    const since = new Date(Date.now() - IP_WINDOW_MIN * 60 * 1000);
    const n = await db
      .select({ n: count() })
      .from(rateLimitEvents)
      .where(
        and(
          eq(rateLimitEvents.scope, "demo_admin_session"),
          eq(rateLimitEvents.keyHash, keyHash),
          gt(rateLimitEvents.createdAt, since),
        ),
      );
    if ((n[0]?.n ?? 0) > ADMIN_IP_MAX_SESSIONS) {
      return {
        ok: false,
        error: "Zu viele Demo-Starts in kurzer Zeit. Bitte versuchen Sie es später erneut.",
      };
    }
  }

  // --- Missbrauchsdeckel 2: globaler 24-h-Cap (nur Verwaltungs-Konten) ------
  // Gleicher NOTDECKEL-Charakter wie in demoSessionStarten (nicht atomar);
  // gezählt werden nur die am E-Mail-Präfix erkennbaren Verwaltungs-Konten.
  const capRows = await db
    .select({ n: count() })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenant.id),
        like(users.email, `${ADMIN_EMAIL_PREFIX}%@${DEMO_EMAIL_DOMAIN}`),
        gt(users.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  if ((capRows[0]?.n ?? 0) >= ADMIN_DAILY_CAP) {
    return {
      ok: false,
      error: "Die Demo ist gerade stark ausgelastet. Bitte versuchen Sie es später erneut.",
    };
  }

  // Rollen brauchen einen Gebietsknoten: der Demo-Admin wirkt stadtweit
  // (Gemeinde-Knoten). Fehlt der Baum (Seed nicht gelaufen), lieber freundlich
  // scheitern als still einen Knoten anzulegen (region_provision-GUC greift
  // in Produktion nie).
  let stadtRegionId: string;
  try {
    stadtRegionId = await resolveRegionIdForScope(db, tenant.id, "stadt", null);
  } catch {
    return { ok: false, error: "Demo-Start fehlgeschlagen — bitte später erneut versuchen." };
  }

  // --- Verwaltungs-Konto + kommune_admin-Rolle + Session (kurzlebig) --------
  const emailToken = generateRawToken().slice(0, 16).toLowerCase();
  const email = `${ADMIN_EMAIL_PREFIX}${emailToken}@${DEMO_EMAIL_DOMAIN}`;
  const rawSessionToken = generateRawToken();
  const expiresAt = new Date(Date.now() + DEMO_SESSION_TTL_HOURS * 60 * 60 * 1000);

  const created = await db.transaction(async (tx: Db) => {
    const [user] = await tx
      .insert(users)
      .values({
        tenantId: tenant.id,
        email,
        // Demo-Ausnahme (siehe Kopfkommentar der Datei): synthetisch, Stufe 1.
        minAgeConfirmedAt: new Date(),
        // NIE Mail an synthetische Adressen.
        notifyNewPolls: false,
      })
      .returning({ id: users.id });

    // NIEMALS super_admin: kommune_admin reicht für den kompletten Hands-on-
    // Track (Composer, Aktivieren, Schließen, Rollen-Ansicht) und hält die
    // Eskalationsgrenze intakt.
    await tx.insert(roles).values({
      tenantId: tenant.id,
      userId: user.id,
      roleType: "kommune_admin",
      regionId: stadtRegionId,
    });

    await tx.insert(sessions).values({
      tenantId: tenant.id,
      userId: user.id,
      tokenHash: sha256Hex(rawSessionToken),
      expiresAt,
    });

    // PII-frei (actorRef = User-UUID; die E-Mail ist ohnehin synthetisch).
    await tx.insert(auditEvents).values({
      tenantId: tenant.id,
      actorType: "user",
      actorRef: user.id,
      action: "demo.admin_session_created",
      metadata: { tenant: tenant.slug },
    });

    return user;
  });
  if (!created) return { ok: false, error: "Demo-Start fehlgeschlagen." };

  cookieStore.set(SESSION_COOKIE_NAME, rawSessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    secure: process.env.NODE_ENV === "production",
  });

  return { ok: true };
}
