/**
 * standort-core.ts — Reine DB-Logik der Standort-/Sprechzeiten-Verwaltung
 * (Block K1, Onboarding-Spec Teil B).
 *
 * BEWUSST OHNE "use server" und ohne Request-Kontext: nimmt db/tenantId/
 * actorUserId als PARAMETER (Muster qr-core/booking-core). Dadurch von den
 * Actions wiederverwendbar UND als ECHTE Funktion in DB-Integrationstests
 * aufrufbar (keine Spiegelung der Logik im Test).
 *
 * SICHERHEITS-KERN (Entscheidungen Patrick 2026-07-17, fail-closed):
 *   - NUR Admins (requireAdminCtx in den Actions) — Verifier sehen Standorte
 *     nur indirekt (Terminliste).
 *   - Standorte sind NICHT löschbar, nur deaktivierbar: ein DELETE würde via
 *     ON DELETE CASCADE (locations→slots→bookings) alle Slots UND deren
 *     Buchungen still mitlöschen — gebuchte Bürger-Termine verschwänden
 *     spurlos. Deaktivieren verhindert dagegen nur NEUE Buchungen
 *     (getStandorteMitFreienSlots filtert isActive; bookSlotCore lehnt ab);
 *     bestehende Buchungen bleiben gültig und in der Verifier-Terminliste
 *     sichtbar (getOffeneTermineFuerVerifier filtert bewusst NICHT auf isActive).
 *   - Slots mit Buchungen (booked_count > 0) sind NICHT löschbar (atomares
 *     bedingtes DELETE) — kein stilles Wegräumen gebuchter Termine.
 *   - Tenant-Isolation in JEDER Query; bei Slots über den Standort-Join
 *     (verification_slots trägt keine tenant_id).
 *   - Atomare Übergänge: bedingtes UPDATE/DELETE ... RETURNING + rowCount.
 *   - Audit PII-frei: actorRef = Admin-UUID; Standort-Name ist KEIN PII
 *     (Amtsgebäude, z. B. „Rathaus"), darf also in die Metadaten.
 *   - KEIN JS-Date in Roh-`sql` — Zeitvergleiche über DB-now() bzw. JS-Dates
 *     nur als gebundene Drizzle-Parameter.
 *
 * GEBIETSMODELL (ADR-024): region_id wird beim Insert bewusst WEGGELASSEN —
 * der BEFORE-INSERT-Trigger (Migration 0024/0025) leitet den Gemeinde-Knoten
 * des Tenants ab. Ein Region-/Ortsteil-Picker ist eine Folge-Etappe.
 *
 * ZEITZONE: Sprechzeiten werden als Wandzeit Europe/Berlin eingegeben und
 * DST-korrekt in UTC-Zeitpunkte übersetzt (berlinDate) — KEIN fester
 * +02:00-Offset; eine Wochenserie über die Umstellung (z. B. 25.10.2026)
 * behält ihre 09:00-Wandzeit vor und nach der Umstellung.
 */

import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  verificationLocations,
  verificationSlots,
  auditEvents,
} from "@/db/schema";
import { addMonths } from "@/lib/verification/qr-core";
import { istPgFehler, PG_UNIQUE_VIOLATION } from "@/lib/db/pg-errors";

export const STANDORT_LIMITS = {
  NAME_MIN: 3,
  NAME_MAX: 120,
  ADDRESS_MAX: 200,
  HINWEISE_MAX: 500,
  KAPAZITAET_MIN: 1,
  KAPAZITAET_MAX: 20,
  SLOT_DAUER_MIN: 10, // Minuten
  SLOT_DAUER_MAX: 120,
  /** Harter Cap generierter Slots je Aufruf (Schutz vor Massen-Inserts). */
  MAX_SLOTS_PRO_AUFRUF: 200,
  /** Sprechzeiten (einzeln UND Serie) reichen höchstens 6 Monate in die Zukunft. */
  MAX_MONATE_ZUKUNFT: 6,
  /**
   * Tiefenverteidigung (Gate-B MAJOR): harte Obergrenze der Kalendertage einer
   * Serie, geprüft VOR der Generierung. Mit „vonDatum nicht in der Vergangenheit"
   * + 6-Monats-Horizont ist die Spanne ohnehin ≤ ~185 Tage — dieser Deckel
   * schützt gegen künftige Refactors, die eine der beiden Prüfungen lockern
   * (die Generierung läuft synchron; eine Jahrhundert-Spanne fröre den
   * Event-Loop der gesamten Multi-Tenant-Instanz ein).
   */
  MAX_SERIE_TAGE: 200,
} as const;

/** Einheitliches, serialisierbares Ergebnis der Standort-Mutationen. */
export interface StandortResult {
  ok: boolean;
  locationId?: string;
  error?: string;
}

/** Unique-Konflikt (tenant+name bzw. location+starts_at) — gemeinsamer Helfer. */
function istUniqueKonflikt(err: unknown): boolean {
  return istPgFehler(err, PG_UNIQUE_VIOLATION);
}

export interface StandortInput {
  name: string;
  address?: string | null;
  hinweise?: string | null;
}

/**
 * Legt einen Verifizierungs-Standort an (tenant-scoped). region_id wird
 * WEGGELASSEN — der BEFORE-INSERT-Trigger setzt den Gemeinde-Knoten des
 * Tenants (ADR-024 Dual-Write-Netz). Unique-Konflikt (tenant+name) wird als
 * freundlicher Fehler zurückgegeben. Validierungsgrenzen (Name 3..120 usw.)
 * erzwingt die Action per zod; hier zählt die DB-Wahrheit.
 */
export async function standortErstellenCore(
  db: Db,
  tenantId: string,
  actorUserId: string,
  input: StandortInput,
): Promise<StandortResult> {
  try {
    return await db.transaction(async (tx: Db) => {
      const [row] = await tx
        .insert(verificationLocations)
        .values({
          tenantId,
          name: input.name,
          address: input.address ?? null,
          hinweise: input.hinweise ?? null,
          // region_id bewusst weggelassen → Trigger setzt den Gemeinde-Knoten.
        })
        .returning({ id: verificationLocations.id });

      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "user",
        actorRef: actorUserId,
        action: "verify_location.created",
        targetType: "verification_location",
        targetId: row.id,
        // Standort-Name ist kein PII (Amtsgebäude) — er darf ins Protokoll.
        metadata: { locationId: row.id, name: input.name },
      });

      return { ok: true, locationId: row.id };
    });
  } catch (err) {
    if (istUniqueKonflikt(err)) {
      return { ok: false, error: "Ein Standort mit diesem Namen existiert bereits." };
    }
    throw err;
  }
}

/**
 * Bearbeitet einen Standort (tenant-scoped UPDATE ... RETURNING; 0 Zeilen ⇒
 * nicht gefunden/fremder Tenant). Unique-Konflikt (tenant+name) wie beim Anlegen.
 */
export async function standortBearbeitenCore(
  db: Db,
  tenantId: string,
  actorUserId: string,
  locationId: string,
  input: StandortInput,
): Promise<StandortResult> {
  try {
    return await db.transaction(async (tx: Db) => {
      const updated = await tx
        .update(verificationLocations)
        .set({
          name: input.name,
          address: input.address ?? null,
          hinweise: input.hinweise ?? null,
        })
        .where(
          and(
            eq(verificationLocations.id, locationId),
            eq(verificationLocations.tenantId, tenantId),
          ),
        )
        .returning({ id: verificationLocations.id });

      if (updated.length === 0) {
        return { ok: false, error: "Standort nicht gefunden." };
      }

      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "user",
        actorRef: actorUserId,
        action: "verify_location.updated",
        targetType: "verification_location",
        targetId: locationId,
        metadata: { locationId, name: input.name },
      });

      return { ok: true, locationId };
    });
  } catch (err) {
    if (istUniqueKonflikt(err)) {
      return { ok: false, error: "Ein Standort mit diesem Namen existiert bereits." };
    }
    throw err;
  }
}

/**
 * (De-)aktiviert einen Standort — der EINZIGE Weg, ihn „loszuwerden": echtes
 * Löschen gibt es bewusst nicht (CASCADE würde Slots + Buchungen still
 * mitreißen, siehe Kopfkommentar). Idempotenzfest über das bedingte UPDATE
 * `WHERE is_active = NOT aktiv` — ein Doppelklick erzeugt keinen zweiten
 * Audit-Eintrag. Deaktivieren verhindert nur NEUE Buchungen; bestehende
 * Termine bleiben gültig und für Verifier sichtbar.
 */
export async function standortAktivSetzenCore(
  db: Db,
  tenantId: string,
  actorUserId: string,
  locationId: string,
  aktiv: boolean,
): Promise<StandortResult> {
  return db.transaction(async (tx: Db) => {
    const updated = await tx
      .update(verificationLocations)
      .set({ isActive: aktiv })
      .where(
        and(
          eq(verificationLocations.id, locationId),
          eq(verificationLocations.tenantId, tenantId),
          eq(verificationLocations.isActive, !aktiv),
        ),
      )
      .returning({ id: verificationLocations.id });

    if (updated.length === 0) {
      return {
        ok: false,
        error: "Standort nicht gefunden oder bereits im gewünschten Zustand.",
      };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: actorUserId,
      action: aktiv ? "verify_location.reactivated" : "verify_location.deactivated",
      targetType: "verification_location",
      targetId: locationId,
      metadata: { locationId },
    });

    return { ok: true, locationId };
  });
}

// ---------------------------------------------------------------------------
// Zeitzonen-Helfer: Wandzeit Europe/Berlin → UTC-Zeitpunkt (DST-korrekt)
// ---------------------------------------------------------------------------

/**
 * Prozessweit EIN Formatter (Gate-B MAJOR): Intl.DateTimeFormat-Konstruktion
 * ist teuer (~0,1 ms) — bei Serien-Generierung wird der Offset je Slot 2×
 * bestimmt; ohne Cache dominierte die Konstruktion die Laufzeit.
 */
const BERLIN_OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  timeZoneName: "longOffset",
});

/**
 * UTC-Offset von Europe/Berlin (in Minuten) zum gegebenen Zeitpunkt — über
 * Intl `timeZoneName: "longOffset"` (z. B. „GMT+02:00"), NICHT hartkodiert.
 */
function berlinOffsetMinuten(zeitpunkt: Date): number {
  const teil = BERLIN_OFFSET_FORMATTER.formatToParts(zeitpunkt).find(
    (p) => p.type === "timeZoneName",
  )?.value;
  // „GMT" ohne Offset-Anteil = UTC±00:00 (theoretisch; Berlin ist +01/+02).
  const m = teil?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const vorzeichen = m[1] === "-" ? -1 : 1;
  return vorzeichen * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Wandzeit Europe/Berlin → UTC-Zeitpunkt, DST-korrekt (KEIN fester Offset):
 * Erst-Schätzung mit dem Offset des UTC-gleichen Zeitpunkts, dann eine
 * Korrektur-Runde, falls die Schätzung auf der anderen Seite einer
 * DST-Grenze landet (Standard-Zwei-Pass-Verfahren). Reine JS-Funktion —
 * das Ergebnis wird ausschließlich als gebundener Parameter verwendet.
 */
export function berlinDate(datum: string, zeit: string): Date {
  const utcRoh = Date.parse(`${datum}T${zeit}:00Z`);
  if (Number.isNaN(utcRoh)) {
    throw new Error(`Ungültige Datums-/Zeitangabe: ${datum} ${zeit}`);
  }
  const offset1 = berlinOffsetMinuten(new Date(utcRoh));
  let ts = utcRoh - offset1 * 60_000;
  const offset2 = berlinOffsetMinuten(new Date(ts));
  if (offset2 !== offset1) ts = utcRoh - offset2 * 60_000;
  return new Date(ts);
}

// ---------------------------------------------------------------------------
// Sprechzeiten anlegen (Einzeltermin oder Wochenserie)
// ---------------------------------------------------------------------------

export interface SprechzeitEinzelnInput {
  art: "einzeln";
  startsAt: Date;
  dauerMinuten: number;
  kapazitaet: number;
}

export interface SprechzeitSerieInput {
  art: "serie";
  /** Kalender-Zeitraum (einschließlich), Wandzeit Europe/Berlin. */
  vonDatum: string; // YYYY-MM-DD
  bisDatum: string;
  /** Wochentage 0=So..6=Sa (JS-Konvention). */
  wochentage: number[];
  vonZeit: string; // HH:MM
  bisZeit: string;
  slotDauerMinuten: number;
  kapazitaet: number;
}

export type SprechzeitenInput = SprechzeitEinzelnInput | SprechzeitSerieInput;

export interface SprechzeitenResult {
  ok: boolean;
  /** Neu angelegte Slots. */
  angelegt?: number;
  /** Übersprungen, weil am Standort zur selben Startzeit schon ein Slot existiert. */
  uebersprungen?: number;
  error?: string;
}

/** Minuten seit Mitternacht aus „HH:MM" (Validierung des Formats macht zod). */
function minutenAusZeit(zeit: string): number {
  const [h, m] = zeit.split(":").map(Number);
  return h * 60 + m;
}

/** „HH:MM" aus Minuten seit Mitternacht (nur intern, < 24 h garantiert). */
function zeitAusMinuten(min: number): string {
  const h = String(Math.floor(min / 60)).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** Ergebnis der Serien-Generierung (siehe generiereSerienSlotZeiten). */
export interface SerienSlotZeiten {
  slots: { startsAt: Date; endsAt: Date }[];
  /**
   * Verworfene Slots, deren Wandzeit-Fenster real nicht existiert: bei der
   * DST-FRÜHJAHRS-Umstellung (z. B. 29.03.2026 springt die Uhr 02:00→03:00)
   * bilden Start- und Endzeit auf denselben (oder rückläufige) UTC-Zeitpunkte
   * ab — endsAt <= startsAt würde den DB-CHECK
   * verification_slots_ends_after_starts verletzen und die GESAMTE Serie mit
   * einem harten Fehler versenken (Gate-B). Sie werden hier aussortiert und
   * vom Aufrufer als „übersprungen" gezählt.
   */
  dstVerworfen: number;
}

/**
 * Erzeugt die Slot-Zeitpunkte einer Wochenserie — REINE Funktion (direkt
 * unit-testbar, auch für die DST-Grenzen mit fixen Daten). Je Kalendertag im
 * Zeitraum, dessen Wochentag gewählt ist, entstehen Slots von vonZeit bis
 * bisZeit im slotDauer-Raster (der letzte Slot endet spätestens um bisZeit).
 * Jede Wandzeit wird EINZELN via berlinDate übersetzt — dadurch bleibt eine
 * Serie über die DST-Umstellung auf ihrer Wandzeit (09:00 bleibt 09:00).
 * Die Tages-Iteration läuft über UTC-Tagesnummern (DST-neutral).
 *
 * NOTBREMSE (Gate-B MAJOR, Tiefenverteidigung): die Schleife bricht ab, sobald
 * mehr als MAX_SLOTS_PRO_AUFRUF Slots erzeugt wurden — der Aufrufer lehnt dann
 * ohnehin ab. Die eigentlichen Grenzen (vonDatum nicht in der Vergangenheit,
 * Tages-Spannen-Deckel) prüft sprechzeitenAnlegenCore VOR dem Aufruf; ohne
 * diese Bremse könnte ein direkter Aufruf mit Jahrhundert-Spanne den
 * Event-Loop synchron minutenlang blockieren.
 */
export function generiereSerienSlotZeiten(
  serie: Omit<SprechzeitSerieInput, "art" | "kapazitaet">,
): SerienSlotZeiten {
  const vonMin = minutenAusZeit(serie.vonZeit);
  const bisMin = minutenAusZeit(serie.bisZeit);
  const wochentage = new Set(serie.wochentage);

  const [vj, vm, vt] = serie.vonDatum.split("-").map(Number);
  const [bj, bm, bt] = serie.bisDatum.split("-").map(Number);
  const vonTagUtc = Date.UTC(vj, vm - 1, vt);
  const bisTagUtc = Date.UTC(bj, bm - 1, bt);

  const slots: { startsAt: Date; endsAt: Date }[] = [];
  let dstVerworfen = 0;
  for (let tag = vonTagUtc; tag <= bisTagUtc; tag += 86_400_000) {
    // Notbremse: über dem Cap bricht der Aufrufer ohnehin ab — nicht weiter
    // generieren (Event-Loop-Schutz, siehe Funktionskommentar).
    if (slots.length > STANDORT_LIMITS.MAX_SLOTS_PRO_AUFRUF) break;
    const d = new Date(tag);
    // Kalender-Wochentag des Datums selbst (UTC-Mitternacht ⇒ getUTCDay ist
    // der Wochentag des Kalendertags, unabhängig von Zeitzone/DST).
    if (!wochentage.has(d.getUTCDay())) continue;
    const datum = d.toISOString().slice(0, 10);
    for (let min = vonMin; min + serie.slotDauerMinuten <= bisMin; min += serie.slotDauerMinuten) {
      const startsAt = berlinDate(datum, zeitAusMinuten(min));
      const endsAt = berlinDate(datum, zeitAusMinuten(min + serie.slotDauerMinuten));
      // DST-Frühjahrslücke: nicht-existente Stunde ⇒ endsAt <= startsAt ⇒
      // aussortieren statt DB-CHECK-Bruch (siehe SerienSlotZeiten.dstVerworfen).
      if (endsAt.getTime() <= startsAt.getTime()) {
        dstVerworfen++;
        continue;
      }
      slots.push({ startsAt, endsAt });
    }
  }
  return { slots, dstVerworfen };
}

/**
 * Legt Sprechzeiten-Slots für einen Standort an (Einzeltermin oder
 * Wochenserie). Fail-closed:
 *   - Standort muss zum Tenant gehören UND aktiv sein.
 *   - Kapazität 1..20, Slot-Dauer 10..120 min; Serie höchstens 6 Monate in
 *     die Zukunft; harter Cap von 200 generierten Slots pro Aufruf.
 *   - Nur Zukunfts-Slots: bei der Serie werden bereits vergangene Slots des
 *     Startta­ges still übersprungen (JS-Vergleich gegen new Date() — der Wert
 *     landet nur als gebundener Parameter in der DB); ein Einzeltermin in der
 *     Vergangenheit ist ein Fehler.
 *   - Insert mit onConflictDoNothing auf UNIQUE(location_id, starts_at):
 *     bereits vorhandene Startzeiten werden gezählt übersprungen (idempotent
 *     wie der Seed) — Rückgabe { angelegt, uebersprungen }.
 */
export async function sprechzeitenAnlegenCore(
  db: Db,
  tenantId: string,
  actorUserId: string,
  locationId: string,
  input: SprechzeitenInput,
): Promise<SprechzeitenResult> {
  // Standort tenant-scoped laden — fail-closed: fremder Tenant sieht „nicht
  // gefunden", ein deaktivierter Standort nimmt keine neuen Sprechzeiten an.
  const loc = await db
    .select({
      id: verificationLocations.id,
      isActive: verificationLocations.isActive,
    })
    .from(verificationLocations)
    .where(
      and(
        eq(verificationLocations.id, locationId),
        eq(verificationLocations.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!loc[0]) return { ok: false, error: "Standort nicht gefunden." };
  if (!loc[0].isActive) {
    return {
      ok: false,
      error: "Dieser Standort ist deaktiviert — bitte zuerst wieder aktivieren.",
    };
  }

  const { KAPAZITAET_MIN, KAPAZITAET_MAX, SLOT_DAUER_MIN, SLOT_DAUER_MAX, MAX_SLOTS_PRO_AUFRUF, MAX_MONATE_ZUKUNFT, MAX_SERIE_TAGE } = STANDORT_LIMITS;
  const kapazitaet = input.kapazitaet;
  if (!Number.isInteger(kapazitaet) || kapazitaet < KAPAZITAET_MIN || kapazitaet > KAPAZITAET_MAX) {
    return { ok: false, error: `Kapazität muss zwischen ${KAPAZITAET_MIN} und ${KAPAZITAET_MAX} liegen.` };
  }
  const dauer = input.art === "einzeln" ? input.dauerMinuten : input.slotDauerMinuten;
  if (!Number.isInteger(dauer) || dauer < SLOT_DAUER_MIN || dauer > SLOT_DAUER_MAX) {
    return { ok: false, error: `Slot-Dauer muss zwischen ${SLOT_DAUER_MIN} und ${SLOT_DAUER_MAX} Minuten liegen.` };
  }

  // Slot-Zeiten bestimmen (JS-Dates — landen NUR als gebundene Insert-Werte in
  // der DB, nie in Roh-SQL).
  const jetzt = new Date();
  const horizont = addMonths(jetzt, MAX_MONATE_ZUKUNFT);
  let zeiten: { startsAt: Date; endsAt: Date }[];
  let dstVerworfen = 0;
  if (input.art === "einzeln") {
    if (input.startsAt.getTime() <= jetzt.getTime()) {
      return { ok: false, error: "Der Termin muss in der Zukunft liegen." };
    }
    // Gate-B: derselbe 6-Monats-Horizont wie bei der Serie — sonst wären
    // Jahres-Tippfehler-Slots (2062 statt 2026) dauerhaft buchbar und nach
    // der ersten Buchung nicht mehr löschbar.
    if (input.startsAt.getTime() > horizont.getTime()) {
      return {
        ok: false,
        error: `Der Termin darf höchstens ${MAX_MONATE_ZUKUNFT} Monate in der Zukunft liegen.`,
      };
    }
    zeiten = [
      {
        startsAt: input.startsAt,
        endsAt: new Date(input.startsAt.getTime() + dauer * 60_000),
      },
    ];
  } else {
    if (input.wochentage.length === 0 || input.wochentage.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) {
      return { ok: false, error: "Bitte mindestens einen Wochentag wählen." };
    }
    if (minutenAusZeit(input.vonZeit) + dauer > minutenAusZeit(input.bisZeit)) {
      return { ok: false, error: "Zwischen Von- und Bis-Uhrzeit passt kein Termin." };
    }
    if (input.vonDatum > input.bisDatum) {
      return { ok: false, error: "Das Von-Datum liegt nach dem Bis-Datum." };
    }
    // Gate-B MAJOR: vonDatum darf nicht vor dem heutigen Berlin-Kalendertag
    // liegen. Ohne diese Untergrenze ließe ein Jahres-Tippfehler („1026" statt
    // „2026") die synchrone Generierung über Jahrhunderte iterieren und fröre
    // den Event-Loop der gesamten Multi-Tenant-Instanz ein — der 200er-Cap
    // griff erst NACH der Generierung.
    const heuteBerlin = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(jetzt); // en-CA ⇒ YYYY-MM-DD, direkt string-vergleichbar
    if (input.vonDatum < heuteBerlin) {
      return { ok: false, error: "Der Zeitraum darf nicht in der Vergangenheit beginnen." };
    }
    // Serien-Horizont: höchstens 6 Monate in die Zukunft (kalendergenau).
    if (berlinDate(input.bisDatum, "00:00") > horizont) {
      return {
        ok: false,
        error: `Der Zeitraum darf höchstens ${MAX_MONATE_ZUKUNFT} Monate in die Zukunft reichen.`,
      };
    }
    // Tiefenverteidigung (Gate-B MAJOR): Tages-Spanne VOR der Generierung
    // deckeln — mit den beiden Prüfungen oben strukturell unerreichbar, schützt
    // aber gegen künftige Lockerungen einer der Grenzen (siehe MAX_SERIE_TAGE).
    const [vj, vm, vt] = input.vonDatum.split("-").map(Number);
    const [bj, bm, bt] = input.bisDatum.split("-").map(Number);
    const spanneTage = (Date.UTC(bj, bm - 1, bt) - Date.UTC(vj, vm - 1, vt)) / 86_400_000 + 1;
    if (!Number.isFinite(spanneTage) || spanneTage > MAX_SERIE_TAGE) {
      return {
        ok: false,
        error: `Der Zeitraum darf höchstens ${MAX_SERIE_TAGE} Tage umfassen.`,
      };
    }

    const generiert = generiereSerienSlotZeiten(input);
    dstVerworfen = generiert.dstVerworfen;
    // Notbremsen-Fall (Generator hat über dem Cap abgebrochen) SOFORT ablehnen —
    // die Zählung wäre unvollständig, ein Teil-Insert irreführend.
    if (generiert.slots.length > MAX_SLOTS_PRO_AUFRUF) {
      return {
        ok: false,
        error: `Zu viele Termine auf einmal (mehr als ${MAX_SLOTS_PRO_AUFRUF} erlaubt). Bitte den Zeitraum verkleinern.`,
      };
    }
    // Vergangene Slots (Serie beginnt heute) still überspringen — nur Zukunft.
    zeiten = generiert.slots.filter((s) => s.startsAt.getTime() > jetzt.getTime());
    if (zeiten.length === 0) {
      return { ok: false, error: "Im gewählten Zeitraum liegen keine zukünftigen Termine." };
    }
  }

  if (zeiten.length > MAX_SLOTS_PRO_AUFRUF) {
    return {
      ok: false,
      error: `Zu viele Termine auf einmal (${zeiten.length}, erlaubt sind ${MAX_SLOTS_PRO_AUFRUF}). Bitte den Zeitraum verkleinern.`,
    };
  }

  // ÜBERLAPPUNGS-Schutz (Gate-B): nicht nur IDENTISCHE Startzeiten (UNIQUE)
  // überspringen, sondern jede ZEITLICHE Überlappung mit bestehenden Slots des
  // Standorts — sonst erzeugten versetzte Serien (09:00er- und 09:30er-Raster)
  // unbemerkt doppelte Parallel-Kapazität am Schalter. Die Prüfung ist ein
  // Vorab-Filter (gezählt als „übersprungen"); das UNIQUE(location, starts_at)
  // + onConflictDoNothing bleibt als DB-Netz für identische Startzeiten im
  // Race-Fall bestehen. JS-Dates nur als gebundene Parameter (lt/gt-Operatoren).
  const fensterVon = new Date(Math.min(...zeiten.map((z) => z.startsAt.getTime())));
  const fensterBis = new Date(Math.max(...zeiten.map((z) => z.endsAt.getTime())));
  const bestehende = (await db
    .select({ startsAt: verificationSlots.startsAt, endsAt: verificationSlots.endsAt })
    .from(verificationSlots)
    .where(
      and(
        eq(verificationSlots.locationId, locationId),
        lt(verificationSlots.startsAt, fensterBis),
        gt(verificationSlots.endsAt, fensterVon),
      ),
    )) as { startsAt: Date; endsAt: Date }[];
  const ohneUeberlappung = zeiten.filter(
    (z) =>
      !bestehende.some(
        (b) => z.startsAt.getTime() < b.endsAt.getTime() && z.endsAt.getTime() > b.startsAt.getTime(),
      ),
  );
  const ueberlapptVerworfen = zeiten.length - ohneUeberlappung.length;
  zeiten = ohneUeberlappung;

  if (zeiten.length === 0) {
    // Alles kollidiert (z. B. identische Serie erneut angelegt) — idempotentes
    // Erfolgs-Ergebnis wie bisher, nur ohne Insert/Audit-Rauschen.
    return { ok: true, angelegt: 0, uebersprungen: ueberlapptVerworfen + dstVerworfen };
  }

  return db.transaction(async (tx: Db) => {
    // Idempotent wie der Seed: UNIQUE(location_id, starts_at) — im Race noch
    // entstandene identische Startzeiten werden übersprungen statt zu scheitern.
    const inserted = await tx
      .insert(verificationSlots)
      .values(
        zeiten.map((z) => ({
          locationId,
          startsAt: z.startsAt,
          endsAt: z.endsAt,
          capacity: kapazitaet,
        })),
      )
      .onConflictDoNothing({
        target: [verificationSlots.locationId, verificationSlots.startsAt],
      })
      .returning({ id: verificationSlots.id });

    const angelegt = inserted.length;
    // Übersprungen = überlappend + DST-verworfen + Race-Konflikte beim Insert.
    const uebersprungen =
      ueberlapptVerworfen + dstVerworfen + (zeiten.length - angelegt);

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: actorUserId,
      action: "verify_slots.created",
      targetType: "verification_location",
      targetId: locationId,
      // Nur Aggregat — die Einzelzeiten stehen in verification_slots selbst.
      metadata: { locationId, angelegt, uebersprungen },
    });

    return { ok: true, angelegt, uebersprungen };
  });
}

/**
 * Löscht einen Slot — ATOMAR NUR ohne Buchungen (booked_count = 0) und nur,
 * wenn sein Standort zum Tenant gehört (Subquery-Join; verification_slots
 * trägt keine tenant_id). 0 Zeilen ⇒ Slot hat Buchungen, ist fremd oder
 * existiert nicht — bewusst EINE unspezifische Meldung (kein Orakel über
 * fremde Tenants).
 *
 * HISTORIE (Gate-B, bewusste Entscheidung): das DELETE reißt per ON DELETE
 * CASCADE auch STORNIERTE/VERFALLENE Buchungs-Zeilen des Slots mit — das ist
 * GEWOLLT (Datenminimierung: abgesagte Termine ohne Verifizierungs-Wirkung
 * brauchen keine Aufbewahrung; die PII-freie Audit-Spur in audit_events
 * bleibt bestehen). VERIFIZIERUNGS-Nachweise (status='wahrgenommen') können
 * dagegen NICHT verschwinden: booked_count wird ausschließlich beim Storno
 * einer OFFENEN Buchung dekrementiert (cancelBookingCore) — weder
 * bookingWahrnehmenCore noch expireVergangeneTermine geben Kapazität zurück.
 * Damit gilt invariant booked_count >= Anzahl wahrgenommener Buchungen, und
 * die booked_count=0-Bedingung dieses DELETEs schließt Slots mit
 * Wahrnehmungs-Nachweis strukturell aus (per Integrationstest abgesichert).
 */
export async function slotLoeschenCore(
  db: Db,
  tenantId: string,
  actorUserId: string,
  slotId: string,
): Promise<{ ok: boolean; error?: string }> {
  return db.transaction(async (tx: Db) => {
    const deleted = await tx
      .delete(verificationSlots)
      .where(
        and(
          eq(verificationSlots.id, slotId),
          eq(verificationSlots.bookedCount, 0),
          sql`${verificationSlots.locationId} IN (SELECT id FROM verification_locations WHERE tenant_id = ${tenantId})`,
        ),
      )
      .returning({ id: verificationSlots.id });

    if (deleted.length === 0) {
      return { ok: false, error: "Slot hat Buchungen oder existiert nicht." };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: actorUserId,
      action: "verify_slot.deleted",
      targetType: "verification_slot",
      targetId: slotId,
      metadata: { slotId },
    });

    return { ok: true };
  });
}

/**
 * Ändert die Kapazität eines Slots — ATOMAR nur, wenn die neue Kapazität die
 * bestehenden Buchungen weiter trägt (neueKapazitaet >= booked_count; die
 * DB-CHECK-Constraint würde sonst ohnehin abbrechen, das bedingte UPDATE macht
 * daraus einen freundlichen Fehler) und im Rahmen 1..20 liegt. Tenant-scoped
 * über den Standort-Join.
 */
export async function slotKapazitaetAendernCore(
  db: Db,
  tenantId: string,
  actorUserId: string,
  slotId: string,
  neueKapazitaet: number,
): Promise<{ ok: boolean; error?: string }> {
  const { KAPAZITAET_MIN, KAPAZITAET_MAX } = STANDORT_LIMITS;
  if (
    !Number.isInteger(neueKapazitaet) ||
    neueKapazitaet < KAPAZITAET_MIN ||
    neueKapazitaet > KAPAZITAET_MAX
  ) {
    return { ok: false, error: `Kapazität muss zwischen ${KAPAZITAET_MIN} und ${KAPAZITAET_MAX} liegen.` };
  }

  return db.transaction(async (tx: Db) => {
    const updated = await tx
      .update(verificationSlots)
      .set({ capacity: neueKapazitaet })
      .where(
        and(
          eq(verificationSlots.id, slotId),
          sql`${neueKapazitaet} >= ${verificationSlots.bookedCount}`,
          sql`${verificationSlots.locationId} IN (SELECT id FROM verification_locations WHERE tenant_id = ${tenantId})`,
        ),
      )
      .returning({ id: verificationSlots.id });

    if (updated.length === 0) {
      return {
        ok: false,
        error: "Kapazität liegt unter den bestehenden Buchungen oder Slot nicht gefunden.",
      };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: actorUserId,
      action: "verify_slot.capacity_changed",
      targetType: "verification_slot",
      targetId: slotId,
      metadata: { slotId, neueKapazitaet },
    });

    return { ok: true };
  });
}
