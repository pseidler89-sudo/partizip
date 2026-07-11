/**
 * booking-queries.ts — Lese-Queries der Termin-Buchung (Server-Component-Nutzung).
 *
 * BEWUSST OHNE "use server" (Muster polls/queries.ts, Gate-B MAJOR-G): reine,
 * tenant-scoped Lesezugriffe. Lägen sie in der "use server"-Datei, würde Next.js
 * sie als client-aufrufbare RPC mit client-kontrolliertem tenantId exponieren.
 *
 * Die Verifier-Liste ist PII-frei (Termin-Code statt Name/E-Mail).
 */

import { and, eq, gt, asc, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  verificationBookings,
  verificationSlots,
  verificationLocations,
} from "@/db/schema";

export interface FreierSlot {
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  /** Verbleibende freie Plätze (capacity - booked_count, > 0). */
  frei: number;
}

export interface StandortMitSlots {
  locationId: string;
  name: string;
  address: string | null;
  hinweise: string | null;
  slots: FreierSlot[];
}

/**
 * Aktive Standorte mit ihren NOCH FREIEN, in der Zukunft liegenden Slots
 * (tenant-scoped), aufsteigend nach Zeit. Standorte ohne freie Slots werden mit
 * leerer Slot-Liste zurückgegeben (die UI kann „derzeit keine Termine" zeigen).
 */
export async function getStandorteMitFreienSlots(
  db: Db,
  tenantId: string,
): Promise<StandortMitSlots[]> {
  const locs = await db
    .select({
      id: verificationLocations.id,
      name: verificationLocations.name,
      address: verificationLocations.address,
      hinweise: verificationLocations.hinweise,
    })
    .from(verificationLocations)
    .where(
      and(
        eq(verificationLocations.tenantId, tenantId),
        eq(verificationLocations.isActive, true),
      ),
    )
    .orderBy(asc(verificationLocations.name));

  if (locs.length === 0) return [];

  // Freie, zukünftige Slots aktiver Standorte des Tenants (ein Rutsch, dann zuordnen).
  const slotRows = await db
    .select({
      slotId: verificationSlots.id,
      locationId: verificationSlots.locationId,
      startsAt: verificationSlots.startsAt,
      endsAt: verificationSlots.endsAt,
      capacity: verificationSlots.capacity,
      bookedCount: verificationSlots.bookedCount,
    })
    .from(verificationSlots)
    .innerJoin(
      verificationLocations,
      eq(verificationLocations.id, verificationSlots.locationId),
    )
    .where(
      and(
        eq(verificationLocations.tenantId, tenantId),
        eq(verificationLocations.isActive, true),
        gt(verificationSlots.startsAt, sql`now()`),
        sql`${verificationSlots.bookedCount} < ${verificationSlots.capacity}`,
      ),
    )
    .orderBy(asc(verificationSlots.startsAt));

  type SlotRow = (typeof slotRows)[number];
  const byLoc = new Map<string, FreierSlot[]>();
  for (const s of slotRows as SlotRow[]) {
    const list = byLoc.get(s.locationId) ?? [];
    list.push({
      slotId: s.slotId,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      frei: s.capacity - s.bookedCount,
    });
    byLoc.set(s.locationId, list);
  }

  return locs.map((l: { id: string; name: string; address: string | null; hinweise: string | null }) => ({
    locationId: l.id,
    name: l.name,
    address: l.address,
    hinweise: l.hinweise,
    slots: byLoc.get(l.id) ?? [],
  }));
}

export interface MeinTermin {
  bookingId: string;
  code: string;
  startsAt: Date;
  endsAt: Date;
  locationName: string;
  locationAddress: string | null;
  locationHinweise: string | null;
}

/**
 * Der aktuell offene Termin des eingeloggten Users (oder null). Tenant-scoped.
 * Vergangene/abgesagte/wahrgenommene Termine werden NICHT zurückgegeben.
 */
export async function getMeinOffenerTermin(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<MeinTermin | null> {
  const rows = await db
    .select({
      bookingId: verificationBookings.id,
      code: verificationBookings.code,
      startsAt: verificationSlots.startsAt,
      endsAt: verificationSlots.endsAt,
      locationName: verificationLocations.name,
      locationAddress: verificationLocations.address,
      locationHinweise: verificationLocations.hinweise,
    })
    .from(verificationBookings)
    .innerJoin(verificationSlots, eq(verificationSlots.id, verificationBookings.slotId))
    .innerJoin(
      verificationLocations,
      eq(verificationLocations.id, verificationSlots.locationId),
    )
    .where(
      and(
        eq(verificationBookings.tenantId, tenantId),
        eq(verificationBookings.userId, userId),
        eq(verificationBookings.status, "gebucht"),
        // Nur zukünftige offene Termine zählen als „mein Termin" — ein vergangener
        // No-Show soll den Bürger nicht im Hub/Redirect festhalten (er verfällt bei
        // der nächsten Buchung, siehe expireVergangeneTermine).
        gt(verificationSlots.startsAt, sql`now()`),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export interface VerifierTermin {
  bookingId: string;
  code: string;
  startsAt: Date;
  endsAt: Date;
  locationName: string;
}

/**
 * Offene Termine des Tenants für die Verifier-Liste (PII-FREI: nur Termin-Code +
 * Zeit + Standort, KEIN Name/keine E-Mail). Aufsteigend nach Zeit. Tenant-scoped.
 *
 * Bewusst inkl. zurückliegender, noch offener Termine (jemand erscheint kurz nach
 * Slot-Beginn) — aber NUR innerhalb der letzten 24 h, damit wochenalte No-Shows
 * nicht dauerhaft „wahrnehmbar" bleiben (deckungsgleich mit dem Zeit-Guard in
 * bookingWahrnehmenCore). Der Verifier bestätigt über den vom Bürger gezeigten Code.
 */
export async function getOffeneTermineFuerVerifier(
  db: Db,
  tenantId: string,
): Promise<VerifierTermin[]> {
  return db
    .select({
      bookingId: verificationBookings.id,
      code: verificationBookings.code,
      startsAt: verificationSlots.startsAt,
      endsAt: verificationSlots.endsAt,
      locationName: verificationLocations.name,
    })
    .from(verificationBookings)
    .innerJoin(verificationSlots, eq(verificationSlots.id, verificationBookings.slotId))
    .innerJoin(
      verificationLocations,
      eq(verificationLocations.id, verificationSlots.locationId),
    )
    .where(
      and(
        eq(verificationBookings.tenantId, tenantId),
        eq(verificationBookings.status, "gebucht"),
        gt(verificationSlots.startsAt, sql`now() - interval '1 day'`),
      ),
    )
    .orderBy(asc(verificationSlots.startsAt));
}
