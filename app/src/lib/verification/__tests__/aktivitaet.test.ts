/**
 * aktivitaet.test.ts — DB-Integrationstests der Team-/Aktivitätssicht +
 * Verifier-Anomalie-Kennzahlen (Block K4). Ruft die ECHTEN Lese-Queries aus
 * aktivitaet-queries.ts gegen ein ephemeres PG16 (keine gespiegelte Logik).
 *
 * Geprüfte Eigenschaften:
 *   - Tenant-Isolation: t1-Queries enthalten NIE t2-Daten (und umgekehrt).
 *   - Zeitfenster 7d/30d/gesamt korrekt (Einlösungen in/außerhalb der Fenster).
 *   - „aktiv" = nicht widerrufen UND nicht abgelaufen (widerrufener/abgelaufener
 *     QR zählt nicht als aktiv, taucht nicht in der Ausschöpfung auf).
 *   - Verifier mit entzogener Rolle erscheint mit hatVerifierRolle=false und
 *     erzeugt die Auffälligkeit „Aktivität nach Rollen-Entzug".
 *   - Ausschöpfungs-Schwelle: Grenzfälle 79 % (nicht) / 80 % (ja).
 *   - Einlöse-Spitze: Grenzfälle 20 (nicht) / 21 (ja) an einem Kalendertag.
 *   - Termine je Standort: nur 'wahrgenommen' zählt (storniert/gebucht nicht),
 *     Fenster über slot.starts_at; inaktive Standorte erscheinen.
 *   - PII-Disziplin: Beschreibungen enthalten keine Bürger-E-Mails.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import {
  getEinloesungenJeVerifier,
  getQrAusschoepfung,
  getTermineJeStandort,
  getAuffaelligkeiten,
} from "@/lib/verification/aktivitaet-queries";

const {
  tenants,
  users,
  roles,
  qrCodes,
  qrRedemptions,
  verificationLocations,
  verificationSlots,
  verificationBookings,
} = schema;

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

const DAY = 24 * 60 * 60 * 1000;

describe("verification/aktivitaet (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let t1: string;
  let t2: string;
  let region1: string;
  let region2: string;

  // t1-Akteure
  let vAktiv: string; // aktiver Verifier (Rolle vorhanden)
  let vSpike: string; // aktiver Verifier mit Einlöse-Spitze (21 an einem Tag)
  let vGrenz: string; // aktiver Verifier mit exakt 20 an einem Tag (KEINE Spitze)
  let vEntzogen: string; // hat QRs erstellt, aber KEINE Verifier-Rolle mehr
  let buergerEmails: string[] = []; // E-Mails der einlösenden Bürger (dürfen NIE erscheinen)

  let counter = 0;
  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@akt-test.de`;
  }

  async function makeUser(tId: string): Promise<string> {
    const [u] = await db
      .insert(users)
      .values({ tenantId: tId, email: nextEmail("u"), minAgeConfirmedAt: new Date() })
      .returning();
    return u.id;
  }

  async function giveVerifierRole(tId: string, userId: string, regionId: string) {
    await db.insert(roles).values({ tenantId: tId, userId, roleType: "verifier", regionId });
  }

  async function makeQr(opts: {
    tId: string;
    regionId: string;
    createdBy: string | null;
    label?: string | null;
    max: number;
    count: number;
    expiresInDays?: number; // Default +2 (aktiv); negativ = abgelaufen
    revoked?: boolean;
  }): Promise<string> {
    const [q] = await db
      .insert(qrCodes)
      .values({
        tenantId: opts.tId,
        regionId: opts.regionId,
        createdBy: opts.createdBy,
        label: opts.label ?? null,
        tokenHash: `hash-${Date.now()}-${++counter}`,
        maxRedemptions: opts.max,
        redemptionCount: opts.count,
        expiresAt: new Date(Date.now() + (opts.expiresInDays ?? 2) * DAY),
        revokedAt: opts.revoked ? new Date() : null,
      })
      .returning();
    return q.id;
  }

  // Fügt `n` Einlösungen auf einem QR ein, jeweils durch einen eigenen User aus
  // dem Pool (UNIQUE(qr_code_id,user_id)); alle mit demselben redeemedAt.
  async function makeRedemptions(
    tId: string,
    qrCodeId: string,
    n: number,
    redeemedAt: Date,
    pool: string[],
    poolOffset: number,
  ) {
    for (let i = 0; i < n; i++) {
      await db.insert(qrRedemptions).values({
        tenantId: tId,
        qrCodeId,
        userId: pool[(poolOffset + i) % pool.length],
        redeemedAt,
      });
    }
  }

  async function makeLocation(tId: string, name: string, isActive: boolean): Promise<string> {
    const [l] = await db
      .insert(verificationLocations)
      .values({ tenantId: tId, name, isActive })
      .returning();
    return l.id;
  }

  async function makeBooking(opts: {
    tId: string;
    locationId: string;
    startsAt: Date;
    userId: string;
    status: "gebucht" | "wahrgenommen" | "storniert";
  }) {
    const [slot] = await db
      .insert(verificationSlots)
      .values({
        locationId: opts.locationId,
        startsAt: opts.startsAt,
        endsAt: new Date(opts.startsAt.getTime() + 30 * 60_000),
        capacity: 5,
        bookedCount: 0,
      })
      .returning();
    await db.insert(verificationBookings).values({
      tenantId: opts.tId,
      slotId: slot.id,
      userId: opts.userId,
      code: `TERMIN-${Date.now()}-${++counter}`,
      status: opts.status,
    });
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

    const [ta] = await db.insert(tenants).values({ slug: `akt-${Date.now()}`, name: "AKT" }).returning();
    t1 = ta.id;
    const [tb] = await db.insert(tenants).values({ slug: `akt2-${Date.now()}`, name: "AKT2" }).returning();
    t2 = tb.id;

    region1 = await resolveRegionIdForScope(db as never, t1, "stadt", null);
    region2 = await resolveRegionIdForScope(db as never, t2, "stadt", null);

    // Verifier + Rollen (t1)
    vAktiv = await makeUser(t1);
    vSpike = await makeUser(t1);
    vGrenz = await makeUser(t1);
    vEntzogen = await makeUser(t1);
    await giveVerifierRole(t1, vAktiv, region1);
    await giveVerifierRole(t1, vSpike, region1);
    await giveVerifierRole(t1, vGrenz, region1);
    // vEntzogen bekommt BEWUSST keine Rolle → "Rolle entzogen".

    // Bürger-Pool für die Einlösungen (distinct user je (qr,user)).
    const pool: string[] = [];
    for (let i = 0; i < 25; i++) {
      const email = nextEmail("buerger");
      const [u] = await db
        .insert(users)
        .values({ tenantId: t1, email, minAgeConfirmedAt: new Date() })
        .returning();
      pool.push(u.id);
      buergerEmails.push(email);
    }

    // --- QR-Codes (t1) ------------------------------------------------------
    // vAktiv: aktiver QR mit gefensterten Einlösungen (2×heute, 1×@10d, 1×@40d).
    const qrNormal = await makeQr({ tId: t1, regionId: region1, createdBy: vAktiv, label: "Normal", max: 10, count: 5 });
    await makeRedemptions(t1, qrNormal, 2, new Date(), pool, 0);
    await makeRedemptions(t1, qrNormal, 1, new Date(Date.now() - 10 * DAY), pool, 2);
    await makeRedemptions(t1, qrNormal, 1, new Date(Date.now() - 40 * DAY), pool, 3);

    // vAktiv: widerrufener + abgelaufener QR — zählen NICHT als aktiv, tauchen
    // NICHT in der Ausschöpfung auf (der abgelaufene ist trotz 100 % ausgeschlossen).
    await makeQr({ tId: t1, regionId: region1, createdBy: vAktiv, label: "Widerrufen", max: 10, count: 5, revoked: true });
    await makeQr({ tId: t1, regionId: region1, createdBy: vAktiv, label: "Abgelaufen", max: 5, count: 5, expiresInDays: -1 });

    // Ausschöpfungs-Grenzfälle (aktiv), createdBy vAktiv: 79 % (nicht) / 80 % (ja).
    await makeQr({ tId: t1, regionId: region1, createdBy: vAktiv, label: "Quote79", max: 100, count: 79 });
    await makeQr({ tId: t1, regionId: region1, createdBy: vAktiv, label: "Quote80", max: 100, count: 80 });

    // vSpike: 21 Einlösungen HEUTE (ein Kalendertag) → Spitze.
    const qrSpike = await makeQr({ tId: t1, regionId: region1, createdBy: vSpike, label: "Spike", max: 100, count: 21 });
    await makeRedemptions(t1, qrSpike, 21, new Date(), pool, 0);

    // vGrenz: exakt 20 HEUTE → KEINE Spitze (Schwelle ist > 20).
    const qrGrenz = await makeQr({ tId: t1, regionId: region1, createdBy: vGrenz, label: "Grenz", max: 100, count: 20 });
    await makeRedemptions(t1, qrGrenz, 20, new Date(), pool, 0);

    // vEntzogen: aktiver QR mit 3 Einlösungen → "Aktivität nach Rollen-Entzug".
    const qrEntz = await makeQr({ tId: t1, regionId: region1, createdBy: vEntzogen, label: "Entzogen", max: 10, count: 3 });
    await makeRedemptions(t1, qrEntz, 3, new Date(), pool, 0);

    // --- Standorte + Termine (t1) ------------------------------------------
    const buerger = pool[0];
    const buerger2 = pool[1];
    const buerger3 = pool[2];
    const buerger4 = pool[3];
    const L1 = await makeLocation(t1, "Bürgerbüro 1", true);
    const L2 = await makeLocation(t1, "Außenstelle (inaktiv)", false);
    // L1: wahrgenommen @3d (7d), wahrgenommen @15d (30d), storniert @2d (nirgends),
    //     gebucht künftig (offen).
    await makeBooking({ tId: t1, locationId: L1, startsAt: new Date(Date.now() - 3 * DAY), userId: buerger, status: "wahrgenommen" });
    await makeBooking({ tId: t1, locationId: L1, startsAt: new Date(Date.now() - 15 * DAY), userId: buerger2, status: "wahrgenommen" });
    await makeBooking({ tId: t1, locationId: L1, startsAt: new Date(Date.now() - 2 * DAY), userId: buerger3, status: "storniert" });
    await makeBooking({ tId: t1, locationId: L1, startsAt: new Date(Date.now() + 5 * DAY), userId: buerger4, status: "gebucht" });
    // L2 (inaktiv): eine wahrgenommene Buchung @1d → erscheint trotzdem.
    await makeBooking({ tId: t1, locationId: L2, startsAt: new Date(Date.now() - 1 * DAY), userId: buerger, status: "wahrgenommen" });

    // --- t2 (Isolation, KEINE Auffälligkeiten) ------------------------------
    const v2 = await makeUser(t2);
    await giveVerifierRole(t2, v2, region2);
    const p2: string[] = [];
    for (let i = 0; i < 3; i++) p2.push(await makeUser(t2));
    const qr2 = await makeQr({ tId: t2, regionId: region2, createdBy: v2, label: "T2", max: 50, count: 5 });
    await makeRedemptions(t2, qr2, 2, new Date(), p2, 0);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => expect(true).toBe(true));

  it.skipIf(SKIP)("getEinloesungenJeVerifier: Fenster 7d/30d/gesamt + QR aktiv/gesamt + Rollen-Hinweis", async () => {
    const zeilen = await getEinloesungenJeVerifier(db as never, t1);

    const byUser = new Map(zeilen.map((z) => [z.createdBy, z]));
    const a = byUser.get(vAktiv)!;
    expect(a).toBeTruthy();
    // 5 QRs erstellt (Normal, Widerrufen, Abgelaufen, Quote79, Quote80) …
    expect(a.qrGesamt).toBe(5);
    // … davon aktiv: Normal, Quote79, Quote80 (Widerrufen+Abgelaufen raus).
    expect(a.qrAktiv).toBe(3);
    // Einlösungen NUR auf qrNormal: 2 heute, 1 @10d, 1 @40d.
    expect(a.einloesungen7d).toBe(2);
    expect(a.einloesungen30d).toBe(3);
    expect(a.einloesungenGesamt).toBe(4);
    expect(a.hatVerifierRolle).toBe(true);
    expect(a.letzteEinloesung).toBeInstanceOf(Date);

    const e = byUser.get(vEntzogen)!;
    expect(e.hatVerifierRolle).toBe(false);
    expect(e.einloesungenGesamt).toBe(3);

    // Tenant-Isolation: der t2-Verifier taucht in der t1-Sicht NICHT auf.
    const t2Emails = (await getEinloesungenJeVerifier(db as never, t2)).map((z) => z.email);
    for (const z of zeilen) {
      expect(t2Emails).not.toContain(z.email);
    }
  });

  it.skipIf(SKIP)("getQrAusschoepfung: nur aktive Codes, absteigend nach Quote, Grenzen 79/80 %", async () => {
    const liste = await getQrAusschoepfung(db as never, t1);
    const labels = liste.map((q) => q.label);
    // Widerrufen/Abgelaufen sind nicht aktiv → nicht in der Liste.
    expect(labels).not.toContain("Widerrufen");
    expect(labels).not.toContain("Abgelaufen");
    // Aktive Codes sind da.
    expect(labels).toContain("Quote79");
    expect(labels).toContain("Quote80");

    // Absteigend nach Quote.
    for (let i = 1; i < liste.length; i++) {
      expect(liste[i - 1].quote).toBeGreaterThanOrEqual(liste[i].quote);
    }

    const q79 = liste.find((q) => q.label === "Quote79")!;
    const q80 = liste.find((q) => q.label === "Quote80")!;
    expect(q79.quote).toBeCloseTo(0.79, 5);
    expect(q80.quote).toBeCloseTo(0.8, 5);

    // Ersteller-E-Mail wird (admin-only) mitgegeben.
    expect(q80.createdByEmail).toBeTruthy();

    // Isolation: t1-QR taucht in t2 nicht auf.
    const t2Liste = await getQrAusschoepfung(db as never, t2);
    expect(t2Liste.map((q) => q.label)).not.toContain("Quote80");
  });

  it.skipIf(SKIP)("getTermineJeStandort: nur 'wahrgenommen' zählt; Fenster; inaktive Standorte erscheinen", async () => {
    const st = await getTermineJeStandort(db as never, t1);
    const l1 = st.find((s) => s.name === "Bürgerbüro 1")!;
    const l2 = st.find((s) => s.name === "Außenstelle (inaktiv)")!;
    expect(l1).toBeTruthy();
    expect(l2).toBeTruthy();

    // L1: @3d (7d), @15d (30d, nicht 7d), storniert (nirgends), gebucht (offen).
    expect(l1.wahrgenommen7d).toBe(1);
    expect(l1.wahrgenommen30d).toBe(2);
    expect(l1.wahrgenommenGesamt).toBe(2);
    expect(l1.offeneKuenftige).toBe(1);

    // L2 inaktiv erscheint trotzdem; @1d wahrgenommen.
    expect(l2.isActive).toBe(false);
    expect(l2.wahrgenommen7d).toBe(1);
    expect(l2.wahrgenommenGesamt).toBe(1);

    // Isolation.
    const t2St = await getTermineJeStandort(db as never, t2);
    expect(t2St.map((s) => s.name)).not.toContain("Bürgerbüro 1");
  });

  it.skipIf(SKIP)("getAuffaelligkeiten: Ausschöpfung 80 %, Spitze (21), Rollen-Entzug; Spitze 20 NICHT; PII-frei", async () => {
    const auff = await getAuffaelligkeiten(db as never, t1);
    const typen = auff.map((a) => a.typ);

    // Genau eine Ausschöpfungs-Auffälligkeit (Quote80; Quote79 nicht).
    expect(typen.filter((t) => t === "qr_ausschoepfung").length).toBe(1);
    // Genau eine Spitze (vSpike 21; vGrenz 20 NICHT).
    expect(typen.filter((t) => t === "einloese_spitze").length).toBe(1);
    // Genau ein Rollen-Entzug (vEntzogen).
    expect(typen.filter((t) => t === "rollen_entzug").length).toBe(1);

    // Die Ausschöpfungs-Meldung nennt 80 %, nicht 79 %.
    const aus = auff.find((a) => a.typ === "qr_ausschoepfung")!;
    expect(aus.beschreibung).toContain("80");

    // PII-Disziplin: KEINE E-Mail eines einlösenden Bürgers darf in irgendeiner
    // Meldung auftauchen (zulässig ist nur die Verifier-/Ersteller-E-Mail).
    const alleTexte = auff.map((a) => `${a.beschreibung} ${a.bezug}`).join(" || ");
    for (const email of buergerEmails) {
      expect(alleTexte).not.toContain(email);
    }

    // t2 hat keine Auffälligkeiten → leere Liste (positives Signal).
    const auff2 = await getAuffaelligkeiten(db as never, t2);
    expect(auff2).toEqual([]);
  });
});
