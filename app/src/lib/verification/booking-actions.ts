/**
 * booking-actions.ts — Server Actions für die Termin-Buchung (D6 Verify-Hub).
 *
 * Gate-B: Server Actions sind eigenständige Endpoints — Auth/Validierung/Tenant
 * werden serverseitig erzwungen, nie dem Client vertraut. Diese Datei löst nur
 * Auth/Tenant aus dem Request-Kontext auf und delegiert an booking-core (ECHTE,
 * getestete Funktionen). Lese-Queries liegen in booking-queries (OHNE "use server").
 *
 * SICHERHEITS-KERN:
 *   - bookSlot/cancelBooking: NUR eingeloggt (Stufe ≥ 1). Kein anonymes Buchen.
 *   - bookingWahrnehmen: NUR canVerify (verifier/kommune_admin/super_admin) —
 *     setzt die Person auf Stufe 2. Kein Selbst-Hochstufen.
 *   - Tenant-Isolation überall; Cap atomar (booking-core); Audit PII-frei.
 */

"use server";

import { z } from "zod";
import {
  requireStufe1Ctx,
  requireVerifierCtx,
} from "@/lib/auth/action-context";
import {
  bookSlotCore,
  cancelBookingCore,
  bookingWahrnehmenCore,
} from "@/lib/verification/booking-core";

// ---------------------------------------------------------------------------
// bookSlot — Slot buchen (NUR eingeloggt, Stufe ≥ 1).
// ---------------------------------------------------------------------------

export interface BookSlotActionResult {
  ok: boolean;
  alreadyBooked?: boolean;
  needLogin?: boolean;
  booking?: {
    bookingId: string;
    code: string;
    startsAt: string;
    endsAt: string;
    locationName: string;
    locationAddress: string | null;
  };
  error?: string;
}

export async function bookSlot(slotId: string): Promise<BookSlotActionResult> {
  const auth = await requireStufe1Ctx();
  if (!auth.ok) return { ok: false, needLogin: auth.needLogin, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(slotId);
  if (!idParsed.success) return { ok: false, error: "Ungültiger Termin." };

  const result = await bookSlotCore(ctx.db, ctx.tenant.id, ctx.userId, idParsed.data);
  if (!result.ok || !result.booking) {
    return { ok: false, alreadyBooked: result.alreadyBooked, error: result.error };
  }
  return {
    ok: true,
    booking: {
      bookingId: result.booking.bookingId,
      code: result.booking.code,
      startsAt: result.booking.startsAt.toISOString(),
      endsAt: result.booking.endsAt.toISOString(),
      locationName: result.booking.locationName,
      locationAddress: result.booking.locationAddress,
    },
  };
}

// ---------------------------------------------------------------------------
// cancelBooking — eigenen offenen Termin absagen (NUR eingeloggt, Stufe ≥ 1).
// ---------------------------------------------------------------------------

export async function cancelBooking(
  bookingId: string,
): Promise<{ ok: boolean; needLogin?: boolean; error?: string }> {
  const auth = await requireStufe1Ctx();
  if (!auth.ok) return { ok: false, needLogin: auth.needLogin, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(bookingId);
  if (!idParsed.success) return { ok: false, error: "Ungültiger Termin." };

  return cancelBookingCore(ctx.db, ctx.tenant.id, ctx.userId, idParsed.data);
}

// ---------------------------------------------------------------------------
// bookingWahrnehmen — Termin vor Ort bestätigen → Stufe 2 (NUR canVerify).
// ---------------------------------------------------------------------------

export async function bookingWahrnehmen(
  bookingId: string,
): Promise<{ ok: boolean; verifiedUntil?: string; error?: string }> {
  const auth = await requireVerifierCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  const idParsed = z.string().uuid().safeParse(bookingId);
  if (!idParsed.success) return { ok: false, error: "Ungültiger Termin." };

  const result = await bookingWahrnehmenCore(
    ctx.db,
    ctx.tenant.id,
    ctx.userId,
    idParsed.data,
  );
  return {
    ok: result.ok,
    verifiedUntil: result.verifiedUntil?.toISOString(),
    error: result.error,
  };
}
