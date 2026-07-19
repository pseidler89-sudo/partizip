/**
 * proof.test.ts — DB-Integrationstests der ECHTEN Konto-QR-Funktionen (V3):
 * meinProofErzeugenCore / verifizierungPerProofBestaetigenCore / verifierZielGebiete
 * aus proof-core.ts. Es wird NICHT die Logik gespiegelt — die Production-Funktionen
 * laufen direkt gegen ein ephemeres PG16 (Muster qr.test.ts). Der Auth/Tenant-
 * Kontext wird als Parameter übergeben, exakt wie in der „use server"-Action.
 *
 * Geprüfte Sicherheits-Eigenschaften (auth-/verifizierungs-kritisch):
 *   - Proof-Erzeugung invalidiert vorher offene Belege (ein aktiver Beleg/Person).
 *   - Token-Hashing: in der DB steht nur sha256Hex(token), nie der RAW-Token.
 *   - Single-Use: 2. Konsum scheitert (0-Row-Pfad); Ablauf wird abgelehnt.
 *   - Tenant-Isolation: fremder Tenant findet den Beleg nicht.
 *   - Selbst-Bestätigung gesperrt (Verifizierer ≠ Beleg-Inhaber).
 *   - Gebiets-Autorität fail-closed: fremdes Gebiet → KEIN Grant.
 *   - Nicht-Verifizierer (leere Scopes) → abgelehnt.
 *   - Region-Anker korrekt an grantResidency (residency hart, home-COALESCE, ortsteil).
 *   - Alt-QR: maxRedemptions serverseitig auf 1 geklemmt (auch bei Input 500).
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
  meinProofErzeugenCore,
  verifizierungPerProofBestaetigenCore,
  verifierZielGebiete,
  vorbelegtesGebiet,
  proofFuerAnzeige,
  ProofGebietError,
  type VerifierKontext,
} from "@/lib/verification/proof-core";
import { qrErstellenCore } from "@/lib/verification/qr-core";
import { getUserRolesMitScope } from "@/lib/auth/roles";
import { resolveRegionIdForScope } from "@/lib/region/scope";

const { tenants, users, roles, ortsteile, qrCodes, verificationProofs, auditEvents } =
  schema;

/** Unbeschränkter Admin-Kontext (wie die Action für kommune_admin durchreicht). */
const ADMIN: VerifierKontext = { isAdmin: true, scopes: [] };

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

describe("verification/proof (Integration, V3 Konto-QR)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let tenant2Id: string;
  let gemeindeId: string;
  let otAId: string;
  let otBId: string;
  let gem2Id: string;
  let otAVerifierId: string; // verifier NUR auf OT-A
  let otAVerifierScopes: VerifierKontext["scopes"];
  let counter = 0;

  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@proof-test.de`;
  }

  async function makeUser(tId: string, opts?: { homeRegionId?: string }) {
    const [u] = await db
      .insert(users)
      .values({
        tenantId: tId,
        email: nextEmail("u"),
        minAgeConfirmedAt: new Date(),
        verificationStatus: "pending",
        ...(opts?.homeRegionId ? { homeRegionId: opts.homeRegionId } : {}),
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

    const [t] = await db.insert(tenants).values({ slug: `pf-${Date.now()}`, name: "Proof-Test" }).returning();
    tenantId = t.id;
    const [t2] = await db.insert(tenants).values({ slug: `pf2-${Date.now()}`, name: "Proof-Test-2" }).returning();
    tenant2Id = t2.id;

    // Ortsteile (Reverse-Lookup braucht die ortsteile-Tabelle) + Baum-Knoten.
    await db.insert(ortsteile).values([
      { tenantId, code: "OT-A", name: "Ortsteil A" },
      { tenantId, code: "OT-B", name: "Ortsteil B" },
    ]);
    gemeindeId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    otAId = await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "OT-A");
    otBId = await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "OT-B");
    gem2Id = await resolveRegionIdForScope(db as never, tenant2Id, "stadt", null);

    // Verifizierer mit Rolle NUR auf OT-A.
    const v = await makeUser(tenantId);
    otAVerifierId = v.id;
    await db.insert(roles).values({
      tenantId,
      userId: otAVerifierId,
      roleType: "verifier",
      regionId: otAId,
    });
    otAVerifierScopes = await getUserRolesMitScope(db as never, tenantId, otAVerifierId);
    expect(otAVerifierScopes.length).toBe(1);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("Platzhalter (DATABASE_URL_TEST nicht gesetzt)", () => {
    expect(true).toBe(true);
  });

  // --- Erzeugung: Invalidierung + Token-Hashing ----------------------------
  it.skipIf(SKIP)("Erzeugung invalidiert den Vor-Proof; nur sha256Hex(token) in der DB", async () => {
    const u = await makeUser(tenantId);
    const p1 = await meinProofErzeugenCore(db as never, tenantId, u.id);
    // RAW-Token steht NICHT in der Zeile.
    const [row1] = await db.select().from(verificationProofs).where(eq(verificationProofs.id, p1.proofId));
    expect(row1.tokenHash).toBe(sha256Hex(p1.rawToken));
    expect(JSON.stringify(row1)).not.toContain(p1.rawToken);

    // Neuer Proof invalidiert den alten (Ablauf auf jetzt).
    const p2 = await meinProofErzeugenCore(db as never, tenantId, u.id);
    expect((await proofFuerAnzeige(db as never, tenantId, p1.rawToken)).status).toBe("abgelaufen");
    expect((await proofFuerAnzeige(db as never, tenantId, p2.rawToken)).status).toBe("gueltig");
  });

  // --- Happy-Path (Gemeinde) + Single-Use ----------------------------------
  it.skipIf(SKIP)("Admin bestätigt Gemeinde-Proof → Stufe 2, method=qr_konto; 2. Konsum scheitert", async () => {
    const u = await makeUser(tenantId);
    const p = await meinProofErzeugenCore(db as never, tenantId, u.id);

    const res = await verifizierungPerProofBestaetigenCore(
      db as never,
      tenantId,
      otAVerifierId, // Verifizierer (≠ u)
      p.rawToken,
      gemeindeId,
      ADMIN,
    );
    expect(res.ok).toBe(true);
    expect(res.verifiedUntil).toBeInstanceOf(Date);

    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.verificationStatus).toBe("verified");
    expect(after.verificationMethod).toBe("qr_konto");
    expect(getStufe(after)).toBe(2);
    // Region-Anker: residency_region_id = Gemeinde (hart); home per COALESCE gesetzt.
    expect(after.residencyRegionId).toBe(gemeindeId);
    expect(after.homeRegionId).toBe(gemeindeId);

    // Beleg konsumiert.
    const [prow] = await db.select().from(verificationProofs).where(eq(verificationProofs.id, p.proofId));
    expect(prow.consumedAt).not.toBeNull();
    expect(prow.consumedBy).toBe(otAVerifierId);

    // 2. Konsum desselben Tokens scheitert (0-Row-Pfad).
    const zweite = await verifizierungPerProofBestaetigenCore(
      db as never, tenantId, otAVerifierId, p.rawToken, gemeindeId, ADMIN,
    );
    expect(zweite.ok).toBe(false);
    expect(zweite.error).toMatch(/bereits verwendet|abgelaufen/i);

    // Audit residency.granted_by_proof PII-frei (actorRef=Verifizierer, keine E-Mail/rawToken).
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "residency.granted_by_proof"), eq(auditEvents.targetId, u.id)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(otAVerifierId);
    const metaStr = JSON.stringify(audit[0].metadata);
    expect(metaStr).not.toContain("@");
    expect(metaStr).not.toContain(p.rawToken);
  });

  // --- Ablauf --------------------------------------------------------------
  it.skipIf(SKIP)("Abgelaufener Beleg wird abgelehnt (kein Grant)", async () => {
    const u = await makeUser(tenantId);
    const p = await meinProofErzeugenCore(db as never, tenantId, u.id);
    await db
      .update(verificationProofs)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(verificationProofs.id, p.proofId));

    const res = await verifizierungPerProofBestaetigenCore(
      db as never, tenantId, otAVerifierId, p.rawToken, gemeindeId, ADMIN,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/abgelaufen/i);

    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(getStufe(after)).toBe(1);
  });

  // --- Tenant-Isolation ----------------------------------------------------
  it.skipIf(SKIP)("Tenant-Isolation: fremder Tenant findet den Beleg nicht", async () => {
    const u = await makeUser(tenantId);
    const p = await meinProofErzeugenCore(db as never, tenantId, u.id);

    // Admin von Tenant 2 versucht mit Tenant-2-Gebiet → Beleg im Tenant 2 nicht gefunden.
    const res = await verifizierungPerProofBestaetigenCore(
      db as never, tenant2Id, otAVerifierId, p.rawToken, gem2Id, ADMIN,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ungültig/i);

    // proofFuerAnzeige ist tenant-scoped.
    expect((await proofFuerAnzeige(db as never, tenantId, p.rawToken)).status).toBe("gueltig");
    expect((await proofFuerAnzeige(db as never, tenant2Id, p.rawToken)).status).toBe("unbekannt");

    // Beleg unverändert (nicht konsumiert).
    const [prow] = await db.select().from(verificationProofs).where(eq(verificationProofs.id, p.proofId));
    expect(prow.consumedAt).toBeNull();
  });

  // --- Selbst-Bestätigung gesperrt -----------------------------------------
  it.skipIf(SKIP)("Selbst-Bestätigung gesperrt: Verifizierer kann eigenen Beleg nicht bestätigen", async () => {
    // Der OT-A-Verifizierer erzeugt seinen EIGENEN Beleg und wählt sein eigenes Gebiet (OT-A).
    const p = await meinProofErzeugenCore(db as never, tenantId, otAVerifierId);
    const res = await verifizierungPerProofBestaetigenCore(
      db as never, tenantId, otAVerifierId, p.rawToken, otAId,
      { isAdmin: false, scopes: otAVerifierScopes },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/eigenen Beleg/i);

    // KEIN Grant, KEIN Konsum.
    const [after] = await db.select().from(users).where(eq(users.id, otAVerifierId));
    expect(getStufe(after)).toBe(1);
    const [prow] = await db.select().from(verificationProofs).where(eq(verificationProofs.id, p.proofId));
    expect(prow.consumedAt).toBeNull();
    // Audit proof.self_rejected vorhanden.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "proof.self_rejected"), eq(auditEvents.targetId, p.proofId)));
    expect(audit.length).toBe(1);
  });

  // --- Gebiets-Autorität fail-closed ---------------------------------------
  it.skipIf(SKIP)("Gebiets-Autorität fail-closed: OT-A-Verifizierer → fremdes Gebiet KEIN Grant", async () => {
    const kontext: VerifierKontext = { isAdmin: false, scopes: otAVerifierScopes };

    // Gemeinde-Gebiet (OT-A deckt die Gemeinde NICHT ab — Pfad ist tiefer) → Gebiet-Error.
    const u1 = await makeUser(tenantId);
    const p1 = await meinProofErzeugenCore(db as never, tenantId, u1.id);
    await expect(
      verifizierungPerProofBestaetigenCore(db as never, tenantId, otAVerifierId, p1.rawToken, gemeindeId, kontext),
    ).rejects.toThrow(ProofGebietError);
    expect(getStufe((await db.select().from(users).where(eq(users.id, u1.id)))[0])).toBe(1);
    // Beleg NICHT konsumiert (Fehler kommt vor dem Konsum).
    expect((await db.select().from(verificationProofs).where(eq(verificationProofs.id, p1.proofId)))[0].consumedAt).toBeNull();

    // Fremder Ortsteil OT-B → Gebiet-Error.
    const u2 = await makeUser(tenantId);
    const p2 = await meinProofErzeugenCore(db as never, tenantId, u2.id);
    await expect(
      verifizierungPerProofBestaetigenCore(db as never, tenantId, otAVerifierId, p2.rawToken, otBId, kontext),
    ).rejects.toThrow(ProofGebietError);

    // EIGENER Ortsteil OT-A → erlaubt, Grant erfolgt, ortsteilId gesetzt.
    const u3 = await makeUser(tenantId);
    const p3 = await meinProofErzeugenCore(db as never, tenantId, u3.id);
    const ok = await verifizierungPerProofBestaetigenCore(db as never, tenantId, otAVerifierId, p3.rawToken, otAId, kontext);
    expect(ok.ok).toBe(true);
    const [after3] = await db.select().from(users).where(eq(users.id, u3.id));
    expect(getStufe(after3)).toBe(2);
    expect(after3.residencyRegionId).toBe(otAId);
    // ortsteilId aufgelöst (OT-A) + home per COALESCE = OT-A-Knoten.
    const [otA] = await db.select().from(ortsteile).where(and(eq(ortsteile.tenantId, tenantId), eq(ortsteile.code, "OT-A")));
    expect(after3.ortsteilId).toBe(otA.id);
    expect(after3.homeRegionId).toBe(otAId);
  });

  // --- Nicht-Verifizierer ---------------------------------------------------
  it.skipIf(SKIP)("Nicht-Verifizierer (leere Scopes, kein Admin) → abgelehnt (Gebiet)", async () => {
    const u = await makeUser(tenantId);
    const p = await meinProofErzeugenCore(db as never, tenantId, u.id);
    await expect(
      verifizierungPerProofBestaetigenCore(
        db as never, tenantId, otAVerifierId, p.rawToken, gemeindeId,
        { isAdmin: false, scopes: [] },
      ),
    ).rejects.toThrow(ProofGebietError);
    expect(getStufe((await db.select().from(users).where(eq(users.id, u.id)))[0])).toBe(1);
  });

  // --- home-COALESCE-Regel (bestehender Wohnort bleibt) --------------------
  it.skipIf(SKIP)("Region-Anker: bestehender home_region_id wird NICHT überschrieben, residency hart", async () => {
    // User hat bereits home_region_id = Gemeinde. Bestätigung auf OT-A: residency
    // wird hart auf OT-A gesetzt, home bleibt Gemeinde (COALESCE-Regel).
    const u = await makeUser(tenantId, { homeRegionId: gemeindeId });
    const p = await meinProofErzeugenCore(db as never, tenantId, u.id);
    const res = await verifizierungPerProofBestaetigenCore(
      db as never, tenantId, otAVerifierId, p.rawToken, otAId,
      { isAdmin: false, scopes: otAVerifierScopes },
    );
    expect(res.ok).toBe(true);
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.residencyRegionId).toBe(otAId); // hart = verifizierter Knoten
    expect(after.homeRegionId).toBe(gemeindeId); // bewusste Wahl bleibt
  });

  // --- Feed + Vorbelegung ---------------------------------------------------
  it.skipIf(SKIP)("verifierZielGebiete: Admin → Gemeinde + beide Ortsteile; OT-A-Verifizierer → nur OT-A", async () => {
    const adminFeed = await verifierZielGebiete(db as never, tenantId, [], true);
    expect(adminFeed.filter((g) => g.typ === "gemeinde")).toHaveLength(1);
    expect(adminFeed.filter((g) => g.typ === "ortsteil")).toHaveLength(2);
    expect(adminFeed[0].typ).toBe("gemeinde"); // Gemeinde zuerst
    // Vorbelegung Admin = Gemeinde-Knoten.
    expect(vorbelegtesGebiet(adminFeed)).toBe(gemeindeId);

    const otFeed = await verifierZielGebiete(db as never, tenantId, otAVerifierScopes, false);
    expect(otFeed).toHaveLength(1);
    expect(otFeed[0].regionId).toBe(otAId);
    // Vorbelegung = der einzige (feinste) Knoten.
    expect(vorbelegtesGebiet(otFeed)).toBe(otAId);
  });

  // --- Alt-QR: Einmal-Code-Klemme ------------------------------------------
  it.skipIf(SKIP)("Alt-QR: maxRedemptions serverseitig auf 1 geklemmt (auch bei Input 500)", async () => {
    const r = await qrErstellenCore(
      db as never,
      tenantId,
      otAVerifierId,
      // Manipulierter Input: 500 Einlösungen — muss zu 1 geklemmt werden.
      { scopeLevel: "stadt", maxRedemptions: 500, gueltigkeitStunden: 24 },
      { isAdmin: true, scopes: [] },
    );
    const [row] = await db.select().from(qrCodes).where(eq(qrCodes.id, r.qrId));
    expect(row.maxRedemptions).toBe(1);
  });
});
