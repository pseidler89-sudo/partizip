/**
 * booking.test.ts — Termin-Buchung (D6 Verify-Hub). Ruft die ECHTEN Funktionen
 * (booking-core + booking-queries), keine gespiegelte Logik.
 *
 * Getestete Sicherheits-/Korrektheits-Eigenschaften:
 *   - Kapazitäts-Atomarität (kein Überlauf über capacity).
 *   - Ein offener Termin je Bürger (partielles UNIQUE → alreadyBooked).
 *   - Storno gibt Kapazität frei; danach erneut buchbar.
 *   - Kein Buchen vergangener/inaktiver/fremd-Tenant-Slots.
 *   - bookingWahrnehmen verifiziert die Person (Stufe 2, in_person, ~24 Monate).
 *   - Verifier-Liste ist PII-frei (nur Code/Zeit/Ort).
 *
 * Läuft nur mit DATABASE_URL_TEST.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import {
  generateBookingCode,
  bookSlotCore,
  cancelBookingCore,
  bookingWahrnehmenCore,
  BOOKING_CODE_PATTERN,
} from "@/lib/verification/booking-core";
import {
  getMeinOffenerTermin,
  getOffeneTermineFuerVerifier,
  getStandorteMitFreienSlots,
} from "@/lib/verification/booking-queries";

const { tenants, users, verificationLocations, verificationSlots, verificationBookings } = schema;

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

describe("Termin-Code Format (Unit)", () => {
  it("entspricht TERMIN-XXXX-XXXX ohne mehrdeutige Zeichen", () => {
    for (let i = 0; i < 300; i++) {
      const c = generateBookingCode();
      expect(c).toMatch(BOOKING_CODE_PATTERN);
      expect(c.replace(/^TERMIN-/, "")).not.toMatch(/[ILOU]/);
    }
  });
  it("streut breit (keine Kollision über 5000)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 5000; i++) set.add(generateBookingCode());
    expect(set.size).toBe(5000);
  });
});

describe("Termin-Buchung (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let tenant2Id: string;
  let u1: string;
  let u2: string;
  let u3: string;
  let verifier: string;
  let locId: string;
  let locInactiveId: string;

  async function mkSlot(locationId: string, cap: number, startMs: number) {
    const [s] = await db
      .insert(verificationSlots)
      .values({
        locationId,
        startsAt: new Date(startMs),
        endsAt: new Date(startMs + 30 * 60 * 1000),
        capacity: cap,
      })
      .returning();
    return s;
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

    const [t1] = await db.insert(tenants).values({ slug: `bk-${Date.now()}`, name: "BK" }).returning();
    tenantId = t1.id;
    const [t2] = await db.insert(tenants).values({ slug: `bk2-${Date.now()}`, name: "BK2" }).returning();
    tenant2Id = t2.id;

    const mkUser = async (suffix: string) => {
      const [u] = await db
        .insert(users)
        .values({
          tenantId,
          email: `${suffix}-${Date.now()}@bk-test.de`,
          minAgeConfirmedAt: new Date(),
          verificationStatus: "pending",
        })
        .returning();
      return u.id;
    };
    u1 = await mkUser("u1");
    u2 = await mkUser("u2");
    u3 = await mkUser("u3");
    verifier = await mkUser("ver");

    const [loc] = await db
      .insert(verificationLocations)
      .values({ tenantId, name: "Rathaus", address: "Aarstr. 1", isActive: true })
      .returning();
    locId = loc.id;
    const [locInactive] = await db
      .insert(verificationLocations)
      .values({ tenantId, name: "Geschlossen", isActive: false })
      .returning();
    locInactiveId = locInactive.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => expect(true).toBe(true));

  it.skipIf(SKIP)("bucht einen freien Zukunfts-Slot; Code gültig; bookedCount +1", async () => {
    const slot = await mkSlot(locId, 2, Date.now() + 3 * DAY);
    const r = await bookSlotCore(db, tenantId, u1, slot.id);
    expect(r.ok).toBe(true);
    expect(r.booking?.code).toMatch(BOOKING_CODE_PATTERN);

    const [after] = await db.select().from(verificationSlots).where(eq(verificationSlots.id, slot.id));
    expect(after.bookedCount).toBe(1);

    // getMeinOffenerTermin liefert den offenen Termin.
    const mein = await getMeinOffenerTermin(db, tenantId, u1);
    expect(mein?.bookingId).toBe(r.booking?.bookingId);
    expect(mein?.locationName).toBe("Rathaus");
  });

  it.skipIf(SKIP)("ein offener Termin je Bürger → zweite Buchung alreadyBooked", async () => {
    const slot = await mkSlot(locId, 2, Date.now() + 4 * DAY);
    const r = await bookSlotCore(db, tenantId, u1, slot.id); // u1 hat schon offenen Termin
    expect(r.ok).toBe(false);
    expect(r.alreadyBooked).toBe(true);
    // bookedCount des zweiten Slots NICHT erhöht (Rollback/Vorab-Check).
    const [after] = await db.select().from(verificationSlots).where(eq(verificationSlots.id, slot.id));
    expect(after.bookedCount).toBe(0);
  });

  it.skipIf(SKIP)("Kapazität: cap=1 → zweiter Bürger wird abgewiesen (kein Überlauf)", async () => {
    const slot = await mkSlot(locId, 1, Date.now() + 5 * DAY);
    const r2 = await bookSlotCore(db, tenantId, u2, slot.id);
    expect(r2.ok).toBe(true);
    const r3 = await bookSlotCore(db, tenantId, u3, slot.id);
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/ausgebucht/);
    const [after] = await db.select().from(verificationSlots).where(eq(verificationSlots.id, slot.id));
    expect(after.bookedCount).toBe(1); // nie über capacity
  });

  it.skipIf(SKIP)("Storno gibt Kapazität frei und erlaubt Neubuchung", async () => {
    const mein = await getMeinOffenerTermin(db, tenantId, u1);
    expect(mein).not.toBeNull();
    const c = await cancelBookingCore(db, tenantId, u1, mein!.bookingId);
    expect(c.ok).toBe(true);
    expect(await getMeinOffenerTermin(db, tenantId, u1)).toBeNull();

    // Fremder Storno (u2 versucht u1s — hier schon storniert) → kein offener Termin.
    const c2 = await cancelBookingCore(db, tenantId, u2, mein!.bookingId);
    expect(c2.ok).toBe(false);

    // u1 kann erneut buchen.
    const slot = await mkSlot(locId, 1, Date.now() + 6 * DAY);
    const r = await bookSlotCore(db, tenantId, u1, slot.id);
    expect(r.ok).toBe(true);
  });

  it.skipIf(SKIP)("vergangener Slot ist nicht buchbar", async () => {
    const slot = await mkSlot(locId, 5, Date.now() - DAY);
    const r = await bookSlotCore(db, tenantId, u2, slot.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Vergangenheit/);
  });

  it.skipIf(SKIP)("inaktiver Standort: kein Termin", async () => {
    const slot = await mkSlot(locInactiveId, 5, Date.now() + 7 * DAY);
    const r = await bookSlotCore(db, tenantId, u2, slot.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/keine Termine/);
  });

  it.skipIf(SKIP)("Tenant-Isolation: Slot des Tenants ist unter fremdem Tenant nicht buchbar", async () => {
    const slot = await mkSlot(locId, 5, Date.now() + 8 * DAY);
    const r = await bookSlotCore(db, tenant2Id, u2, slot.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/gibt es nicht/);
  });

  it.skipIf(SKIP)("bookingWahrnehmen verifiziert die Person (Stufe 2, in_person, ~24 Monate)", async () => {
    const slot = await mkSlot(locId, 1, Date.now() + 9 * DAY);
    const r = await bookSlotCore(db, tenantId, u3, slot.id);
    expect(r.ok).toBe(true);
    const bookingId = r.booking!.bookingId;

    // Verifier-Liste ist PII-frei: enthält den Code, KEINE E-Mail.
    const liste = await getOffeneTermineFuerVerifier(db, tenantId);
    const eintrag = liste.find((t) => t.bookingId === bookingId);
    expect(eintrag).toBeTruthy();
    expect(JSON.stringify(eintrag)).not.toContain("@");

    const w = await bookingWahrnehmenCore(db, tenantId, verifier, bookingId);
    expect(w.ok).toBe(true);

    const [user] = await db.select().from(users).where(eq(users.id, u3));
    expect(user.verificationStatus).toBe("verified");
    expect(user.verificationMethod).toBe("in_person");
    expect(user.residencyVerifiedUntil).not.toBeNull();
    const monthsAhead =
      (user.residencyVerifiedUntil!.getTime() - Date.now()) / (DAY * 30);
    expect(monthsAhead).toBeGreaterThan(23);

    // Booking nicht mehr offen → zweites Wahrnehmen schlägt fehl.
    const w2 = await bookingWahrnehmenCore(db, tenantId, verifier, bookingId);
    expect(w2.ok).toBe(false);
    // und taucht nicht mehr in der offenen Liste auf.
    const liste2 = await getOffeneTermineFuerVerifier(db, tenantId);
    expect(liste2.find((t) => t.bookingId === bookingId)).toBeUndefined();
  });

  it.skipIf(SKIP)("No-Show verfällt: vergangener offener Termin sperrt die Neubuchung nicht", async () => {
    const [nu] = await db
      .insert(users)
      .values({ tenantId, email: `noshow-${Date.now()}@bk-test.de`, minAgeConfirmedAt: new Date(), verificationStatus: "pending" })
      .returning();

    const slotA = await mkSlot(locId, 1, Date.now() + 3 * DAY);
    const rA = await bookSlotCore(db, tenantId, nu.id, slotA.id);
    expect(rA.ok).toBe(true);
    const bookingAId = rA.booking!.bookingId;

    // No-Show simulieren: Slot >1 Tag in die Vergangenheit, Buchung bleibt 'gebucht'.
    await db
      .update(verificationSlots)
      .set({ startsAt: new Date(Date.now() - 2 * DAY), endsAt: new Date(Date.now() - 2 * DAY + 30 * 60 * 1000) })
      .where(eq(verificationSlots.id, slotA.id));

    // Hub zeigt keinen vergangenen Termin; Verifier-Liste zeigt den alten No-Show nicht.
    expect(await getMeinOffenerTermin(db, tenantId, nu.id)).toBeNull();
    const vlist = await getOffeneTermineFuerVerifier(db, tenantId);
    expect(vlist.find((t) => t.bookingId === bookingAId)).toBeUndefined();

    // Neubuchung gelingt → alter Termin verfällt automatisch auf 'storniert'.
    const slotB = await mkSlot(locId, 1, Date.now() + 4 * DAY);
    const rB = await bookSlotCore(db, tenantId, nu.id, slotB.id);
    expect(rB.ok).toBe(true);
    const [oldB] = await db.select().from(verificationBookings).where(eq(verificationBookings.id, bookingAId));
    expect(oldB.status).toBe("storniert");

    // 1-Tag-Guard in bookingWahrnehmenCore (ohne Sweep): wochenalter No-Show nicht bestätigbar.
    const [nu2] = await db
      .insert(users)
      .values({ tenantId, email: `noshow2-${Date.now()}@bk-test.de`, minAgeConfirmedAt: new Date(), verificationStatus: "pending" })
      .returning();
    const slotC = await mkSlot(locId, 1, Date.now() + 5 * DAY);
    const rC = await bookSlotCore(db, tenantId, nu2.id, slotC.id);
    expect(rC.ok).toBe(true);
    await db
      .update(verificationSlots)
      .set({ startsAt: new Date(Date.now() - 2 * DAY), endsAt: new Date(Date.now() - 2 * DAY + 30 * 60 * 1000) })
      .where(eq(verificationSlots.id, slotC.id));
    const wC = await bookingWahrnehmenCore(db, tenantId, verifier, rC.booking!.bookingId);
    expect(wC.ok).toBe(false);
  });

  it.skipIf(SKIP)("End-to-End (Booking): Ziel-Konto nach Buchung gesperrt → Wahrnehmen schlägt fehl, Buchung bleibt 'gebucht'", async () => {
    // Frischer Bürger + frischer Slot, damit die Buchung sicher offen ist.
    const [nu] = await db
      .insert(users)
      .values({
        tenantId,
        email: `locked-${Date.now()}@bk-test.de`,
        minAgeConfirmedAt: new Date(),
        verificationStatus: "pending",
      })
      .returning();
    const slot = await mkSlot(locId, 1, Date.now() + 10 * DAY);
    const r = await bookSlotCore(db, tenantId, nu.id, slot.id);
    expect(r.ok).toBe(true);
    const bookingId = r.booking!.bookingId;

    // Slot in den bestätigbaren Fensterbereich ziehen (kürzlich fällig), damit der
    // Fehlschlag NICHT am 1-Tag-Guard, sondern am gesperrten Ziel-Konto liegt.
    await db
      .update(verificationSlots)
      .set({
        startsAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 30 * 60 * 1000),
      })
      .where(eq(verificationSlots.id, slot.id));

    // Konto zwischen Buchung und Wahrnehmung sperren.
    await db.update(users).set({ accountStatus: "locked" }).where(eq(users.id, nu.id));

    const w = await bookingWahrnehmenCore(db, tenantId, verifier, bookingId);
    // Neutrale Meldung (kein Konten-Status-Orakel), kein 500.
    expect(w.ok).toBe(false);
    expect(w.error).toMatch(/nicht.*verifiziert werden/i);

    // Atomarität: Buchung UNVERÄNDERT 'gebucht' (kein Konsum, kein Teil-Effekt).
    const [booking] = await db
      .select()
      .from(verificationBookings)
      .where(eq(verificationBookings.id, bookingId));
    expect(booking.status).toBe("gebucht");

    // Kein Stempel auf dem gesperrten Konto.
    const [user] = await db.select().from(users).where(eq(users.id, nu.id));
    expect(user.verificationStatus).toBe("pending");
    expect(user.residencyVerifiedUntil).toBeNull();
  });

  it.skipIf(SKIP)("getStandorteMitFreienSlots: nur aktive Standorte + freie Zukunfts-Slots", async () => {
    const standorte = await getStandorteMitFreienSlots(db, tenantId);
    // Inaktiver Standort darf nicht auftauchen.
    expect(standorte.find((s) => s.name === "Geschlossen")).toBeUndefined();
    const rathaus = standorte.find((s) => s.name === "Rathaus");
    expect(rathaus).toBeTruthy();
    // Alle gelieferten Slots liegen in der Zukunft und haben freie Plätze.
    for (const s of rathaus!.slots) {
      expect(s.startsAt.getTime()).toBeGreaterThan(Date.now());
      expect(s.frei).toBeGreaterThan(0);
    }
  });
});
