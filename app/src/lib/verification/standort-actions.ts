/**
 * standort-actions.ts — Server Actions der Standort-/Sprechzeiten-Verwaltung
 * (Block K1, NUR Admins).
 *
 * Gate-B: Server Actions sind eigenständige Endpoints — Auth/Validierung/Tenant
 * werden serverseitig erzwungen, nie dem Client vertraut. Diese Datei löst NUR
 * Auth/Tenant auf, validiert per zod und delegiert an
 * @/lib/verification/standort-core (als ECHTE Funktion getestet). Lese-Queries
 * liegen bewusst in standort-queries.ts (OHNE "use server", Gate-B MAJOR-G).
 *
 * SICHERHEITS-KERN:
 *   - ALLE Actions: requireAdminCtx (kommune_admin/super_admin) — Verifier
 *     verwalten keine Standorte (Entscheidung Patrick 2026-07-17).
 *   - SIDE-EFFECT-FENCE (Muster Block I): auf dem Demo-Mandanten sind alle
 *     Mutationen gesperrt — der ephemere Demo-Admin darf keine persistenten
 *     Standorte/Sprechzeiten anlegen (die nächtliche Demo-Reinigung kennt sie
 *     nicht). Fail-closed.
 *   - Zeit-Eingaben sind Wandzeit Europe/Berlin → berlinDate (DST-korrekt,
 *     kein fester Offset).
 */

"use server";

import { z } from "zod";
import { requireAdminCtx } from "@/lib/auth/action-context";
import { isDemoTenant } from "@/lib/demo/config";
import {
  berlinDate,
  slotKapazitaetAendernCore,
  slotLoeschenCore,
  sprechzeitenAnlegenCore,
  standortAktivSetzenCore,
  standortBearbeitenCore,
  standortEingabeSchema,
  standortErstellenCore,
  STANDORT_LIMITS,
  type SprechzeitenResult,
  type StandortResult,
} from "@/lib/verification/standort-core";

/** Fehlermeldung des Demo-Fence (einheitlich für alle Standort-Mutationen). */
const DEMO_STANDORTE_GESPERRT = "In der Demo nicht verfügbar.";

// ---------------------------------------------------------------------------
// zod-Schemata (Grenzen aus STANDORT_LIMITS — eine Quelle der Wahrheit)
// ---------------------------------------------------------------------------

// Standort-Eingabe-Schema (V1) lebt in standort-core (Single Source of Truth,
// direkt testbar) — hier nur importiert und am Boundary angewandt.

const datumSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datum.")
  // Gate-B: Kalender-Gültigkeit per UTC-Roundtrip — fängt sowohl Werte, die
  // Date.parse werfen ließen („2026-13-01" → NaN → berlinDate-Exception → 500),
  // als auch stilles Überrollen („2026-02-30" → 2. März, Slot am falschen Tag).
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "Ungültiges Datum.");
const zeitSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ungültige Uhrzeit.");

const kapazitaetSchema = z
  .number()
  .int()
  .min(STANDORT_LIMITS.KAPAZITAET_MIN, `Kapazität: mindestens ${STANDORT_LIMITS.KAPAZITAET_MIN}.`)
  .max(STANDORT_LIMITS.KAPAZITAET_MAX, `Kapazität: höchstens ${STANDORT_LIMITS.KAPAZITAET_MAX}.`);

const dauerSchema = z
  .number()
  .int()
  .min(STANDORT_LIMITS.SLOT_DAUER_MIN, `Dauer: mindestens ${STANDORT_LIMITS.SLOT_DAUER_MIN} Minuten.`)
  .max(STANDORT_LIMITS.SLOT_DAUER_MAX, `Dauer: höchstens ${STANDORT_LIMITS.SLOT_DAUER_MAX} Minuten.`);

const sprechzeitenSchema = z.discriminatedUnion("art", [
  z.object({
    art: z.literal("einzeln"),
    locationId: z.string().uuid(),
    datum: datumSchema,
    zeit: zeitSchema,
    dauerMinuten: dauerSchema,
    kapazitaet: kapazitaetSchema,
  }),
  z.object({
    art: z.literal("serie"),
    locationId: z.string().uuid(),
    vonDatum: datumSchema,
    bisDatum: datumSchema,
    wochentage: z.array(z.number().int().min(0).max(6)).min(1, "Bitte mindestens einen Wochentag wählen.").max(7),
    vonZeit: zeitSchema,
    bisZeit: zeitSchema,
    slotDauerMinuten: dauerSchema,
    kapazitaet: kapazitaetSchema,
  }),
]);

// ---------------------------------------------------------------------------
// Actions — je Core-Funktion eine (Auth → Demo-Fence → zod → Core)
// ---------------------------------------------------------------------------

export async function standortErstellen(rawData: unknown): Promise<StandortResult> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_STANDORTE_GESPERRT };

  const parsed = standortEingabeSchema.safeParse(rawData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return standortErstellenCore(ctx.db, ctx.tenant.id, ctx.userId, {
    name: parsed.data.name,
    address: parsed.data.address,
    hinweise: parsed.data.hinweise || null,
    lat: parsed.data.lat ?? null,
    lon: parsed.data.lon ?? null,
    oeffnungszeiten: parsed.data.oeffnungszeiten ?? null,
    terminErforderlich: parsed.data.terminErforderlich,
    barrierefrei: parsed.data.barrierefrei ?? null,
    kontakt: parsed.data.kontakt || null,
  });
}

export async function standortBearbeiten(
  locationId: string,
  rawData: unknown,
): Promise<StandortResult> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_STANDORTE_GESPERRT };

  const idParsed = z.string().uuid().safeParse(locationId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Standort-ID." };
  const parsed = standortEingabeSchema.safeParse(rawData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return standortBearbeitenCore(ctx.db, ctx.tenant.id, ctx.userId, idParsed.data, {
    name: parsed.data.name,
    address: parsed.data.address,
    hinweise: parsed.data.hinweise || null,
    lat: parsed.data.lat ?? null,
    lon: parsed.data.lon ?? null,
    oeffnungszeiten: parsed.data.oeffnungszeiten ?? null,
    terminErforderlich: parsed.data.terminErforderlich,
    barrierefrei: parsed.data.barrierefrei ?? null,
    kontakt: parsed.data.kontakt || null,
  });
}

export async function standortAktivSetzen(
  locationId: string,
  aktiv: boolean,
): Promise<StandortResult> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_STANDORTE_GESPERRT };

  const idParsed = z.string().uuid().safeParse(locationId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Standort-ID." };
  const aktivParsed = z.boolean().safeParse(aktiv);
  if (!aktivParsed.success) return { ok: false, error: "Ungültige Eingabe." };

  return standortAktivSetzenCore(
    ctx.db,
    ctx.tenant.id,
    ctx.userId,
    idParsed.data,
    aktivParsed.data,
  );
}

export async function sprechzeitenAnlegen(rawData: unknown): Promise<SprechzeitenResult> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_STANDORTE_GESPERRT };

  const parsed = sprechzeitenSchema.safeParse(rawData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  const d = parsed.data;

  if (d.art === "einzeln") {
    // Wandzeit Europe/Berlin → UTC-Zeitpunkt (DST-korrekt, kein fester Offset).
    return sprechzeitenAnlegenCore(ctx.db, ctx.tenant.id, ctx.userId, d.locationId, {
      art: "einzeln",
      startsAt: berlinDate(d.datum, d.zeit),
      dauerMinuten: d.dauerMinuten,
      kapazitaet: d.kapazitaet,
    });
  }
  return sprechzeitenAnlegenCore(ctx.db, ctx.tenant.id, ctx.userId, d.locationId, {
    art: "serie",
    vonDatum: d.vonDatum,
    bisDatum: d.bisDatum,
    wochentage: d.wochentage,
    vonZeit: d.vonZeit,
    bisZeit: d.bisZeit,
    slotDauerMinuten: d.slotDauerMinuten,
    kapazitaet: d.kapazitaet,
  });
}

export async function slotLoeschen(slotId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_STANDORTE_GESPERRT };

  const idParsed = z.string().uuid().safeParse(slotId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Slot-ID." };

  return slotLoeschenCore(ctx.db, ctx.tenant.id, ctx.userId, idParsed.data);
}

export async function slotKapazitaetAendern(
  slotId: string,
  neueKapazitaet: number,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;
  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_STANDORTE_GESPERRT };

  const idParsed = z.string().uuid().safeParse(slotId);
  if (!idParsed.success) return { ok: false, error: "Ungültige Slot-ID." };
  const kapParsed = kapazitaetSchema.safeParse(neueKapazitaet);
  if (!kapParsed.success) {
    return { ok: false, error: kapParsed.error.errors[0]?.message ?? "Ungültige Kapazität." };
  }

  return slotKapazitaetAendernCore(
    ctx.db,
    ctx.tenant.id,
    ctx.userId,
    idParsed.data,
    kapParsed.data,
  );
}
