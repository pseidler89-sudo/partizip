/**
 * standort.test.ts — Standort-/Sprechzeiten-Verwaltung (Block K1). Ruft die
 * ECHTEN Funktionen (standort-core + standort-queries), keine gespiegelte Logik.
 *
 * Getestete Sicherheits-/Korrektheits-Eigenschaften:
 *   - Erstellen/Bearbeiten inkl. Unique-Konflikt (tenant+name) — gleicher Name
 *     in ANDEREM Tenant ist ok.
 *   - BEFORE-INSERT-Trigger setzt region_id auf den Gemeinde-Knoten (ADR-024).
 *   - Tenant-Isolation: fremde tenantId trifft bei ALLEN Mutationen 0 Zeilen.
 *   - Wochenserie: Anzahl/Wochentage korrekt, DST-Grenze Oktober 2026
 *     (Wandzeit bleibt 09:00 Europe/Berlin), Cap 200, onConflict zählt
 *     Übersprungene (idempotent).
 *   - Slots mit Buchungen sind nicht löschbar; Kapazität nie unter booked_count.
 *   - Deaktivierter Standort: keine neuen Sprechzeiten/Buchungen, aber
 *     bestehende offene Termine bleiben in der Verifier-Liste sichtbar.
 *   - Audit PII-frei (actorRef=Admin-UUID, keine E-Mail).
 *
 * Läuft nur mit DATABASE_URL_TEST.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import {
  berlinDate,
  generiereSerienSlotZeiten,
  slotKapazitaetAendernCore,
  slotLoeschenCore,
  sprechzeitenAnlegenCore,
  standortAktivSetzenCore,
  standortBearbeitenCore,
  standortEingabeSchema,
  standortErstellenCore,
} from "@/lib/verification/standort-core";
import {
  getSlotsFuerStandortAdmin,
  getStandorteFuerAdmin,
  standorteInDerNaehe,
} from "@/lib/verification/standort-queries";
import { bookSlotCore, bookingWahrnehmenCore } from "@/lib/verification/booking-core";
import {
  getOffeneTermineFuerVerifier,
  getStandorteMitFreienSlots,
} from "@/lib/verification/booking-queries";

const { tenants, users, regions, verificationLocations, verificationSlots, auditEvents } = schema;

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

/** Kalenderdatum (UTC-basiert) heute+n als "YYYY-MM-DD" für Serien-Eingaben. */
function isoPlusTage(n: number): string {
  return new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
}

/** Wandzeit „HH:MM" eines Zeitpunkts in Europe/Berlin (für DST-Prüfungen). */
function berlinWandzeit(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  }).format(d);
}

// ---------------------------------------------------------------------------
// Reine Zeit-Logik (Unit — läuft auch ohne DB): DST-Grenze mit FIXEN Daten,
// dadurch bleiben diese Tests zeitunabhängig gültig (kein Zukunfts-Check hier).
// ---------------------------------------------------------------------------

describe("berlinDate (Unit)", () => {
  it("Sommerzeit: 09:00 Berlin = 07:00 UTC (CEST, +02:00)", () => {
    expect(berlinDate("2026-07-15", "09:00").toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("Winterzeit: 09:00 Berlin = 08:00 UTC (CET, +01:00)", () => {
    expect(berlinDate("2026-12-15", "09:00").toISOString()).toBe("2026-12-15T08:00:00.000Z");
  });

  it("DST-Umstellungstag 25.10.2026: 09:00 liegt bereits in CET (+01:00)", () => {
    expect(berlinDate("2026-10-25", "09:00").toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });

  it("wirft bei ungültiger Eingabe", () => {
    expect(() => berlinDate("kein-datum", "09:00")).toThrow();
  });
});

describe("generiereSerienSlotZeiten (Unit)", () => {
  it("DST-Grenze (Herbst): Serie 23.–26.10.2026 behält die Wandzeit 09:00", () => {
    const { slots, dstVerworfen } = generiereSerienSlotZeiten({
      vonDatum: "2026-10-23",
      bisDatum: "2026-10-26",
      wochentage: [0, 1, 2, 3, 4, 5, 6],
      vonZeit: "09:00",
      bisZeit: "10:00",
      slotDauerMinuten: 60,
    });
    expect(slots.length).toBe(4); // Fr, Sa, So (Umstellung), Mo
    expect(dstVerworfen).toBe(0);
    for (const s of slots) {
      expect(berlinWandzeit(s.startsAt)).toBe("09:00");
      expect(berlinWandzeit(s.endsAt)).toBe("10:00");
    }
    // Vor der Umstellung 07:00 UTC (CEST), ab dem 25.10. 08:00 UTC (CET) —
    // ein fest kodierter Offset würde hier brechen.
    expect(slots[0].startsAt.getUTCHours()).toBe(7); // Fr 23.10.
    expect(slots[2].startsAt.getUTCHours()).toBe(8); // So 25.10. (Umstellungstag)
    expect(slots[3].startsAt.getUTCHours()).toBe(8); // Mo 26.10.
  });

  it("DST-Frühjahrslücke (Gate-B): 29.03.2026 01:30–03:30 verwirft den Slot der nicht-existenten Stunde", () => {
    // Am 29.03.2026 springt die Uhr 02:00→03:00: der 02:30–03:30-Slot bildet
    // auf endsAt <= startsAt ab und würde den DB-CHECK
    // verification_slots_ends_after_starts verletzen (500 für die GANZE Serie).
    const { slots, dstVerworfen } = generiereSerienSlotZeiten({
      vonDatum: "2026-03-29",
      bisDatum: "2026-03-29",
      wochentage: [0], // Sonntag
      vonZeit: "01:30",
      bisZeit: "03:30",
      slotDauerMinuten: 60,
    });
    expect(slots.length).toBe(1); // nur der 01:30-Slot bleibt
    expect(dstVerworfen).toBe(1); // der degenerierte 02:30-Slot ist aussortiert
    for (const s of slots) {
      expect(s.endsAt.getTime()).toBeGreaterThan(s.startsAt.getTime());
    }
  });

  it("Notbremse (Gate-B MAJOR): Generierung bricht knapp über dem 200er-Cap ab statt endlos zu laufen", () => {
    // 300 Tage × 8 Slots/Tag wären 2400 — die Schleife muss beim
    // Überschreiten des Caps abbrechen (Aufrufer lehnt dann ab).
    const { slots } = generiereSerienSlotZeiten({
      vonDatum: "2026-01-01",
      bisDatum: "2026-10-27",
      wochentage: [0, 1, 2, 3, 4, 5, 6],
      vonZeit: "09:00",
      bisZeit: "17:00",
      slotDauerMinuten: 60,
    });
    expect(slots.length).toBeGreaterThan(200); // Cap-Überschreitung erkennbar …
    expect(slots.length).toBeLessThanOrEqual(208); // … aber höchstens +1 Tagespaket
  });

  it("nur gewählte Wochentage; letzter Slot endet spätestens um bisZeit", () => {
    // 2026-07-06 (Mo) bis 2026-07-19 (So): 14 Tage ⇒ jeder Wochentag genau 2×.
    const { slots } = generiereSerienSlotZeiten({
      vonDatum: "2026-07-06",
      bisDatum: "2026-07-19",
      wochentage: [2], // nur Dienstag
      vonZeit: "09:00",
      bisZeit: "10:15",
      slotDauerMinuten: 30,
    });
    // 2 Dienstage × 2 Slots (09:00, 09:30 — 10:00+30 min würde 10:15 überschreiten).
    expect(slots.length).toBe(4);
    for (const s of slots) {
      const wochentag = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        timeZone: "Europe/Berlin",
      }).format(s.startsAt);
      expect(wochentag).toBe("Tue");
    }
  });
});

// ---------------------------------------------------------------------------
// Standort-Eingabe-Validierung (V1) — ruft das ECHTE zod-Schema
// (standortEingabeSchema), keine gespiegelte Logik. Läuft ohne DB.
// ---------------------------------------------------------------------------

describe("standortEingabeSchema (Unit, V1)", () => {
  const basis = {
    name: "Bürgerbüro Rathaus",
    address: "Aarstr. 150",
    oeffnungszeiten: [{ tag: 1, von: "09:00", bis: "12:00" }],
  };

  it("gültige Eingabe mit Öffnungszeiten wird akzeptiert (getrimmt)", () => {
    const r = standortEingabeSchema.safeParse({ ...basis, name: "  Bürgerbüro  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Bürgerbüro");
  });

  it("Öffnungszeiten: von ≥ bis wird abgelehnt", () => {
    const r = standortEingabeSchema.safeParse({
      ...basis,
      oeffnungszeiten: [{ tag: 1, von: "12:00", bis: "09:00" }],
    });
    expect(r.success).toBe(false);
    // Gleichstand (von == bis) ebenfalls ungültig.
    const gleich = standortEingabeSchema.safeParse({
      ...basis,
      oeffnungszeiten: [{ tag: 1, von: "09:00", bis: "09:00" }],
    });
    expect(gleich.success).toBe(false);
  });

  it("Öffnungszeiten: ungültige Uhrzeit (kein HH:MM) wird abgelehnt", () => {
    for (const bad of ["9:00", "24:00", "12:60", "abc"]) {
      const r = standortEingabeSchema.safeParse({
        ...basis,
        oeffnungszeiten: [{ tag: 1, von: bad, bis: "23:00" }],
      });
      expect(r.success, `${bad} sollte ungültig sein`).toBe(false);
    }
  });

  it("Öffnungszeiten: Wochentag außerhalb 1..7 wird abgelehnt", () => {
    for (const tag of [0, 8, -1]) {
      const r = standortEingabeSchema.safeParse({
        ...basis,
        oeffnungszeiten: [{ tag, von: "09:00", bis: "12:00" }],
      });
      expect(r.success, `Tag ${tag} sollte ungültig sein`).toBe(false);
    }
  });

  it("mehrere Fenster am selben Tag sind erlaubt", () => {
    const r = standortEingabeSchema.safeParse({
      ...basis,
      oeffnungszeiten: [
        { tag: 1, von: "09:00", bis: "12:00" },
        { tag: 1, von: "14:00", bis: "16:00" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("lat/lon paarweise: nur einer gesetzt wird abgelehnt", () => {
    const nurLat = standortEingabeSchema.safeParse({ ...basis, lat: 50.14 });
    expect(nurLat.success).toBe(false);
    const nurLon = standortEingabeSchema.safeParse({ ...basis, lon: 8.15 });
    expect(nurLon.success).toBe(false);
    const beide = standortEingabeSchema.safeParse({ ...basis, lat: 50.14, lon: 8.15 });
    expect(beide.success).toBe(true);
  });

  it("lat/lon außerhalb des Bereichs wird abgelehnt", () => {
    expect(standortEingabeSchema.safeParse({ ...basis, lat: 91, lon: 0 }).success).toBe(false);
    expect(standortEingabeSchema.safeParse({ ...basis, lat: 0, lon: 181 }).success).toBe(false);
    expect(standortEingabeSchema.safeParse({ ...basis, lat: -90, lon: -180 }).success).toBe(true);
  });

  it("Pflichtfeld-Regel: termin_erforderlich=true erlaubt fehlende Öffnungszeiten", () => {
    const r = standortEingabeSchema.safeParse({
      name: "Nur-Termin-Standort",
      address: "Musterweg 1",
      terminErforderlich: true,
    });
    expect(r.success).toBe(true);
  });

  it("Pflichtfeld-Regel: weder Öffnungszeiten noch Termin-Pflicht wird abgelehnt", () => {
    const leer = standortEingabeSchema.safeParse({
      name: "Leerer Standort",
      address: "Musterweg 1",
    });
    expect(leer.success).toBe(false);
    const leeresArray = standortEingabeSchema.safeParse({
      name: "Leerer Standort",
      address: "Musterweg 1",
      oeffnungszeiten: [],
      terminErforderlich: false,
    });
    expect(leeresArray.success).toBe(false);
  });

  it("Pflichtfeld-Regel: fehlende/leere Adresse wird abgelehnt", () => {
    const ohne = standortEingabeSchema.safeParse({
      name: "Kein-Adress-Standort",
      oeffnungszeiten: [{ tag: 1, von: "09:00", bis: "12:00" }],
    });
    expect(ohne.success).toBe(false);
    const leer = standortEingabeSchema.safeParse({ ...basis, address: "   " });
    expect(leer.success).toBe(false);
  });

  it("kontakt über 120 Zeichen wird abgelehnt", () => {
    const r = standortEingabeSchema.safeParse({ ...basis, kontakt: "x".repeat(121) });
    expect(r.success).toBe(false);
  });

  it("barrierefrei als Tri-State: true/false/null gültig", () => {
    for (const b of [true, false, null]) {
      expect(standortEingabeSchema.safeParse({ ...basis, barrierefrei: b }).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration (echte PG)
// ---------------------------------------------------------------------------

describe("Standort-Verwaltung (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let tenant2Id: string;
  let adminId: string;
  let counter = 0;

  function nextEmail(prefix: string) {
    return `${prefix}-${Date.now()}-${++counter}@standort-test.de`;
  }

  async function makeUser(tId: string) {
    const [u] = await db
      .insert(users)
      .values({
        tenantId: tId,
        email: nextEmail("u"),
        minAgeConfirmedAt: new Date(),
        verificationStatus: "pending",
      })
      .returning();
    return u.id;
  }

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [t1] = await db.insert(tenants).values({ slug: `st-${Date.now()}`, name: "ST" }).returning();
    tenantId = t1.id;
    const [t2] = await db.insert(tenants).values({ slug: `st2-${Date.now()}`, name: "ST2" }).returning();
    tenant2Id = t2.id;
    adminId = await makeUser(tenantId);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => expect(true).toBe(true));

  it.skipIf(SKIP)("Erstellen: Trigger setzt region_id auf den Gemeinde-Knoten; Audit PII-frei", async () => {
    const r = await standortErstellenCore(db as never, tenantId, adminId, {
      name: "Bürgerbüro Rathaus",
      address: "Aarstr. 150",
      hinweise: "Ausweis mitbringen",
    });
    expect(r.ok).toBe(true);
    expect(r.locationId).toBeTruthy();

    // region_id wurde NICHT gesetzt — der BEFORE-INSERT-Trigger leitet den
    // Gemeinde-Knoten des Tenants ab (ADR-024 Dual-Write-Netz).
    const [loc] = await db
      .select({ regionId: verificationLocations.regionId })
      .from(verificationLocations)
      .where(eq(verificationLocations.id, r.locationId!));
    expect(loc.regionId).not.toBeNull();
    const [region] = await db.select().from(regions).where(eq(regions.id, loc.regionId!));
    expect(region.typ).toBe("gemeinde");
    expect(region.tenantId).toBe(tenantId);

    // Audit verify_location.created: actorRef = Admin-UUID, keine E-Mail.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "verify_location.created"),
          eq(auditEvents.targetId, r.locationId!),
        ),
      );
    expect(audit.length).toBe(1);
    expect(audit[0].actorRef).toBe(adminId);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("Unique-Konflikt: gleicher Name im selben Tenant scheitert freundlich; anderer Tenant ok", async () => {
    const doppelt = await standortErstellenCore(db as never, tenantId, adminId, {
      name: "Bürgerbüro Rathaus",
    });
    expect(doppelt.ok).toBe(false);
    expect(doppelt.error).toMatch(/existiert bereits/);

    // Gleicher Name in ANDEREM Tenant ist erlaubt (UNIQUE ist tenant-scoped).
    const fremd = await standortErstellenCore(db as never, tenant2Id, adminId, {
      name: "Bürgerbüro Rathaus",
    });
    expect(fremd.ok).toBe(true);
  });

  it.skipIf(SKIP)("Bearbeiten: tenant-scoped; Unique-Konflikt beim Umbenennen", async () => {
    const a = await standortErstellenCore(db as never, tenantId, adminId, { name: "Standort A" });
    const b = await standortErstellenCore(db as never, tenantId, adminId, { name: "Standort B" });
    expect(a.ok && b.ok).toBe(true);

    const ok = await standortBearbeitenCore(db as never, tenantId, adminId, b.locationId!, {
      name: "Standort B neu",
      address: "Neue Str. 1",
    });
    expect(ok.ok).toBe(true);
    const [after] = await db
      .select()
      .from(verificationLocations)
      .where(eq(verificationLocations.id, b.locationId!));
    expect(after.name).toBe("Standort B neu");
    expect(after.address).toBe("Neue Str. 1");

    // Umbenennen auf einen existierenden Namen → freundlicher Konflikt.
    const konflikt = await standortBearbeitenCore(db as never, tenantId, adminId, b.locationId!, {
      name: "Standort A",
    });
    expect(konflikt.ok).toBe(false);
    expect(konflikt.error).toMatch(/existiert bereits/);

    // Tenant-Isolation: fremde tenantId trifft 0 Zeilen.
    const iso = await standortBearbeitenCore(db as never, tenant2Id, adminId, b.locationId!, {
      name: "Gekapert",
    });
    expect(iso.ok).toBe(false);
    expect(iso.error).toMatch(/nicht gefunden/);
  });

  it.skipIf(SKIP)("Einzeltermin: anlegen ok; Vergangenheit abgelehnt; onConflict zählt übersprungen", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Einzel-Standort" });
    const startsAt = new Date(Date.now() + 3 * DAY);

    const r = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt,
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.angelegt).toBe(1);
    expect(r.uebersprungen).toBe(0);

    // Identische Startzeit erneut → übersprungen (UNIQUE location+starts_at).
    const r2 = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt,
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    expect(r2.ok).toBe(true);
    expect(r2.angelegt).toBe(0);
    expect(r2.uebersprungen).toBe(1);

    // Vergangenheit → Fehler.
    const past = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() - DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    expect(past.ok).toBe(false);
    expect(past.error).toMatch(/Zukunft/);

    // Fremder Tenant sieht den Standort nicht (fail-closed).
    const iso = await sprechzeitenAnlegenCore(db as never, tenant2Id, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 4 * DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    expect(iso.ok).toBe(false);
    expect(iso.error).toMatch(/nicht gefunden/);
  });

  it.skipIf(SKIP)("Wochenserie: korrekte Anzahl + nur gewählte Wochentage; Wiederholung überspringt", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Serien-Standort" });
    // 14 Kalendertage ab morgen ⇒ jeder Wochentag genau 2×. Ein Wochentag,
    // 09:00–10:00 im 30-min-Raster ⇒ 2 Tage × 2 Slots = 4. Der gewählte
    // Wochentag (übermorgen+1) liegt sicher NICHT am heutigen Rand — kein
    // „09:00 heute schon vorbei"-Wackler.
    const vonDatum = isoPlusTage(1);
    const bisDatum = isoPlusTage(14);
    const wochentag = new Date(Date.now() + 3 * DAY).getUTCDay();

    const serie = {
      art: "serie" as const,
      vonDatum,
      bisDatum,
      wochentage: [wochentag],
      vonZeit: "09:00",
      bisZeit: "10:00",
      slotDauerMinuten: 30,
      kapazitaet: 3,
    };
    const r = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, serie);
    expect(r.ok).toBe(true);
    expect(r.angelegt).toBe(4);
    expect(r.uebersprungen).toBe(0);

    const { slots } = await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!);
    expect(slots.length).toBe(4);
    for (const s of slots) {
      expect(s.capacity).toBe(3);
      expect(berlinWandzeit(s.startsAt)).toMatch(/^09:(00|30)$/);
    }

    // Idempotenz: dieselbe Serie erneut → alles übersprungen.
    const r2 = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, serie);
    expect(r2.ok).toBe(true);
    expect(r2.angelegt).toBe(0);
    expect(r2.uebersprungen).toBe(4);
  });

  it.skipIf(SKIP)("Wochenserie: Cap 200 greift mit Anzahl im Fehler; 6-Monats-Horizont", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Cap-Standort" });

    // 35 Tage × alle Wochentage × 32 Slots/Tag (09–17 h, 15 min) ≈ 1120 > 200.
    const zuViel = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "serie",
      vonDatum: isoPlusTage(1),
      bisDatum: isoPlusTage(35),
      wochentage: [0, 1, 2, 3, 4, 5, 6],
      vonZeit: "09:00",
      bisZeit: "17:00",
      slotDauerMinuten: 15,
      kapazitaet: 1,
    });
    expect(zuViel.ok).toBe(false);
    expect(zuViel.error).toMatch(/200/);

    // Über den 6-Monats-Horizont hinaus → Fehler.
    const zuWeit = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "serie",
      vonDatum: isoPlusTage(1),
      bisDatum: isoPlusTage(8 * 30),
      wochentage: [1],
      vonZeit: "09:00",
      bisZeit: "10:00",
      slotDauerMinuten: 30,
      kapazitaet: 1,
    });
    expect(zuWeit.ok).toBe(false);
    expect(zuWeit.error).toMatch(/6 Monate/);
  });

  it.skipIf(SKIP)("slotLoeschen: mit Buchung abgelehnt, ohne Buchung gelöscht; tenant-scoped", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Lösch-Standort" });
    await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 5 * DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    const [slot] = (await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!)).slots;

    // Buchung über die ECHTE Buchungs-Logik.
    const buerger = await makeUser(tenantId);
    const b = await bookSlotCore(db as never, tenantId, buerger, slot.slotId);
    expect(b.ok).toBe(true);

    // Mit Buchung NICHT löschbar (fail-closed, atomar).
    const mitBuchung = await slotLoeschenCore(db as never, tenantId, adminId, slot.slotId);
    expect(mitBuchung.ok).toBe(false);
    expect(mitBuchung.error).toMatch(/Buchungen/);

    // Zweiter Slot ohne Buchung: fremder Tenant trifft 0 Zeilen, eigener löscht.
    await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 6 * DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    const { slots } = await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!);
    const frei = slots.find((s) => s.bookedCount === 0)!;
    const iso = await slotLoeschenCore(db as never, tenant2Id, adminId, frei.slotId);
    expect(iso.ok).toBe(false);
    const del = await slotLoeschenCore(db as never, tenantId, adminId, frei.slotId);
    expect(del.ok).toBe(true);
    const [weg] = await db
      .select()
      .from(verificationSlots)
      .where(eq(verificationSlots.id, frei.slotId));
    expect(weg).toBeUndefined();
  });

  it.skipIf(SKIP)("Kapazität: unter booked_count abgelehnt; gültig geändert; tenant-scoped", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Kap-Standort" });
    await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 7 * DAY),
      dauerMinuten: 30,
      kapazitaet: 3,
    });
    const [slot] = (await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!)).slots;

    const b1 = await bookSlotCore(db as never, tenantId, await makeUser(tenantId), slot.slotId);
    const b2 = await bookSlotCore(db as never, tenantId, await makeUser(tenantId), slot.slotId);
    expect(b1.ok && b2.ok).toBe(true);

    // 2 Buchungen ⇒ Kapazität 1 läge darunter → freundlicher Fehler.
    const zuKlein = await slotKapazitaetAendernCore(db as never, tenantId, adminId, slot.slotId, 1);
    expect(zuKlein.ok).toBe(false);
    expect(zuKlein.error).toMatch(/Buchungen|nicht gefunden/);

    // Fremder Tenant trifft 0 Zeilen.
    const iso = await slotKapazitaetAendernCore(db as never, tenant2Id, adminId, slot.slotId, 5);
    expect(iso.ok).toBe(false);

    // Gültige Erhöhung.
    const ok = await slotKapazitaetAendernCore(db as never, tenantId, adminId, slot.slotId, 5);
    expect(ok.ok).toBe(true);
    const [after] = await db
      .select()
      .from(verificationSlots)
      .where(eq(verificationSlots.id, slot.slotId));
    expect(after.capacity).toBe(5);

    // Außerhalb 1..20 → Fehler (ohne DB-Treffer).
    const zuGross = await slotKapazitaetAendernCore(db as never, tenantId, adminId, slot.slotId, 21);
    expect(zuGross.ok).toBe(false);
  });

  it.skipIf(SKIP)("Deaktivieren: keine neuen Sprechzeiten/Buchungen, bestehender Termin bleibt für Verifier sichtbar", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Deakt-Standort" });
    await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 8 * DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    const [slot] = (await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!)).slots;
    const buerger = await makeUser(tenantId);
    const buchung = await bookSlotCore(db as never, tenantId, buerger, slot.slotId);
    expect(buchung.ok).toBe(true);

    // Tenant-Isolation + Deaktivieren (idempotenzfest: zweiter Aufruf 0 Zeilen).
    const iso = await standortAktivSetzenCore(db as never, tenant2Id, adminId, st.locationId!, false);
    expect(iso.ok).toBe(false);
    const deakt = await standortAktivSetzenCore(db as never, tenantId, adminId, st.locationId!, false);
    expect(deakt.ok).toBe(true);
    const nochmal = await standortAktivSetzenCore(db as never, tenantId, adminId, st.locationId!, false);
    expect(nochmal.ok).toBe(false);

    // Keine NEUEN Sprechzeiten am deaktivierten Standort (fail-closed).
    const neu = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 9 * DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    expect(neu.ok).toBe(false);
    expect(neu.error).toMatch(/deaktiviert/);

    // Bürger-Sicht: der Standort taucht nicht mehr auf …
    const buergerSicht = await getStandorteMitFreienSlots(db as never, tenantId);
    expect(buergerSicht.find((s) => s.name === "Deakt-Standort")).toBeUndefined();

    // … aber der BESTEHENDE offene Termin bleibt in der Verifier-Liste
    // (getOffeneTermineFuerVerifier filtert bewusst NICHT auf isActive).
    const verifierListe = await getOffeneTermineFuerVerifier(db as never, tenantId);
    expect(
      verifierListe.find((t) => t.bookingId === buchung.booking!.bookingId),
    ).toBeTruthy();

    // Reaktivieren funktioniert.
    const reakt = await standortAktivSetzenCore(db as never, tenantId, adminId, st.locationId!, true);
    expect(reakt.ok).toBe(true);
  });

  it.skipIf(SKIP)("getStandorteFuerAdmin: enthält auch inaktive Standorte + korrekte Kennzahlen", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Kennzahl-Standort" });
    await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 10 * DAY),
      dauerMinuten: 30,
      kapazitaet: 4,
    });
    const [slot] = (await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!)).slots;
    const b = await bookSlotCore(db as never, tenantId, await makeUser(tenantId), slot.slotId);
    expect(b.ok).toBe(true);
    await standortAktivSetzenCore(db as never, tenantId, adminId, st.locationId!, false);

    const admin = await getStandorteFuerAdmin(db as never, tenantId);
    const eintrag = admin.find((s) => s.name === "Kennzahl-Standort");
    expect(eintrag).toBeTruthy();
    expect(eintrag!.isActive).toBe(false); // Admin sieht auch Deaktivierte
    expect(eintrag!.kommendeSlots).toBe(1);
    expect(eintrag!.freiePlaetze).toBe(3); // 4 Kapazität − 1 Buchung
    expect(eintrag!.offeneBuchungen).toBe(1);

    // Tenant-Isolation der Admin-Sicht.
    const fremd = await getStandorteFuerAdmin(db as never, tenant2Id);
    expect(fremd.find((s) => s.name === "Kennzahl-Standort")).toBeUndefined();
  });

  it.skipIf(SKIP)("V1: Erstellen persistiert Öffnungszeiten/Termin/Barrierefrei/Kontakt/Koordinaten; Query liest sie", async () => {
    const oeffnung = [
      { tag: 1, von: "09:00", bis: "12:00" },
      { tag: 3, von: "14:00", bis: "18:00" },
    ];
    const r = await standortErstellenCore(db as never, tenantId, adminId, {
      name: "V1-Standort",
      address: "Aarstr. 200",
      oeffnungszeiten: oeffnung,
      terminErforderlich: false,
      barrierefrei: true,
      kontakt: "06128 / 000-0",
      lat: 50.1409,
      lon: 8.1508,
    });
    expect(r.ok).toBe(true);

    // Direkt aus der DB: jsonb-Rundlauf + Spaltenwerte.
    const [loc] = await db
      .select()
      .from(verificationLocations)
      .where(eq(verificationLocations.id, r.locationId!));
    expect(loc.oeffnungszeiten).toEqual(oeffnung);
    expect(loc.terminErforderlich).toBe(false);
    expect(loc.barrierefrei).toBe(true);
    expect(loc.kontakt).toBe("06128 / 000-0");
    expect(Number(loc.lat)).toBeCloseTo(50.1409, 4);
    expect(Number(loc.lon)).toBeCloseTo(8.1508, 4);

    // Admin-Query liefert die Felder typisiert (lat/lon als number).
    const admin = await getStandorteFuerAdmin(db as never, tenantId);
    const eintrag = admin.find((s) => s.name === "V1-Standort")!;
    expect(eintrag.oeffnungszeiten).toEqual(oeffnung);
    expect(eintrag.terminErforderlich).toBe(false);
    expect(eintrag.barrierefrei).toBe(true);
    expect(eintrag.kontakt).toBe("06128 / 000-0");
    expect(eintrag.lat).toBeCloseTo(50.1409, 4);
    expect(eintrag.lon).toBeCloseTo(8.1508, 4);
  });

  it.skipIf(SKIP)("V1: leere Öffnungszeiten werden als NULL gespeichert; Bearbeiten aktualisiert die Felder", async () => {
    // Nur-Termin-Standort: leeres Öffnungszeiten-Array → NULL in der DB.
    const r = await standortErstellenCore(db as never, tenantId, adminId, {
      name: "V1-Termin-Standort",
      address: "Musterweg 1",
      oeffnungszeiten: [],
      terminErforderlich: true,
    });
    expect(r.ok).toBe(true);
    const [vor] = await db
      .select()
      .from(verificationLocations)
      .where(eq(verificationLocations.id, r.locationId!));
    expect(vor.oeffnungszeiten).toBeNull();
    expect(vor.terminErforderlich).toBe(true);
    expect(vor.barrierefrei).toBeNull(); // Tri-State: unbekannt

    // Bearbeiten setzt Öffnungszeiten + Koordinaten, entfernt Termin-Pflicht.
    const upd = await standortBearbeitenCore(db as never, tenantId, adminId, r.locationId!, {
      name: "V1-Termin-Standort",
      address: "Musterweg 1",
      oeffnungszeiten: [{ tag: 5, von: "08:00", bis: "13:00" }],
      terminErforderlich: false,
      barrierefrei: false,
      lat: 49.0,
      lon: 8.4,
    });
    expect(upd.ok).toBe(true);
    const [nach] = await db
      .select()
      .from(verificationLocations)
      .where(eq(verificationLocations.id, r.locationId!));
    expect(nach.oeffnungszeiten).toEqual([{ tag: 5, von: "08:00", bis: "13:00" }]);
    expect(nach.terminErforderlich).toBe(false);
    expect(nach.barrierefrei).toBe(false);
    expect(Number(nach.lat)).toBeCloseTo(49.0, 4);
  });

  // --- Gate-B-Folge-Härtung ------------------------------------------------

  it.skipIf(SKIP)("Serie: vonDatum in der Vergangenheit wird abgelehnt (Event-Loop-Schutz)", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Vergangenheits-Standort" });
    const r = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "serie",
      vonDatum: isoPlusTage(-30),
      bisDatum: isoPlusTage(2),
      wochentage: [0, 1, 2, 3, 4, 5, 6],
      vonZeit: "09:00",
      bisZeit: "10:00",
      slotDauerMinuten: 30,
      kapazitaet: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Vergangenheit/);
  });

  it.skipIf(SKIP)("Einzeltermin: derselbe 6-Monats-Horizont wie die Serie (kein Jahr-9999-Slot)", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Horizont-Standort" });
    const r = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 8 * 30 * DAY), // ~8 Monate
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/6 Monate/);
    // Es ist KEIN Slot entstanden.
    const { gesamt } = await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!);
    expect(gesamt).toBe(0);
  });

  it.skipIf(SKIP)("Überlappung: zeitlich versetzte Slots werden übersprungen (keine Doppel-Kapazität)", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Überlapp-Standort" });
    const basis = Date.now() + 20 * DAY;
    const erster = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(basis),
      dauerMinuten: 60,
      kapazitaet: 2,
    });
    expect(erster.ok).toBe(true);
    expect(erster.angelegt).toBe(1);

    // 30 min versetzt, überlappt den bestehenden Slot → übersprungen, NICHT
    // angelegt (das UNIQUE auf starts_at allein hätte das durchgelassen).
    const versetzt = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(basis + 30 * 60_000),
      dauerMinuten: 60,
      kapazitaet: 2,
    });
    expect(versetzt.ok).toBe(true);
    expect(versetzt.angelegt).toBe(0);
    expect(versetzt.uebersprungen).toBe(1);

    // Direkt anschließend (Start = Ende des ersten) überlappt NICHT → angelegt.
    const anschliessend = await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(basis + 60 * 60_000),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    expect(anschliessend.ok).toBe(true);
    expect(anschliessend.angelegt).toBe(1);

    const { gesamt } = await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!);
    expect(gesamt).toBe(2);
  });

  it.skipIf(SKIP)("Verifizierungs-Nachweis: Slot mit wahrgenommener Buchung bleibt unlöschbar (booked_count-Invariante)", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Nachweis-Standort" });
    await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 21 * DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    const [slot] = (await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!)).slots;
    const buerger = await makeUser(tenantId);
    const b = await bookSlotCore(db as never, tenantId, buerger, slot.slotId);
    expect(b.ok).toBe(true);

    // Wahrnehmen (Stufe-2-Nachweis) gibt die Kapazität NICHT zurück —
    // booked_count bleibt >= Anzahl wahrgenommener Buchungen …
    const w = await bookingWahrnehmenCore(db as never, tenantId, adminId, b.booking!.bookingId);
    expect(w.ok).toBe(true);
    const [after] = await db
      .select()
      .from(verificationSlots)
      .where(eq(verificationSlots.id, slot.slotId));
    expect(after.bookedCount).toBe(1);

    // … und damit schließt die booked_count=0-Bedingung des DELETEs Slots mit
    // Wahrnehmungs-Nachweis strukturell aus (kein CASCADE-Verlust der Historie).
    const del = await slotLoeschenCore(db as never, tenantId, adminId, slot.slotId);
    expect(del.ok).toBe(false);
  });

  it.skipIf(SKIP)("Race: Slot wird während der Buchung gelöscht → freundlicher Fehler statt 500 (FK 23503)", async () => {
    const st = await standortErstellenCore(db as never, tenantId, adminId, { name: "Race-Standort" });
    await sprechzeitenAnlegenCore(db as never, tenantId, adminId, st.locationId!, {
      art: "einzeln",
      startsAt: new Date(Date.now() + 22 * DAY),
      dauerMinuten: 30,
      kapazitaet: 2,
    });
    const [slot] = (await getSlotsFuerStandortAdmin(db as never, tenantId, st.locationId!)).slots;

    // Das Race deterministisch nachstellen: der Slot verschwindet GENAU
    // zwischen dem Vorab-Select von bookSlotCore und seiner Transaktion —
    // ein Proxy löscht ihn unmittelbar vor db.transaction (echte FK-23503-
    // Verletzung beim Buchungs-Insert, keine gespiegelte Logik).
    const echteDb = db as unknown as Record<string | symbol, unknown>;
    const racedDb = new Proxy(echteDb, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (cb: unknown) => {
            await db.delete(verificationSlots).where(eq(verificationSlots.id, slot.slotId));
            return (target.transaction as (cb2: unknown) => Promise<unknown>).call(target, cb);
          };
        }
        const wert = Reflect.get(target, prop);
        return typeof wert === "function" ? (wert as (...a: unknown[]) => unknown).bind(target) : wert;
      },
    });

    const r = await bookSlotCore(racedDb as never, tenantId, await makeUser(tenantId), slot.slotId);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nicht mehr verfügbar/);
  });
});

// ---------------------------------------------------------------------------
// Verifizierung 2.0 / V2 — Bürger-Sicht „Stellen in Ihrer Nähe"
// (standorteInDerNaehe): Distanz-Sortierung, Standorte ohne Koordinaten ans
// Ende, Tenant-Isolation, isActive-Filter. Ruft die ECHTE Query.
// ---------------------------------------------------------------------------
describe("standorteInDerNaehe (Integration, V2)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;
  let tenant2Id: string;
  let adminId: string;

  // Referenzpunkt für die Distanz (nahe „B").
  const REF = { lat: 50.15, lon: 8.15 };

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [t1] = await db.insert(tenants).values({ slug: `nh-${Date.now()}`, name: "NH" }).returning();
    tenantId = t1.id;
    const [t2] = await db.insert(tenants).values({ slug: `nh2-${Date.now()}`, name: "NH2" }).returning();
    tenant2Id = t2.id;
    const [u] = await db
      .insert(users)
      .values({ tenantId, email: `nh-${Date.now()}@nh-test.de`, minAgeConfirmedAt: new Date(), verificationStatus: "pending" })
      .returning();
    adminId = u.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt", () => expect(true).toBe(true));

  it.skipIf(SKIP)("sortiert MIT Koordinaten nach Distanz aufsteigend, ohne Koordinaten ans Ende (alphabetisch)", async () => {
    // A-fern (weit), B-nah (nah am Ref), C-ohne + D-ohne (keine Koordinaten).
    await standortErstellenCore(db as never, tenantId, adminId, { name: "A-fern", address: "x", lat: 50.30, lon: 8.15 });
    await standortErstellenCore(db as never, tenantId, adminId, { name: "B-nah", address: "x", lat: 50.16, lon: 8.15 });
    await standortErstellenCore(db as never, tenantId, adminId, { name: "C-ohne", address: "x" });
    await standortErstellenCore(db as never, tenantId, adminId, { name: "D-ohne", address: "x" });

    const liste = await standorteInDerNaehe(db as never, tenantId, REF.lat, REF.lon);
    expect(liste.map((s) => s.name)).toEqual(["B-nah", "A-fern", "C-ohne", "D-ohne"]);

    const b = liste[0];
    const a = liste[1];
    expect(b.distanzKm).not.toBeNull();
    expect(a.distanzKm).not.toBeNull();
    expect(b.distanzKm! < a.distanzKm!).toBe(true);
    // Ohne Koordinaten → keine Distanz.
    expect(liste[2].distanzKm).toBeNull();
    expect(liste[3].distanzKm).toBeNull();
  });

  it.skipIf(SKIP)("ohne Referenzpunkt → keine Distanz, rein alphabetische Liste", async () => {
    const liste = await standorteInDerNaehe(db as never, tenantId);
    expect(liste.map((s) => s.name)).toEqual(["A-fern", "B-nah", "C-ohne", "D-ohne"]);
    for (const s of liste) expect(s.distanzKm).toBeNull();
  });

  it.skipIf(SKIP)("Tenant-Isolation: fremde Standorte tauchen nicht auf", async () => {
    await standortErstellenCore(db as never, tenant2Id, adminId, { name: "Fremd-Standort", address: "x", lat: 50.15, lon: 8.15 });
    const liste = await standorteInDerNaehe(db as never, tenantId, REF.lat, REF.lon);
    expect(liste.some((s) => s.name === "Fremd-Standort")).toBe(false);
    // Gegenprobe: im anderen Tenant ist er da.
    const liste2 = await standorteInDerNaehe(db as never, tenant2Id, REF.lat, REF.lon);
    expect(liste2.some((s) => s.name === "Fremd-Standort")).toBe(true);
  });

  it.skipIf(SKIP)("deaktivierte Standorte werden ausgeblendet", async () => {
    const r = await standortErstellenCore(db as never, tenantId, adminId, { name: "E-inaktiv", address: "x", lat: 50.16, lon: 8.15 });
    await standortAktivSetzenCore(db as never, tenantId, adminId, r.locationId!, false);
    const liste = await standorteInDerNaehe(db as never, tenantId, REF.lat, REF.lon);
    expect(liste.some((s) => s.name === "E-inaktiv")).toBe(false);
  });
});
