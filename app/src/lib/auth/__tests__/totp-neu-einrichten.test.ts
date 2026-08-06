/**
 * totp-neu-einrichten.test.ts — Gerätewechsel und Sicherheits-Benachrichtigungen
 * (Review #59, Befunde 1 und 3).
 *
 * Getestet werden die ECHTEN Server Actions aus lib/auth/totp-actions.ts (Muster
 * demo-fence.test.ts: next/headers, @/lib/tenant und @/db/client gemockt,
 * Session/Nutzer real in der Test-DB). Gemockt ist zusätzlich @/lib/auth/mail —
 * der Versand selbst ist hier nicht der Prüfgegenstand, sondern DASS und MIT
 * WELCHEM Ereignis er ausgelöst wird. Die Textbausteine prüft
 * totp-benachrichtigung.test.ts ohne DB.
 *
 * Geprüfte Eigenschaften:
 *   1. zweitFaktorNeuEinrichten verlangt eine FRISCHE Bestätigung — ohne
 *      totp_verified_at und mit zu altem Zeitstempel bleibt alles unverändert.
 *   2. Mit frischer Bestätigung: Secret/Bestätigung/Zeitschritt auf NULL, alle
 *      Wiederherstellungscodes des Kontos weg, Audit-Eintrag PII-frei.
 *   3. TENANT-FILTER: Eine Codezeile desselben Nutzers, die auf einen FREMDEN
 *      Mandanten zeigt, überlebt — die Löschung ist tenant-gefiltert.
 *   4. Ohne aktives TOTP: klare Absage statt stillem Erfolg.
 *   5. Danach läuft der reguläre Weg (starteEinrichtung) wieder.
 *   6. Benachrichtigung bei Aktivierung, Wiederherstellung und Neu-Einrichtung;
 *      ein Mailfehler lässt die Aktion NICHT scheitern (best effort).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst skip).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";
import {
  encryptTotpSecret,
  generateTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  totpCode,
} from "@/lib/auth/totp";
import { STEP_UP_MAX_ALTER_MINUTEN } from "@/lib/auth/zwei-faktor";

const { tenants, users, sessions, totpRecoveryCodes, auditEvents } = schema;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");

const TEST_DB_URL = process.env.DATABASE_URL_TEST;
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test"`);
  }
}
const SKIP = !TEST_DB_URL;

type DbType = ReturnType<typeof drizzle>;

// --- Mocks für den Request-Kontext + die Mail-Senke -------------------------
const mockHost = "test.localhost";
let mockSessionToken: string | null = null;
let mockTenantRow: { id: string; slug: string; name: string } | null = null;
let mockDbForActions: DbType | null = null;

vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => (k === "host" ? mockHost : null) }),
  cookies: () => ({
    get: (name: string) =>
      name === "partizip_session" && mockSessionToken ? { value: mockSessionToken } : undefined,
    set: () => {},
  }),
}));

vi.mock("@/lib/tenant", () => ({
  getTenantFromHost: async () => mockTenantRow,
}));

vi.mock("@/db/client", () => ({
  createDb: () => mockDbForActions,
}));

const sendZweiFaktorAenderungEmailMock = vi.hoisted(() =>
  vi.fn<
    (email: string, ereignis: string, zeitpunkt: Date, kontaktEmail: string) => Promise<void>
  >()
);
vi.mock("@/lib/auth/mail", () => ({
  sendZweiFaktorAenderungEmail: sendZweiFaktorAenderungEmailMock,
}));

describe("totp: Gerätewechsel + Benachrichtigungen (Integration, echte Actions)", () => {
  let sql_: postgres.Sql;
  let db: DbType;

  let tenant: { id: string; slug: string; name: string };
  let fremderTenant: { id: string; slug: string; name: string };
  let nutzerId: string;

  let counter = 0;
  const next = (p: string) => `${p}-${Date.now()}-${++counter}`;

  let starteEinrichtung: typeof import("@/lib/auth/totp-actions").starteEinrichtung;
  let bestaetigeEinrichtung: typeof import("@/lib/auth/totp-actions").bestaetigeEinrichtung;
  let loeseWiederherstellungscodeEin: typeof import("@/lib/auth/totp-actions").loeseWiederherstellungscodeEin;
  let zweitFaktorNeuEinrichten: typeof import("@/lib/auth/totp-actions").zweitFaktorNeuEinrichten;

  /** Legt eine gültige Session an und macht sie zur „aktuellen" (Cookie-Mock). */
  async function anmelden(opts: { totpVerifiedAt?: Date | null } = {}): Promise<string> {
    const rawToken = `tok-${Date.now()}-${++counter}`;
    const [s] = await db
      .insert(sessions)
      .values({
        tenantId: tenant.id,
        userId: nutzerId,
        tokenHash: sha256Hex(rawToken),
        expiresAt: new Date(Date.now() + 3_600_000),
        totpVerifiedAt: opts.totpVerifiedAt ?? null,
      })
      .returning({ id: sessions.id });
    mockSessionToken = rawToken;
    return s.id;
  }

  /** Versetzt das Konto in „TOTP aktiv" mit `anzahl` offenen Codes. */
  async function totpAktivieren(anzahl = 3): Promise<{ secret: string; codes: string[] }> {
    const secret = generateTotpSecret();
    await db
      .update(users)
      .set({
        totpSecretEnc: encryptTotpSecret(secret),
        totpConfirmedAt: new Date(),
        totpLastStep: null,
      })
      .where(eq(users.id, nutzerId));
    await db
      .delete(totpRecoveryCodes)
      .where(eq(totpRecoveryCodes.userId, nutzerId));
    const codes = generateRecoveryCodes(anzahl);
    await db.insert(totpRecoveryCodes).values(
      codes.map((c) => ({ userId: nutzerId, tenantId: tenant.id, codeHash: hashRecoveryCode(c) }))
    );
    return { secret, codes };
  }

  async function nutzerZeile() {
    const [u] = await db.select().from(users).where(eq(users.id, nutzerId));
    return u;
  }

  async function offeneCodes(tenantId: string) {
    return db
      .select({ id: totpRecoveryCodes.id })
      .from(totpRecoveryCodes)
      .where(
        and(eq(totpRecoveryCodes.userId, nutzerId), eq(totpRecoveryCodes.tenantId, tenantId))
      );
  }

  beforeAll(async () => {
    if (SKIP) return;

    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_, { schema });
    await migrate(db, { migrationsFolder });
    mockDbForActions = db;

    const [t] = await db
      .insert(tenants)
      .values({ slug: next("totp"), name: "TOTP-Mandant" })
      .returning();
    tenant = { id: t.id, slug: t.slug, name: t.name };
    const [ft] = await db
      .insert(tenants)
      .values({ slug: next("totp-fremd"), name: "Fremder Mandant" })
      .returning();
    fremderTenant = { id: ft.id, slug: ft.slug, name: ft.name };
    mockTenantRow = tenant;

    const [u] = await db
      .insert(users)
      .values({
        tenantId: tenant.id,
        email: `totp-${Date.now()}@example.invalid`,
        minAgeConfirmedAt: new Date(),
      })
      .returning({ id: users.id });
    nutzerId = u.id;

    // Echte Actions erst NACH gesetzten Mocks laden.
    const actions = await import("@/lib/auth/totp-actions");
    starteEinrichtung = actions.starteEinrichtung;
    bestaetigeEinrichtung = actions.bestaetigeEinrichtung;
    loeseWiederherstellungscodeEin = actions.loeseWiederherstellungscodeEin;
    zweitFaktorNeuEinrichten = actions.zweitFaktorNeuEinrichten;
  });

  afterAll(async () => {
    if (SKIP) return;
    await sql_.end();
  });

  beforeEach(async () => {
    if (SKIP) return;
    sendZweiFaktorAenderungEmailMock.mockClear();
    sendZweiFaktorAenderungEmailMock.mockImplementation(async () => {});
    mockTenantRow = tenant;
    mockSessionToken = null;
    // Rate-Limit-Spuren zwischen den Fällen entfernen (5 Versuche / 15 min).
    await db.delete(schema.rateLimitEvents);
  });

  it.skipIf(SKIP)("verlangt eine Anmeldung", async () => {
    mockSessionToken = null;
    const r = await zweitFaktorNeuEinrichten();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("melden Sie sich an");
  });

  it.skipIf(SKIP)("lehnt ab, wenn gar kein zweiter Faktor eingerichtet ist", async () => {
    await db
      .update(users)
      .set({ totpSecretEnc: null, totpConfirmedAt: null, totpLastStep: null })
      .where(eq(users.id, nutzerId));
    await anmelden({ totpVerifiedAt: new Date() });

    const r = await zweitFaktorNeuEinrichten();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("keine Zwei-Faktor-Authentisierung");
    expect(sendZweiFaktorAenderungEmailMock).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)("lehnt ohne Bestätigung in dieser Session ab und ändert nichts", async () => {
    await totpAktivieren(3);
    await anmelden({ totpVerifiedAt: null });

    const r = await zweitFaktorNeuEinrichten();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Einmalcode");

    const u = await nutzerZeile();
    expect(u.totpSecretEnc).not.toBeNull();
    expect(u.totpConfirmedAt).not.toBeNull();
    expect(await offeneCodes(tenant.id)).toHaveLength(3);
    expect(sendZweiFaktorAenderungEmailMock).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)("lehnt ab, wenn die Bestätigung zu alt ist", async () => {
    await totpAktivieren(3);
    const zuAlt = new Date(Date.now() - (STEP_UP_MAX_ALTER_MINUTEN + 1) * 60_000);
    await anmelden({ totpVerifiedAt: zuAlt });

    const r = await zweitFaktorNeuEinrichten();
    expect(r.ok).toBe(false);
    const u = await nutzerZeile();
    expect(u.totpConfirmedAt).not.toBeNull();
    expect(await offeneCodes(tenant.id)).toHaveLength(3);
  });

  it.skipIf(SKIP)(
    "setzt mit frischer Bestätigung zurück: Felder NULL, Codes weg, Audit PII-frei",
    async () => {
      await totpAktivieren(3);
      await db.update(users).set({ totpLastStep: 12345 }).where(eq(users.id, nutzerId));
      // Codezeile desselben Nutzers, die auf einen FREMDEN Mandanten zeigt:
      // Sie darf die tenant-gefilterte Löschung überleben.
      await db.insert(totpRecoveryCodes).values({
        userId: nutzerId,
        tenantId: fremderTenant.id,
        codeHash: hashRecoveryCode("FREMD-CODE1"),
      });
      await anmelden({ totpVerifiedAt: new Date() });

      const r = await zweitFaktorNeuEinrichten();
      expect(r.ok).toBe(true);

      const u = await nutzerZeile();
      expect(u.totpSecretEnc).toBeNull();
      expect(u.totpConfirmedAt).toBeNull();
      expect(u.totpLastStep).toBeNull();
      // Die Kulanzfrist bleibt unangetastet — kein geschenkter Freifahrtschein.
      expect(u.totpGraceUntil).toBeNull();

      expect(await offeneCodes(tenant.id)).toHaveLength(0);
      expect(await offeneCodes(fremderTenant.id)).toHaveLength(1);

      const [ereignis] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, tenant.id),
            eq(auditEvents.action, "auth.totp_neu_einrichtung")
          )
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      expect(ereignis).toBeDefined();
      expect(ereignis.actorRef).toBe(nutzerId);
      expect(JSON.stringify(ereignis.metadata ?? {})).not.toContain("@");

      expect(sendZweiFaktorAenderungEmailMock).toHaveBeenCalledTimes(1);
      expect(sendZweiFaktorAenderungEmailMock.mock.calls[0][1]).toBe("neu_eingerichtet");

      // Aufräumen für die folgenden Fälle.
      await db
        .delete(totpRecoveryCodes)
        .where(eq(totpRecoveryCodes.tenantId, fremderTenant.id));
    }
  );

  it.skipIf(SKIP)("ein zweiter Aufruf findet nichts mehr zurückzusetzen", async () => {
    await totpAktivieren(2);
    await anmelden({ totpVerifiedAt: new Date() });

    expect((await zweitFaktorNeuEinrichten()).ok).toBe(true);
    const zweiter = await zweitFaktorNeuEinrichten();
    expect(zweiter.ok).toBe(false);
  });

  it.skipIf(SKIP)("danach läuft der reguläre Einrichtungsweg wieder", async () => {
    await totpAktivieren(2);
    await anmelden({ totpVerifiedAt: new Date() });
    expect((await zweitFaktorNeuEinrichten()).ok).toBe(true);

    const start = await starteEinrichtung();
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.uri).toContain("otpauth://totp/");

    const bestaetigt = await bestaetigeEinrichtung(totpCode(start.secret));
    expect(bestaetigt.ok).toBe(true);
    if (!bestaetigt.ok) return;
    expect(bestaetigt.wiederherstellungscodes).toHaveLength(10);

    // Befund 3: die Aktivierung meldet sich beim Kontoinhaber.
    const ereignisse = sendZweiFaktorAenderungEmailMock.mock.calls.map((c) => c[1]);
    expect(ereignisse).toContain("aktiviert");
  });

  it.skipIf(SKIP)("meldet die Einlösung eines Wiederherstellungscodes", async () => {
    const { codes } = await totpAktivieren(3);
    await anmelden({ totpVerifiedAt: null });

    const r = await loeseWiederherstellungscodeEin(codes[0]);
    expect(r.ok).toBe(true);
    expect(sendZweiFaktorAenderungEmailMock).toHaveBeenCalledTimes(1);
    expect(sendZweiFaktorAenderungEmailMock.mock.calls[0][1]).toBe("wiederherstellungscode");
  });

  it.skipIf(SKIP)("ein Mailfehler lässt die Aktion nicht scheitern (best effort)", async () => {
    sendZweiFaktorAenderungEmailMock.mockImplementation(async () => {
      throw new Error("SMTP kaputt");
    });
    await totpAktivieren(2);
    await anmelden({ totpVerifiedAt: new Date() });

    const r = await zweitFaktorNeuEinrichten();
    expect(r.ok).toBe(true);
    const u = await nutzerZeile();
    expect(u.totpConfirmedAt).toBeNull();
  });
});
