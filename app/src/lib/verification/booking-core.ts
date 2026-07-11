/**
 * booking-core.ts — Reine DB-Logik der Termin-Buchung (D6 Verify-Hub).
 *
 * BEWUSST OHNE "use server" und ohne Request-Kontext: nimmt db/tenantId/userId als
 * PARAMETER (wie qr-core). Dadurch von den Actions wiederverwendbar UND als ECHTE
 * Funktion in DB-Integrationstests aufrufbar (keine Spiegelung der Logik).
 *
 * SICHERHEITS-KERN (wie QR-Cap, race-frei über DB-now()):
 *   - bookSlotCore: atomarer bedingter UPDATE auf booked_count (< capacity, Slot in
 *     der Zukunft). Ein offener Termin je Bürger (partielles UNIQUE) + Termin-Code
 *     (CSPRNG, je Tenant eindeutig, kollisionssicher via onConflictDoNothing+Retry).
 *   - cancelBookingCore: atomarer Status-Übergang (nur eigener, offener Termin) +
 *     Kapazität wieder freigeben (GREATEST(.. - 1, 0)).
 *   - bookingWahrnehmenCore: NUR über die Action durch canVerify aufrufbar — setzt
 *     die Person auf wohnsitz-verifiziert (Stufe 2, method='in_person', 24 Monate).
 *   - Tenant-Isolation: tenant_id-Redundanz + Slot→Location-Join. Audit PII-frei.
 *   - KEIN JS-Date in Roh-`sql` — Zeitvergleiche über DB-now() / Drizzle-Operatoren.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  verificationBookings,
  verificationSlots,
  verificationLocations,
  auditEvents,
} from "@/db/schema";
import { grantResidency } from "@/lib/verification/qr-core";
import { generateReadableCode, readableCodePattern } from "@/lib/readable-code";

export const BOOKING_CODE_PREFIX = "TERMIN";
export const BOOKING_CODE_PATTERN = readableCodePattern(BOOKING_CODE_PREFIX);

/** Erzeugt einen vorlesbaren Termin-Code (z. B. "TERMIN-7F3A-K29Q", 40 Bit CSPRNG). */
export function generateBookingCode(): string {
  return generateReadableCode(BOOKING_CODE_PREFIX);
}

/** Interner Marker-Fehler für den atomaren Kapazitäts-Rollback. */
export class SlotFullError extends Error {
  constructor() {
    super("slot-full-or-past");
    this.name = "SlotFullError";
  }
}

/**
 * Lazy-Verfall: setzt vergangene, NICHT wahrgenommene Termine eines Bürgers auf
 * 'storniert'. Sonst hielte ein No-Show das partielle One-Open-UNIQUE dauerhaft
 * besetzt und sperrte jede Neubuchung. Kapazität wird NICHT zurückgegeben
 * (vergangene Slots sind ohnehin nicht mehr buchbar). Audit PII-frei.
 * Wird zu Beginn von bookSlotCore aufgerufen (genau dann, wenn die Freigabe zählt).
 */
export async function expireVergangeneTermine(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<number> {
  const expired = await db
    .update(verificationBookings)
    .set({ status: "storniert" })
    .where(
      and(
        eq(verificationBookings.tenantId, tenantId),
        eq(verificationBookings.userId, userId),
        eq(verificationBookings.status, "gebucht"),
        // Tenant-scoped (Defense-in-Depth): nur Slots dieses Tenants, in der Vergangenheit.
        sql`${verificationBookings.slotId} IN (SELECT s.id FROM verification_slots s JOIN verification_locations l ON l.id = s.location_id WHERE l.tenant_id = ${tenantId} AND s.starts_at <= now())`,
      ),
    )
    .returning({ id: verificationBookings.id });

  for (const b of expired) {
    await db.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: userId,
      action: "verification.booking_expired",
      targetType: "verification_booking",
      targetId: b.id,
      metadata: { bookingId: b.id },
    });
  }
  return expired.length;
}

export interface BookedSlotInfo {
  bookingId: string;
  code: string;
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  locationName: string;
  locationAddress: string | null;
}

export interface BookSlotResult {
  ok: boolean;
  /** true ⇒ der Bürger hat bereits einen offenen Termin (kein neuer gebucht). */
  alreadyBooked?: boolean;
  booking?: BookedSlotInfo;
  error?: string;
}

/**
 * Bucht einen freien, in der Zukunft liegenden Slot für einen EINGELOGGTEN User
 * (Stufe ≥ 1 — die Action erzwingt das). Race-frei:
 *   1. Slot tenant-scoped laden (Join auf Location: tenant + aktiv + Zeiten).
 *   2. Vorab-Check „schon offener Termin?" (freundliche Meldung).
 *   3. Transaktion: Buchung einfügen (Termin-Code kollisionssicher; partielles
 *      UNIQUE blockt einen zweiten offenen Termin hart) → atomare bedingte
 *      Kapazitäts-Erhöhung (< capacity, starts_at > now()) → 0 Rows ⇒ voll/vorbei
 *      ⇒ SlotFullError ⇒ Rollback. Audit PII-frei.
 */
export async function bookSlotCore(
  db: Db,
  tenantId: string,
  userId: string,
  slotId: string,
): Promise<BookSlotResult> {
  const found = await db
    .select({
      slotId: verificationSlots.id,
      startsAt: verificationSlots.startsAt,
      endsAt: verificationSlots.endsAt,
      capacity: verificationSlots.capacity,
      bookedCount: verificationSlots.bookedCount,
      locName: verificationLocations.name,
      locAddress: verificationLocations.address,
      locActive: verificationLocations.isActive,
    })
    .from(verificationSlots)
    .innerJoin(
      verificationLocations,
      eq(verificationLocations.id, verificationSlots.locationId),
    )
    .where(
      and(
        eq(verificationSlots.id, slotId),
        eq(verificationLocations.tenantId, tenantId),
      ),
    )
    .limit(1);

  const slot = found[0];
  if (!slot) return { ok: false, error: "Diesen Termin gibt es nicht." };
  if (!slot.locActive) {
    return { ok: false, error: "Dieser Standort nimmt derzeit keine Termine an." };
  }
  if (slot.startsAt <= new Date()) {
    return { ok: false, error: "Dieser Termin liegt in der Vergangenheit." };
  }

  // No-Show-Freigabe: vergangene offene Termine dieses Bürgers verfallen lassen,
  // damit ein verpasster Termin die Neubuchung nicht dauerhaft blockiert.
  await expireVergangeneTermine(db, tenantId, userId);

  // Vorab-Check für freundliche Meldung; die harte Garantie ist das partielle UNIQUE.
  const open = await db
    .select({ id: verificationBookings.id })
    .from(verificationBookings)
    .where(
      and(
        eq(verificationBookings.tenantId, tenantId),
        eq(verificationBookings.userId, userId),
        eq(verificationBookings.status, "gebucht"),
      ),
    )
    .limit(1);
  if (open[0]) {
    return {
      ok: false,
      alreadyBooked: true,
      error: "Sie haben bereits einen offenen Termin. Bitte sagen Sie ihn zuerst ab.",
    };
  }

  try {
    return await db.transaction(async (tx: Db) => {
      // Buchung einfügen — Termin-Code kollisionssicher (onConflictDoNothing auf den
      // CODE-Constraint; ein Verstoß gegen das partielle One-Open-UNIQUE wird NICHT
      // unterdrückt → wirft 23505 → außen als alreadyBooked behandelt).
      let code = "";
      let bookingId = "";
      let ok = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = generateBookingCode();
        const ins = await tx
          .insert(verificationBookings)
          .values({ tenantId, slotId, userId, code, status: "gebucht" })
          .onConflictDoNothing({
            target: [verificationBookings.tenantId, verificationBookings.code],
          })
          .returning({ id: verificationBookings.id });
        if (ins.length > 0) {
          bookingId = ins[0].id;
          ok = true;
          break;
        }
      }
      if (!ok) throw new Error("Termin-Code konnte nicht kollisionsfrei erzeugt werden.");

      // Atomare bedingte Kapazitäts-Erhöhung. Zeit über DB-now() (race-frei).
      const bumped = await tx
        .update(verificationSlots)
        .set({ bookedCount: sql`${verificationSlots.bookedCount} + 1` })
        .where(
          and(
            eq(verificationSlots.id, slotId),
            gt(verificationSlots.startsAt, sql`now()`),
            sql`${verificationSlots.bookedCount} < ${verificationSlots.capacity}`,
          ),
        )
        .returning({ id: verificationSlots.id });
      if (bumped.length === 0) {
        // Voll oder inzwischen vergangen → Rollback (auch der Buchungs-Insert).
        throw new SlotFullError();
      }

      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "user",
        actorRef: userId,
        action: "verification.booking_created",
        targetType: "verification_booking",
        targetId: bookingId,
        // PII-frei: nur IDs, NIE der Termin-Code oder die E-Mail.
        metadata: { bookingId, slotId },
      });

      return {
        ok: true,
        booking: {
          bookingId,
          code,
          slotId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          locationName: slot.locName,
          locationAddress: slot.locAddress,
        },
      };
    });
  } catch (err) {
    if (err instanceof SlotFullError) {
      return { ok: false, error: "Dieser Termin ist leider schon ausgebucht." };
    }
    // Partielles One-Open-UNIQUE (Race nach dem Vorab-Check) → freundlich.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return {
        ok: false,
        alreadyBooked: true,
        error: "Sie haben bereits einen offenen Termin. Bitte sagen Sie ihn zuerst ab.",
      };
    }
    throw err;
  }
}

/**
 * Sagt den eigenen, offenen Termin ab (tenant-/user-scoped, atomar) und gibt die
 * Kapazität wieder frei. Idempotenz-/Race-Schutz: der Status-Übergang steckt im
 * WHERE (status='gebucht'); 0 Rows ⇒ kein offener Termin → freundlicher Fehler.
 */
export async function cancelBookingCore(
  db: Db,
  tenantId: string,
  userId: string,
  bookingId: string,
): Promise<{ ok: boolean; error?: string }> {
  return db.transaction(async (tx: Db) => {
    const cancelled = await tx
      .update(verificationBookings)
      .set({ status: "storniert" })
      .where(
        and(
          eq(verificationBookings.id, bookingId),
          eq(verificationBookings.tenantId, tenantId),
          eq(verificationBookings.userId, userId),
          eq(verificationBookings.status, "gebucht"),
        ),
      )
      .returning({ slotId: verificationBookings.slotId });

    if (cancelled.length === 0) {
      return { ok: false, error: "Kein offener Termin zum Absagen gefunden." };
    }

    // Kapazität freigeben (CHECK booked_count >= 0; GREATEST als Sicherheitsnetz).
    await tx
      .update(verificationSlots)
      .set({ bookedCount: sql`GREATEST(${verificationSlots.bookedCount} - 1, 0)` })
      .where(eq(verificationSlots.id, cancelled[0].slotId));

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: userId,
      action: "verification.booking_cancelled",
      targetType: "verification_booking",
      targetId: bookingId,
      metadata: { bookingId },
    });

    return { ok: true };
  });
}

export interface BookingWahrnehmenResult {
  ok: boolean;
  verifiedUntil?: Date;
  error?: string;
}

/**
 * Markiert einen offenen Termin als wahrgenommen (NUR canVerify via Action) und
 * verifiziert die zugehörige Person: wohnsitz-verifiziert (Stufe 2),
 * method='in_person', Ablauf in 24 Monaten. Atomar; Tenant-scoped.
 *
 * Kein Selbst-Hochstufen: die Action erzwingt canVerify; hier wird ausschließlich
 * über bookingId (tenant-scoped) gearbeitet — der Verifier sieht nie die userId.
 */
export async function bookingWahrnehmenCore(
  db: Db,
  tenantId: string,
  verifierUserId: string,
  bookingId: string,
): Promise<BookingWahrnehmenResult> {
  return db.transaction(async (tx: Db) => {
    const done = await tx
      .update(verificationBookings)
      .set({ status: "wahrgenommen" })
      .where(
        and(
          eq(verificationBookings.id, bookingId),
          eq(verificationBookings.tenantId, tenantId),
          eq(verificationBookings.status, "gebucht"),
          // Nur kürzlich fällige Termine bestätigbar (Vor-Ort + verspätetes
          // Erscheinen am selben Tag) — ein wochenalter No-Show ist nicht mehr
          // „wahrnehmbar"; die Person bucht neu. Deckungsgleich mit der Verifier-Liste.
          // Tenant-scoped (Defense-in-Depth) über den Location-Join.
          sql`${verificationBookings.slotId} IN (SELECT s.id FROM verification_slots s JOIN verification_locations l ON l.id = s.location_id WHERE l.tenant_id = ${tenantId} AND s.starts_at > now() - interval '1 day')`,
        ),
      )
      .returning({ userId: verificationBookings.userId });

    if (done.length === 0) {
      return { ok: false, error: "Termin nicht gefunden oder nicht (mehr) offen." };
    }

    // Stufe-2 vergeben über den gemeinsamen, tenant-scoped Grant (wie QR-Einlösung).
    const verifiedUntil = await grantResidency(
      tx,
      tenantId,
      done[0].userId,
      "in_person",
    );

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: verifierUserId, // der bestätigende Verifier (UUID, PII-frei)
      action: "verification.booking_fulfilled",
      targetType: "verification_booking",
      targetId: bookingId,
      metadata: { bookingId },
    });

    return { ok: true, verifiedUntil };
  });
}
