/**
 * standort-queries.ts — Lese-Queries der Standort-Verwaltung (Block K1,
 * Server-Component-Nutzung, NUR Admin-Seiten).
 *
 * BEWUSST OHNE "use server" (Muster booking-queries.ts, Gate-B MAJOR-G): reine,
 * tenant-scoped Lesezugriffe. Lägen sie in der "use server"-Datei, würde
 * Next.js sie als client-aufrufbare RPC mit client-kontrolliertem tenantId
 * exponieren.
 *
 * Anders als getStandorteMitFreienSlots (Bürger-Sicht) liefert die Admin-Sicht
 * ALLE Standorte — auch deaktivierte (der Admin soll sie reaktivieren können).
 */

import { and, eq, gt, asc, count, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  verificationBookings,
  verificationLocations,
  verificationSlots,
} from "@/db/schema";

export interface StandortAdminItem {
  locationId: string;
  name: string;
  address: string | null;
  hinweise: string | null;
  isActive: boolean;
  /** Anzahl künftiger Slots (starts_at > now()). */
  kommendeSlots: number;
  /** Summe freier Plätze über die künftigen Slots (capacity - booked_count). */
  freiePlaetze: number;
  /**
   * Offene Buchungen (status='gebucht') im Verifier-Fenster (starts_at >
   * now() - 1 Tag) — deckungsgleich mit getOffeneTermineFuerVerifier, damit
   * die Admin-Kennzahl zeigt, was Verifier tatsächlich noch abarbeiten
   * (wochenalte No-Shows zählen nicht mehr).
   */
  offeneBuchungen: number;
}

/**
 * Alle Standorte des Tenants (auch inaktive) mit Kennzahlen für die
 * Admin-Übersicht. Aggregation je Standort in einem Rutsch (GROUP BY) statt
 * N+1-Queries; Zeitvergleiche über DB-now() (kein JS-Date in Roh-SQL).
 */
export async function getStandorteFuerAdmin(
  db: Db,
  tenantId: string,
): Promise<StandortAdminItem[]> {
  const locs = await db
    .select({
      id: verificationLocations.id,
      name: verificationLocations.name,
      address: verificationLocations.address,
      hinweise: verificationLocations.hinweise,
      isActive: verificationLocations.isActive,
    })
    .from(verificationLocations)
    .where(eq(verificationLocations.tenantId, tenantId))
    .orderBy(asc(verificationLocations.name));

  if (locs.length === 0) return [];

  // Künftige Slots + freie Plätze je Standort (tenant-scoped über den Join).
  const slotAgg = await db
    .select({
      locationId: verificationSlots.locationId,
      kommende: count(verificationSlots.id),
      frei: sql<number>`COALESCE(SUM(${verificationSlots.capacity} - ${verificationSlots.bookedCount}), 0)::int`,
    })
    .from(verificationSlots)
    .innerJoin(
      verificationLocations,
      eq(verificationLocations.id, verificationSlots.locationId),
    )
    .where(
      and(
        eq(verificationLocations.tenantId, tenantId),
        gt(verificationSlots.startsAt, sql`now()`),
      ),
    )
    .groupBy(verificationSlots.locationId);

  // Offene Buchungen im Verifier-Fenster (siehe StandortAdminItem-JSDoc).
  const bookingAgg = await db
    .select({
      locationId: verificationSlots.locationId,
      offen: count(verificationBookings.id),
    })
    .from(verificationBookings)
    .innerJoin(
      verificationSlots,
      eq(verificationSlots.id, verificationBookings.slotId),
    )
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
    .groupBy(verificationSlots.locationId);

  // Explizite Zeilentypen (Muster booking-queries.ts): die Aggregat-Selects
  // inferieren in TS strict sonst zu `{}`.
  type SlotAggRow = { locationId: string; kommende: number; frei: number };
  type BookingAggRow = { locationId: string; offen: number };
  type LocRow = {
    id: string;
    name: string;
    address: string | null;
    hinweise: string | null;
    isActive: boolean;
  };
  const slotsByLoc = new Map<string, SlotAggRow>(
    (slotAgg as SlotAggRow[]).map((r) => [r.locationId, r]),
  );
  const bookingsByLoc = new Map<string, number>(
    (bookingAgg as BookingAggRow[]).map((r) => [r.locationId, r.offen]),
  );

  return (locs as LocRow[]).map((l) => ({
    locationId: l.id,
    name: l.name,
    address: l.address,
    hinweise: l.hinweise,
    isActive: l.isActive,
    kommendeSlots: Number(slotsByLoc.get(l.id)?.kommende ?? 0),
    freiePlaetze: Number(slotsByLoc.get(l.id)?.frei ?? 0),
    offeneBuchungen: Number(bookingsByLoc.get(l.id) ?? 0),
  }));
}

export interface SlotAdminItem {
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  bookedCount: number;
}

/** Anzeige-Obergrenze der Slot-Liste je Standort (Schutz vor Riesen-Seiten). */
export const SLOTS_ADMIN_MAX = 300;

/**
 * Künftige Slots eines Standorts (aufsteigend), tenant-scoped über den
 * Standort-Join (verification_slots trägt keine tenant_id). Max 300.
 */
export async function getSlotsFuerStandortAdmin(
  db: Db,
  tenantId: string,
  locationId: string,
): Promise<SlotAdminItem[]> {
  return db
    .select({
      slotId: verificationSlots.id,
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
        eq(verificationSlots.locationId, locationId),
        gt(verificationSlots.startsAt, sql`now()`),
      ),
    )
    .orderBy(asc(verificationSlots.startsAt))
    .limit(SLOTS_ADMIN_MAX);
}
