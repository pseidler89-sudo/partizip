/**
 * email-change.test.ts — DB-Integrationstest E-Mail-Änderung (Block J2b).
 *
 * Ruft die ECHTEN Kern-Funktionen (email-change-core.ts) direkt gegen ein
 * ephemeres PG16 auf (Muster: konto-loeschen.test.ts / invitation.test.ts).
 * Mailversand als Callback-Spy (der Kern ruft die übergebene Funktion; die
 * Action verdrahtet den echten SMTP-Versand).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst geskippt).
 *
 * Abgedeckte Eigenschaften (Spec-Testkatalog):
 *   Anfordern: neutrale Antwort bei freier UND besetzter Ziel-Adresse
 *     (Discriminant identisch), keine Mail bei besetzt, Demo-Fence, Rate-Limit,
 *     neu==alt → kein Token, ungültige Adresse → kein Token.
 *   Bestätigen: Erfolg (kanonischer Wechsel + Info-Mail + alte Login-Tokens
 *     invalide + Audit PII-frei), single-use, fremder/falscher Session-User,
 *     abgelaufen, 23505-Race (Token konsumiert), gesperrtes Konto, Demo-Fence.
 *   Pseudonym-Stabilität: creator_ref (hasht user_id) vor/nach identisch.
 *   Migration: user_id-Spalte + FK CASCADE (echtes users-DELETE räumt Token ab).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, count } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";
import { computeCreatorRefWithSalt } from "@/lib/anliegen/creator-ref";
import {
  emailAenderungAnfordernCore,
  emailAenderungBestaetigenCore,
  emailAenderungPruefenCore,
  EMAIL_CHANGE_PURPOSE,
} from "@/lib/konto/email-change-core";

const { tenants, users, authTokens, auditEvents } = schema;

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
const skipMsg = "DATABASE_URL_TEST nicht gesetzt";

type DbType = ReturnType<typeof drizzle>;

describe("E-Mail-Änderung (Integration, Block J2b)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;

  let counter = 0;
  const nextEmail = () => `j2b-${Date.now()}-${++counter}@ec-test.de`;

  /** Verschluckt einen (nie sendenden) Mail-Callback und zählt Aufrufe. */
  const bestaetigungsSpy = () => vi.fn(async (_email: string, _rawToken: string) => {});
  const infoSpy = () => vi.fn(async (_alteEmail: string) => {});

  async function seedUser(email: string, accountStatus: "active" | "locked" = "active") {
    const [u] = await db
      .insert(users)
      .values({ tenantId, email, accountStatus })
      .returning();
    return u;
  }

  async function tokenCountForUser(userId: string): Promise<number> {
    const rows = await db
      .select({ n: count() })
      .from(authTokens)
      .where(and(eq(authTokens.tenantId, tenantId), eq(authTokens.userId, userId)));
    return rows[0]?.n ?? 0;
  }

  async function currentEmail(userId: string): Promise<string> {
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]!.email;
  }

  beforeAll(async () => {
    if (SKIP) return;
    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [t] = await db
      .insert(tenants)
      .values({ slug: `ec-${Date.now()}`, name: "EmailChange-Test" })
      .returning();
    tenantId = t.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  // -------------------------------------------------------------------------
  // Anfordern
  // -------------------------------------------------------------------------

  it("Anfordern: freie Ziel-Adresse → neutral, Token angelegt, Bestätigungs-Mail", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const neu = nextEmail();
    const mail = bestaetigungsSpy();

    const res = await emailAenderungAnfordernCore(db, {
      tenantId,
      userId: user.id,
      neueEmailRaw: neu,
      istDemo: false,
      ipAddress: "203.0.113.5",
      sendBestaetigungsMail: mail,
    });

    expect(res).toEqual({ kind: "neutral", mailVersendet: true });
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][0]).toBe(neu);
    const rawToken = mail.mock.calls[0][1];
    // Token liegt gehasht in der DB, purpose + user_id korrekt.
    const rows = await db
      .select()
      .from(authTokens)
      .where(eq(authTokens.tokenHash, sha256Hex(rawToken)))
      .limit(1);
    expect(rows[0]?.purpose).toBe(EMAIL_CHANGE_PURPOSE);
    expect(rows[0]?.userId).toBe(user.id);
    expect(rows[0]?.email).toBe(neu);
  });

  it("Anfordern: besetzte Ziel-Adresse → neutral OHNE Mail; DB-Writes identisch zum Frei-Fall (Timing-Invariante)", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const belegt = nextEmail();
    await seedUser(belegt); // Ziel-Adresse bereits vergeben
    const mail = bestaetigungsSpy();

    const res = await emailAenderungAnfordernCore(db, {
      tenantId,
      userId: user.id,
      neueEmailRaw: belegt,
      istDemo: false,
      ipAddress: null,
      sendBestaetigungsMail: mail,
    });

    // Nach außen identisch zum Erfolgsfall (kein Adress-Oracle): kind === 'neutral'.
    expect(res.kind).toBe("neutral");
    expect(res).toEqual({ kind: "neutral", mailVersendet: false });
    expect(mail).not.toHaveBeenCalled();

    // Gate-B MAJOR (Timing-Oracle): der vergeben-Zweig macht EXAKT dieselben
    // DB-Writes wie der Frei-Fall — Token-Zeile UND Audit-Event existieren,
    // OHNE dass eine Mail rausging (der Token erreicht mangels Mail niemanden).
    expect(await tokenCountForUser(user.id)).toBe(1);
    const tok = await db
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tenantId, tenantId), eq(authTokens.userId, user.id)));
    expect(tok[0]?.purpose).toBe(EMAIL_CHANGE_PURPOSE);
    expect(tok[0]?.consumedAt).toBeNull();
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.action, "konto.email_change_requested"),
          eq(auditEvents.actorRef, user.id),
        ),
      );
    expect(audits.length).toBe(1);
    // Audit unterscheidet frei/vergeben NICHT (sonst wäre es selbst ein Orakel).
    expect(audits[0]?.metadata).toEqual({});
  });

  it("Anfordern: Token aus dem vergeben-Zweig landet beim Konsum im 23505-Pfad ('taken')", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const belegt = nextEmail();
    await seedUser(belegt);

    const res = await emailAenderungAnfordernCore(db, {
      tenantId,
      userId: user.id,
      neueEmailRaw: belegt,
      istDemo: false,
      ipAddress: null,
      sendBestaetigungsMail: bestaetigungsSpy(),
    });
    expect(res).toEqual({ kind: "neutral", mailVersendet: false });

    // Der Roh-Token ist unbekannt (es ging keine Mail raus) — für den Test den
    // Hash auf einen bekannten Wert setzen und den Konsum-Pfad durchspielen:
    // der funktionale Unique-Index fängt die vergebene Adresse ab ('taken'),
    // der Token ist danach konsumiert (kein Retry-Oracle).
    const rows = await db
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tenantId, tenantId), eq(authTokens.userId, user.id)));
    expect(rows.length).toBe(1);
    const raw = `raw-taken-${Date.now()}-${counter}`;
    await db
      .update(authTokens)
      .set({ tokenHash: sha256Hex(raw) })
      .where(eq(authTokens.id, rows[0]!.id));

    const konsum = await emailAenderungBestaetigenCore(db, {
      tenantId,
      sessionUserId: user.id,
      tokenRaw: raw,
      istDemo: false,
      sendInfoMailAnAlt: infoSpy(),
    });
    expect(konsum.kind).toBe("taken");
    expect(await currentEmail(user.id)).not.toBe(belegt);
  });

  it("Anfordern: neu == alt (normalisiert) → 'same', kein Token, keine Mail", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const email = nextEmail();
    const user = await seedUser(email);
    const mail = bestaetigungsSpy();

    const res = await emailAenderungAnfordernCore(db, {
      tenantId,
      userId: user.id,
      neueEmailRaw: `  ${email.toUpperCase()}  `, // gleiche Adresse, andere Schreibung
      istDemo: false,
      ipAddress: null,
      sendBestaetigungsMail: mail,
    });

    expect(res).toEqual({ kind: "same" });
    expect(mail).not.toHaveBeenCalled();
    expect(await tokenCountForUser(user.id)).toBe(0);
  });

  it("Anfordern: ungültige Ziel-Adresse → 'invalid', kein Token", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const mail = bestaetigungsSpy();

    const res = await emailAenderungAnfordernCore(db, {
      tenantId,
      userId: user.id,
      neueEmailRaw: "kein-at-zeichen",
      istDemo: false,
      ipAddress: null,
      sendBestaetigungsMail: mail,
    });

    expect(res).toEqual({ kind: "invalid" });
    expect(mail).not.toHaveBeenCalled();
    expect(await tokenCountForUser(user.id)).toBe(0);
  });

  it("Anfordern: Demo-Fence (fail-closed) → 'demo_blocked', kein Token, keine Mail", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const mail = bestaetigungsSpy();

    const res = await emailAenderungAnfordernCore(db, {
      tenantId,
      userId: user.id,
      neueEmailRaw: nextEmail(),
      istDemo: true,
      ipAddress: "203.0.113.9",
      sendBestaetigungsMail: mail,
    });

    expect(res).toEqual({ kind: "demo_blocked" });
    expect(mail).not.toHaveBeenCalled();
    expect(await tokenCountForUser(user.id)).toBe(0);
  });

  it("Anfordern: Rate-Limit (pro User) greift beim 4. Versuch", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const mail = bestaetigungsSpy();

    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await emailAenderungAnfordernCore(db, {
        tenantId,
        userId: user.id,
        neueEmailRaw: nextEmail(), // jeweils freie Adresse → sonst kein RL-Test
        istDemo: false,
        ipAddress: null,
        sendBestaetigungsMail: mail,
      });
      outcomes.push(r.kind);
    }

    expect(outcomes.slice(0, 3)).toEqual(["neutral", "neutral", "neutral"]);
    expect(outcomes[3]).toBe("rate_limited");
    // Nur 3 Tokens angelegt (jeder invalidiert den vorigen → höchstens 1 offen,
    // aber insgesamt 3 Zeilen).
    expect(await tokenCountForUser(user.id)).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Bestätigen
  // -------------------------------------------------------------------------

  /** Legt einen offenen email_change-Token an und gibt den Roh-Token zurück. */
  async function anfordernRawToken(userId: string, neu: string): Promise<string> {
    const mail = bestaetigungsSpy();
    const r = await emailAenderungAnfordernCore(db, {
      tenantId,
      userId,
      neueEmailRaw: neu,
      istDemo: false,
      ipAddress: null,
      sendBestaetigungsMail: mail,
    });
    expect(r).toEqual({ kind: "neutral", mailVersendet: true });
    return mail.mock.calls[0][1] as string;
  }

  it("Bestätigen: Erfolg — kanonischer Wechsel, Info-Mail an ALT, alte Login-Tokens invalide, Audit PII-frei", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const alt = nextEmail();
    const user = await seedUser(alt);
    const neu = nextEmail();

    // Ein offener Login-Token an die ALTE Adresse — muss nach dem Wechsel weg sein.
    await db.insert(authTokens).values({
      tenantId,
      email: alt,
      tokenHash: `login-${Date.now()}-${counter}`,
      purpose: "login",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const raw = await anfordernRawToken(user.id, neu);
    const info = infoSpy();

    const res = await emailAenderungBestaetigenCore(db, {
      tenantId,
      sessionUserId: user.id,
      tokenRaw: raw,
      istDemo: false,
      sendInfoMailAnAlt: info,
    });

    expect(res).toEqual({ kind: "success", neueEmail: neu });
    expect(await currentEmail(user.id)).toBe(neu);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe(alt);

    // Alle offenen Tokens der ALTEN Adresse invalidiert.
    const offeneAlt = await db
      .select({ n: count() })
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tenantId, tenantId),
          eq(authTokens.email, alt),
        ),
      );
    const offeneAltUnconsumed = await sql_`
      SELECT count(*)::int AS n FROM auth_tokens
      WHERE tenant_id = ${tenantId} AND email = ${alt} AND consumed_at IS NULL`;
    expect(offeneAlt[0]?.n).toBeGreaterThan(0); // Zeilen existieren
    expect(offeneAltUnconsumed[0].n).toBe(0); // aber keine mehr offen

    // Audit PII-frei.
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.action, "konto.email_geaendert"),
          eq(auditEvents.actorRef, user.id),
        ),
      );
    expect(audits.length).toBe(1);
    const meta = JSON.stringify(audits[0]?.metadata ?? {});
    expect(meta).not.toContain(alt);
    expect(meta).not.toContain(neu);
    expect(meta).not.toContain("@");
  });

  it("Bestätigen: single-use — zweiter Konsum scheitert ('used')", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const raw = await anfordernRawToken(user.id, nextEmail());

    const r1 = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(r1.kind).toBe("success");

    const r2 = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(r2.kind).toBe("used");
  });

  it("Bestätigen: fremder Session-User → 'wrong_account', Token NICHT konsumiert", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const fremder = await seedUser(nextEmail());
    const neu = nextEmail();
    const raw = await anfordernRawToken(user.id, neu);

    const res = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: fremder.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(res.kind).toBe("wrong_account");

    // Token unversehrt → der rechtmäßige User kann noch bestätigen.
    const pruef = await emailAenderungPruefenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw,
    });
    expect(pruef).toEqual({ kind: "valid", neueEmail: neu });
  });

  it("Bestätigen: abgelaufener Token → 'expired'", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const neu = nextEmail();
    const raw = await anfordernRawToken(user.id, neu);

    // Ablauf in die Vergangenheit ziehen.
    await db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.tokenHash, sha256Hex(raw)));

    const res = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(res.kind).toBe("expired");
    expect(await currentEmail(user.id)).not.toBe(neu);
  });

  it("Bestätigen: Ziel-Adresse zwischenzeitlich vergeben → '23505'/'taken', Token konsumiert", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const neu = nextEmail();
    const raw = await anfordernRawToken(user.id, neu);

    // Race: zwischen Anforderung und Bestätigung registriert jemand die Adresse.
    await seedUser(neu);

    const res = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(res.kind).toBe("taken");
    expect(await currentEmail(user.id)).not.toBe(neu);

    // Token bleibt konsumiert (kein Retry-Oracle).
    const zweiter = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(zweiter.kind).toBe("used");
  });

  it("Bestätigen: gesperrtes Konto (locked) → 'locked'", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const alt = nextEmail();
    const user = await seedUser(alt);
    const neu = nextEmail();
    const raw = await anfordernRawToken(user.id, neu);

    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, user.id));

    const res = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(res.kind).toBe("locked");
    expect(await currentEmail(user.id)).toBe(alt);
  });

  it("MIN1: Login-Token lässt sich am email_change-Konsum NICHT einlösen (purpose hart gefiltert)", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const raw = `login-als-change-${Date.now()}-${counter}`;
    // Login-Token MIT user_id (böswilligst mögliche Konstellation: selbst wenn
    // eine userId-Bindung vorläge, darf der purpose-Filter nicht überwindbar sein).
    await db.insert(authTokens).values({
      tenantId,
      email: user.email,
      tokenHash: sha256Hex(raw),
      purpose: "login",
      userId: user.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await emailAenderungBestaetigenCore(db, {
      tenantId,
      sessionUserId: user.id,
      tokenRaw: raw,
      istDemo: false,
      sendInfoMailAnAlt: infoSpy(),
    });
    expect(res.kind).toBe("invalid");

    // Token unverbraucht (weder Diagnose-Pfad noch CAS haben ihn konsumiert) —
    // und der CAS selbst filtert purpose hart in der WHERE-Klausel:
    const { scopedDb } = await import("@/lib/db/tenant-scope");
    const scoped = scopedDb(db, tenantId);
    expect(await scoped.authTokens.consume(sha256Hex(raw), "email_change")).toBeNull();
    const nachher = await db
      .select()
      .from(authTokens)
      .where(eq(authTokens.tokenHash, sha256Hex(raw)));
    expect(nachher[0]?.consumedAt).toBeNull();
    // Richtige Richtung funktioniert weiterhin (Gegenprobe).
    expect(await scoped.authTokens.consume(sha256Hex(raw), "login")).not.toBeNull();
  });

  it("Bestätigen: Demo-Fence (fail-closed) → 'demo_blocked', Token NICHT konsumiert", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const user = await seedUser(nextEmail());
    const neu = nextEmail();
    const raw = await anfordernRawToken(user.id, neu);

    const res = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: true, sendInfoMailAnAlt: infoSpy(),
    });
    expect(res.kind).toBe("demo_blocked");

    const pruef = await emailAenderungPruefenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw,
    });
    expect(pruef.kind).toBe("valid");
  });

  // -------------------------------------------------------------------------
  // Pseudonym-Stabilität + Migration
  // -------------------------------------------------------------------------

  it("Pseudonym-Stabilität: creator_ref (hasht user_id) bleibt über den Wechsel identisch", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    const SALT = "test-ref-salt-0123456789abcdef";
    const user = await seedUser(nextEmail());
    const refVorher = computeCreatorRefWithSalt(SALT, user.id);

    const raw = await anfordernRawToken(user.id, nextEmail());
    const res = await emailAenderungBestaetigenCore(db, {
      tenantId, sessionUserId: user.id, tokenRaw: raw, istDemo: false, sendInfoMailAnAlt: infoSpy(),
    });
    expect(res.kind).toBe("success");

    const refNachher = computeCreatorRefWithSalt(SALT, user.id);
    expect(refNachher).toBe(refVorher); // hasht user_id, NICHT die E-Mail
  });

  it("Migration: auth_tokens.user_id existiert + FK ON DELETE CASCADE (echtes users-DELETE räumt Token ab)", async () => {
    if (SKIP) return console.log(`SKIP: ${skipMsg}`);
    // Spalte vorhanden.
    const cols = await sql_`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'auth_tokens' AND column_name = 'user_id'`;
    expect(cols.length).toBe(1);

    // CASCADE: ein echtes DELETE der users-Zeile reißt den Token mit.
    const user = await seedUser(nextEmail());
    await db.insert(authTokens).values({
      tenantId,
      email: nextEmail(),
      tokenHash: `cascade-${Date.now()}-${counter}`,
      purpose: EMAIL_CHANGE_PURPOSE,
      userId: user.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(await tokenCountForUser(user.id)).toBe(1);

    await db.delete(users).where(eq(users.id, user.id));
    expect(await tokenCountForUser(user.id)).toBe(0);
  });
});
