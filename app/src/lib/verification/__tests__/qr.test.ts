/**
 * qr.test.ts — DB-Integrationstests für die ECHTEN QR-Verifizierungs-Funktionen
 * (qrErstellenCore / qrWiderrufenCore / qrEinloesenCore aus qr-core.ts).
 *
 * Es wird NICHT die Logik gespiegelt — die Production-Funktionen laufen direkt
 * gegen ein ephemeres PG16 (Muster polls/__tests__/queries.test.ts). Der
 * Auth/Tenant-Kontext wird als Parameter übergeben (statt aus Cookies/Headers),
 * exakt wie in der „use server"-Action.
 *
 * Geprüfte Sicherheits-Eigenschaften (Vertrauensprodukt):
 *   - Token-Hashing: in der DB steht nur sha256Hex(token), nie der RAW-Token.
 *   - Happy-Path: Einlösen → User Stufe 2 + residencyVerifiedAt/Until + method=qr.
 *   - Ablauf abgelehnt; Widerruf abgelehnt.
 *   - Cap erschöpft → weitere Einlösungen abgelehnt.
 *   - Cap-Race: zwei parallele Einlösungen am letzten Slot → genau 1 Erfolg.
 *   - Doppel-Einlösung gleicher User → idempotent, KEIN Cap-Verbrauch.
 *   - Tenant-Isolation: Fremd-Tenant findet den Token nicht.
 *   - Ortsteil-Scope setzt users.ortsteilId; Audit PII-frei.
 *
 * next/headers wird gemockt (qr-core importiert es nicht, aber der Import-Graph
 * von @/db/schema ist neutral; der Mock schützt vor versehentlichen Pfaden).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, set: () => {} }),
  headers: () => ({ get: () => null }),
}));

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";
import { getStufe } from "@/lib/eligibility/stufe";
import {
  qrErstellenCore,
  qrWiderrufenCore,
  qrEinloesenCore,
  QrGebietError,
  QR_VERIFICATION_MONTHS,
  addMonths,
  type QrErstellerKontext,
} from "@/lib/verification/qr-core";
import { qrCodesListe, qrTokenMeta } from "@/lib/verification/queries";
import {
  erlaubteScopeEbenenFuerVerifier,
  getUserRolesMitScope,
} from "@/lib/auth/roles";
import { resolveRegionIdForScope } from "@/lib/region/scope";

const { tenants, users, roles, ortsteile, qrCodes, qrRedemptions, auditEvents } = schema;

/**
 * Gebietsbindungs-Kontext eines Admins (Block K1): unbeschränkt — entspricht
 * dem, was die Action für kommune_admin/super_admin durchreicht.
 */
const ADMIN: QrErstellerKontext = { isAdmin: true, scopes: [] };

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

describe("verification/qr (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let tenant2Id: string;
  let verifierId: string; // Ersteller (createdBy)
  let counter = 0;

  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@qr-test.de`;
  }

  async function makeUser(tId: string, opts?: { verified?: boolean }) {
    const [u] = await db
      .insert(users)
      .values({
        tenantId: tId,
        email: nextEmail("u"),
        minAgeConfirmedAt: new Date(),
        verificationStatus: opts?.verified ? "verified" : "pending",
        residencyVerifiedAt: opts?.verified ? new Date() : null,
      })
      .returning();
    return u;
  }

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 6 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [t] = await db.insert(tenants).values({ slug: `qr-${Date.now()}`, name: "QR-Test" }).returning();
    tenantId = t.id;
    const [t2] = await db.insert(tenants).values({ slug: `qr2-${Date.now()}`, name: "QR-Test-2" }).returning();
    tenant2Id = t2.id;

    const verifier = await makeUser(tenantId);
    verifierId = verifier.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => {
    expect(true).toBe(true);
  });

  // --- Token-Hashing -------------------------------------------------------
  it.skipIf(SKIP)("Token-Hashing: nur sha256Hex(token) in der DB, RAW-Token nie", async () => {
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 5,
      gueltigkeitStunden: 24,
    }, ADMIN);
    expect(r.rawToken).toBeTruthy();

    const [row] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(row.tokenHash).toBe(sha256Hex(r.rawToken));
    // RAW-Token darf NIRGENDS in der Zeile stehen.
    expect(JSON.stringify(row)).not.toContain(r.rawToken);

    // qrCodesListe gibt KEINEN tokenHash aus.
    const liste = await qrCodesListe(db as never, tenantId);
    expect(JSON.stringify(liste)).not.toContain(row.tokenHash);
  });

  // --- Happy-Path ----------------------------------------------------------
  it.skipIf(SKIP)("Happy-Path: Einlösen → User Stufe 2 + residencyVerifiedAt/Until + method=qr", async () => {
    const u = await makeUser(tenantId);
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      label: "Bürgerbüro",
      maxRedemptions: 3,
      gueltigkeitStunden: 24,
    }, ADMIN);

    const res = await qrEinloesenCore(db as never, tenantId, u.id, r.rawToken);
    expect(res.ok).toBe(true);
    expect(res.alreadyRedeemed).toBe(false);
    expect(res.verifiedUntil).toBeInstanceOf(Date);

    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.verificationStatus).toBe("verified");
    expect(after.verificationMethod).toBe("qr");
    expect(after.residencyVerifiedAt).not.toBeNull();
    expect(after.residencyVerifiedUntil).not.toBeNull();
    expect(getStufe(after)).toBe(2);

    // ~24 Monate in der Zukunft (Toleranz 2 Tage gegen Monatsarithmetik/Uhrdrift).
    const erwartet = addMonths(new Date(), QR_VERIFICATION_MONTHS).getTime();
    expect(Math.abs(after.residencyVerifiedUntil!.getTime() - erwartet)).toBeLessThan(2 * 864e5);

    // Cap genau +1.
    const [qr] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(qr.redemptionCount).toBe(1);

    // Audit qr.redeemed PII-frei (actorRef=userId, keine E-Mail, kein tokenHash).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "qr.redeemed"), eq(auditEvents.targetId, r.qrId)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(u.id);
    const metaStr = JSON.stringify(audit[0].metadata);
    expect(metaStr).not.toContain("@");
    expect(metaStr).not.toContain(qr.tokenHash);
    expect(metaStr).not.toContain(r.rawToken);
  });

  // --- Ablauf --------------------------------------------------------------
  it.skipIf(SKIP)("Ablauf: abgelaufener QR wird abgelehnt (kein Stufe-2)", async () => {
    const u = await makeUser(tenantId);
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 5,
      gueltigkeitStunden: 1,
    }, ADMIN);
    // expiresAt in die Vergangenheit setzen.
    await db
      .update(qrCodes)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(qrCodes.id, r.qrId));

    const res = await qrEinloesenCore(db as never, tenantId, u.id, r.rawToken);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/abgelaufen|aufgebraucht/i);

    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(getStufe(after)).toBe(1);
    // KEINE Redemption-Zeile angelegt (Rollback / Vorab-Ablehnung).
    const reds = await db.select().from(qrRedemptions).where(eq(qrRedemptions.qrCodeId, r.qrId));
    expect(reds.length).toBe(0);
  });

  // --- Widerruf ------------------------------------------------------------
  it.skipIf(SKIP)("Widerruf: widerrufener QR wird abgelehnt", async () => {
    const u = await makeUser(tenantId);
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 5,
      gueltigkeitStunden: 24,
    }, ADMIN);
    const wr = await qrWiderrufenCore(db as never, tenantId, verifierId, r.qrId, ADMIN);
    expect(wr.ok).toBe(true);

    const res = await qrEinloesenCore(db as never, tenantId, u.id, r.rawToken);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/widerrufen/i);

    // Erneuter Widerruf ist idempotent-abgelehnt (kein Doppel-Audit-Spam).
    const wr2 = await qrWiderrufenCore(db as never, tenantId, verifierId, r.qrId, ADMIN);
    expect(wr2.ok).toBe(false);
  });

  // --- Einmal-Code (Verifizierung 2.0): maxRedemptions serverseitig fest 1 ---
  it.skipIf(SKIP)("Einmal-Code: maxRedemptions wird auf 1 geklemmt — 2. Einlösung abgelehnt", async () => {
    // Aufrufer verlangt 2 — serverseitig auf 1 geklemmt (Owner-Entscheid V3).
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 2,
      gueltigkeitStunden: 24,
    }, ADMIN);
    // Gespeichert ist genau 1 (nicht der angefragte Wert).
    const [erstellt] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(erstellt.maxRedemptions).toBe(1);

    const u1 = await makeUser(tenantId);
    const u2 = await makeUser(tenantId);

    expect((await qrEinloesenCore(db as never, tenantId, u1.id, r.rawToken)).ok).toBe(true);
    const second = await qrEinloesenCore(db as never, tenantId, u2.id, r.rawToken);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/aufgebraucht|abgelaufen/i);

    const [qr] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(qr.redemptionCount).toBe(1); // exakt am Limit, kein Überlauf
    // u2 bleibt Stufe 1 + keine Redemption-Zeile (Rollback).
    const [after2] = await db.select().from(users).where(eq(users.id, u2.id));
    expect(getStufe(after2)).toBe(1);
    const reds2 = await db
      .select()
      .from(qrRedemptions)
      .where(and(eq(qrRedemptions.qrCodeId, r.qrId), eq(qrRedemptions.userId, u2.id)));
    expect(reds2.length).toBe(0);
  });

  // --- Cap-Race ------------------------------------------------------------
  it.skipIf(SKIP)("Cap-Race: zwei parallele Einlösungen am LETZTEN Slot → genau 1 Erfolg", async () => {
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 1, // genau ein Slot
      gueltigkeitStunden: 24,
    }, ADMIN);
    const a = await makeUser(tenantId);
    const b = await makeUser(tenantId);

    const [ra, rb] = await Promise.all([
      qrEinloesenCore(db as never, tenantId, a.id, r.rawToken),
      qrEinloesenCore(db as never, tenantId, b.id, r.rawToken),
    ]);

    const successes = [ra, rb].filter((x) => x.ok && !x.alreadyRedeemed);
    expect(successes.length).toBe(1); // genau ein Gewinner, kein Cap-Überlauf

    const [qr] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(qr.redemptionCount).toBe(1);
    // Genau eine Redemption-Zeile insgesamt.
    const reds = await db.select().from(qrRedemptions).where(eq(qrRedemptions.qrCodeId, r.qrId));
    expect(reds.length).toBe(1);
  });

  // --- Idempotenz ----------------------------------------------------------
  it.skipIf(SKIP)("Doppel-Einlösung gleicher User → idempotent, KEIN Cap-Verbrauch", async () => {
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 5,
      gueltigkeitStunden: 24,
    }, ADMIN);
    const u = await makeUser(tenantId);

    const first = await qrEinloesenCore(db as never, tenantId, u.id, r.rawToken);
    expect(first.ok).toBe(true);
    expect(first.alreadyRedeemed).toBe(false);

    const second = await qrEinloesenCore(db as never, tenantId, u.id, r.rawToken);
    expect(second.ok).toBe(true);
    expect(second.alreadyRedeemed).toBe(true);

    const [qr] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(qr.redemptionCount).toBe(1); // KEIN Doppel-Verbrauch
    const reds = await db.select().from(qrRedemptions).where(eq(qrRedemptions.qrCodeId, r.qrId));
    expect(reds.length).toBe(1);
  });

  // --- Gesperrtes Ziel-Konto (WP1/B1) --------------------------------------
  it.skipIf(SKIP)("End-to-End (QR): Ziel-Konto gesperrt → Einlösung schlägt fehl, KEINE Redemption, Cap unverändert", async () => {
    const u = await makeUser(tenantId);
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 5,
      gueltigkeitStunden: 24,
    }, ADMIN);

    // Konto zwischen Erzeugung und Einlösung sperren.
    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, u.id));

    const res = await qrEinloesenCore(db as never, tenantId, u.id, r.rawToken);
    // Neutrale Meldung (kein Konten-Status-Orakel) statt 500.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nicht.*verifiziert werden/i);

    // Atomarität: KEINE Redemption-Zeile, Cap NICHT hochgezählt (Tx zurückgerollt).
    const reds = await db
      .select()
      .from(qrRedemptions)
      .where(and(eq(qrRedemptions.qrCodeId, r.qrId), eq(qrRedemptions.userId, u.id)));
    expect(reds.length).toBe(0);
    const [qr] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(qr.redemptionCount).toBe(0);

    // Kein Stempel auf dem gesperrten Konto (Stufe 2 nie vergeben; gesperrt = Stufe 0).
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.verificationStatus).toBe("pending");
    expect(after.residencyVerifiedAt).toBeNull();
    expect(getStufe(after)).not.toBe(2);
  });

  // --- Tenant-Isolation ----------------------------------------------------
  it.skipIf(SKIP)("Tenant-Isolation: Fremd-Tenant findet den Token nicht", async () => {
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "stadt",
      maxRedemptions: 5,
      gueltigkeitStunden: 24,
    }, ADMIN);
    const fremderUser = await makeUser(tenant2Id);

    // Einlösen über den FALSCHEN Tenant → ungültig (nicht gefunden).
    const res = await qrEinloesenCore(db as never, tenant2Id, fremderUser.id, r.rawToken);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ungültig/i);

    // qrTokenMeta ist tenant-scoped: korrekter Tenant findet, fremder nicht.
    expect(await qrTokenMeta(db as never, tenantId, r.rawToken)).not.toBeNull();
    expect(await qrTokenMeta(db as never, tenant2Id, r.rawToken)).toBeNull();
  });

  // --- Ortsteil-Scope ------------------------------------------------------
  it.skipIf(SKIP)("Ortsteil-Scope: setzt users.ortsteilId beim Einlösen", async () => {
    const [ot] = await db
      .insert(ortsteile)
      .values({ tenantId, code: "OT-77", name: "Testdorf" })
      .returning();
    const u = await makeUser(tenantId);
    const r = await qrErstellenCore(db as never, tenantId, verifierId, {
      scopeLevel: "ortsteil",
      scopeCode: "OT-77",
      maxRedemptions: 5,
      gueltigkeitStunden: 24,
    }, ADMIN);

    const res = await qrEinloesenCore(db as never, tenantId, u.id, r.rawToken);
    expect(res.ok).toBe(true);

    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.ortsteilId).toBe(ot.id);
    expect(getStufe(after)).toBe(2);
    // Audit M3: der verifizierte Wohnsitz-Knoten wird jetzt festgehalten und —
    // weil home_region_id noch NULL war — per COALESCE auch als Standard-Sicht.
    expect(after.residencyRegionId).not.toBeNull();
    expect(after.homeRegionId).toBe(after.residencyRegionId);
  });

  // --- Ungültiger Token ----------------------------------------------------
  it.skipIf(SKIP)("Unbekannter/erratener Token → freundlich abgelehnt", async () => {
    const u = await makeUser(tenantId);
    const res = await qrEinloesenCore(db as never, tenantId, u.id, "nicht-existent-xyz");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ungültig/i);
  });

  // --- Gebietsbindung (Block K1) -------------------------------------------
  // Nicht-Admin-Verifier dürfen QRs nur für Knoten erstellen, die der ltree-
  // Pfad einer ihrer verifier-Rollen abdeckt (fail-closed, QrGebietError).
  // Der Kontext wird wie in der Action über getUserRolesMitScope geladen —
  // die ECHTE Query, keine handgebauten Pfade.
  describe.skipIf(SKIP)("Gebietsbindung (Block K1)", () => {
    let otVerifier: string; // Verifier mit Rolle NUR auf Ortsteil OT-A
    let otVerifierScopes: QrErstellerKontext["scopes"];

    beforeAll(async () => {
      if (SKIP) return;
      // Ortsteil-Knoten OT-A/OT-B im Baum anlegen (Provisioning-GUC ist in der
      // Test-DB an) und dem Verifier eine verifier-Rolle NUR auf OT-A geben.
      const otA = await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "OT-A");
      await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "OT-B");
      const u = await makeUser(tenantId);
      otVerifier = u.id;
      await db.insert(roles).values({
        tenantId,
        userId: otVerifier,
        roleType: "verifier",
        regionId: otA,
      });
      otVerifierScopes = await getUserRolesMitScope(db as never, tenantId, otVerifier);
      expect(otVerifierScopes.length).toBe(1);
    });

    it("Ortsteil-Verifier: stadt-QR wird abgelehnt (fail-closed)", async () => {
      const vorher = (await qrCodesListe(db as never, tenantId)).length;
      await expect(
        qrErstellenCore(
          db as never,
          tenantId,
          otVerifier,
          { scopeLevel: "stadt", maxRedemptions: 5, gueltigkeitStunden: 24 },
          { isAdmin: false, scopes: otVerifierScopes },
        ),
      ).rejects.toThrow(QrGebietError);
      // Kein QR-Datensatz entstanden (der Fehler kommt VOR dem Insert).
      const nachher = (await qrCodesListe(db as never, tenantId)).length;
      expect(nachher).toBe(vorher);
    });

    it("Ortsteil-Verifier: QR im EIGENEN Ortsteil ist erlaubt", async () => {
      const r = await qrErstellenCore(
        db as never,
        tenantId,
        otVerifier,
        {
          scopeLevel: "ortsteil",
          scopeCode: "OT-A",
          maxRedemptions: 5,
          gueltigkeitStunden: 24,
        },
        { isAdmin: false, scopes: otVerifierScopes },
      );
      expect(r.qrId).toBeTruthy();
    });

    it("Ortsteil-Verifier: QR im FREMDEN Ortsteil wird abgelehnt", async () => {
      await expect(
        qrErstellenCore(
          db as never,
          tenantId,
          otVerifier,
          {
            scopeLevel: "ortsteil",
            scopeCode: "OT-B",
            maxRedemptions: 5,
            gueltigkeitStunden: 24,
          },
          { isAdmin: false, scopes: otVerifierScopes },
        ),
      ).rejects.toThrow(/Zuständigkeitsgebiet/);
    });

    // Gate-B K1: Widerruf ist SYMMETRISCH gebietsgebunden — ein Ortsteil-
    // Verifier kann den stadtweiten Aktions-QR des Admins nicht abschießen.
    it("Widerruf: Ortsteil-Verifier kann stadtweiten Admin-QR NICHT widerrufen", async () => {
      const stadtQr = await qrErstellenCore(
        db as never,
        tenantId,
        verifierId,
        { scopeLevel: "stadt", maxRedemptions: 5, gueltigkeitStunden: 24 },
        ADMIN,
      );
      const wr = await qrWiderrufenCore(
        db as never,
        tenantId,
        otVerifier,
        stadtQr.qrId,
        { isAdmin: false, scopes: otVerifierScopes },
      );
      expect(wr.ok).toBe(false);
      expect(wr.error).toMatch(/Zuständigkeitsgebiet/);
      // QR ist NICHT widerrufen worden.
      const [row] = await db.select().from(qrCodes).where(eq(qrCodes.id, stadtQr.qrId));
      expect(row.revokedAt).toBeNull();

      // Der Admin darf ihn weiterhin widerrufen.
      const wrAdmin = await qrWiderrufenCore(db as never, tenantId, verifierId, stadtQr.qrId, ADMIN);
      expect(wrAdmin.ok).toBe(true);
    });

    it("Widerruf: Ortsteil-Verifier darf QR im EIGENEN Ortsteil widerrufen", async () => {
      const otQr = await qrErstellenCore(
        db as never,
        tenantId,
        otVerifier,
        {
          scopeLevel: "ortsteil",
          scopeCode: "OT-A",
          maxRedemptions: 5,
          gueltigkeitStunden: 24,
        },
        { isAdmin: false, scopes: otVerifierScopes },
      );
      const wr = await qrWiderrufenCore(
        db as never,
        tenantId,
        otVerifier,
        otQr.qrId,
        { isAdmin: false, scopes: otVerifierScopes },
      );
      expect(wr.ok).toBe(true);
    });

    it("Admin: alle Ebenen erlaubt (auch fremder Ortsteil)", async () => {
      const stadt = await qrErstellenCore(
        db as never,
        tenantId,
        verifierId,
        { scopeLevel: "stadt", maxRedemptions: 5, gueltigkeitStunden: 24 },
        ADMIN,
      );
      expect(stadt.qrId).toBeTruthy();
      const otB = await qrErstellenCore(
        db as never,
        tenantId,
        verifierId,
        {
          scopeLevel: "ortsteil",
          scopeCode: "OT-B",
          maxRedemptions: 5,
          gueltigkeitStunden: 24,
        },
        ADMIN,
      );
      expect(otB.qrId).toBeTruthy();
    });

    it("Tenant-Isolation: verifier-Rolle in Tenant B zählt in Tenant A nicht", async () => {
      // User mit verifier-Rolle in Tenant 2 (Gemeinde-Knoten dort).
      const [fremd] = await db
        .insert(users)
        .values({
          tenantId: tenant2Id,
          email: nextEmail("fremd"),
          minAgeConfirmedAt: new Date(),
          verificationStatus: "pending",
        })
        .returning();
      const gem2 = await resolveRegionIdForScope(db as never, tenant2Id, "stadt", null);
      await db.insert(roles).values({
        tenantId: tenant2Id,
        userId: fremd.id,
        roleType: "verifier",
        regionId: gem2,
      });
      // getUserRolesMitScope ist tenant-scoped: in Tenant A hat der User NICHTS.
      const scopesInA = await getUserRolesMitScope(db as never, tenantId, fremd.id);
      expect(scopesInA.length).toBe(0);
      await expect(
        qrErstellenCore(
          db as never,
          tenantId,
          fremd.id,
          { scopeLevel: "stadt", maxRedemptions: 5, gueltigkeitStunden: 24 },
          { isAdmin: false, scopes: scopesInA },
        ),
      ).rejects.toThrow(QrGebietError);
    });

    it("erlaubteScopeEbenenFuerVerifier (UI-Komfort): eigener Knoten + darunter", () => {
      const ot = { roleType: "verifier", regionTyp: "ortsteil", regionPath: "de.x.y.g.o" };
      const gem = { roleType: "verifier", regionTyp: "gemeinde", regionPath: "de.x.y.g" };
      const kreis = { roleType: "verifier", regionTyp: "kreis", regionPath: "de.x.y" };
      expect(erlaubteScopeEbenenFuerVerifier([ot])).toEqual(["ortsteil"]);
      expect(erlaubteScopeEbenenFuerVerifier([gem])).toEqual(["ortsteil", "stadt"]);
      expect(erlaubteScopeEbenenFuerVerifier([kreis])).toEqual(["ortsteil", "stadt", "kreis"]);
      // Mehrere Rollen: Vereinigung; Nicht-verifier-Rollen zählen nicht.
      expect(erlaubteScopeEbenenFuerVerifier([ot, kreis])).toEqual(["ortsteil", "stadt", "kreis"]);
      expect(
        erlaubteScopeEbenenFuerVerifier([
          { roleType: "beobachter", regionTyp: "land", regionPath: "de.x" },
        ]),
      ).toEqual([]);
    });
  });
});
