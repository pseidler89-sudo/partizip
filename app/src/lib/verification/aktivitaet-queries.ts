/**
 * aktivitaet-queries.ts — Lese-Queries der Team-/Aktivitätssicht + Verifier-
 * Anomalie-Kennzahlen (Block K4, Server-Component-Nutzung, NUR Admin-Seite).
 *
 * BEWUSST OHNE "use server" (Muster standort-queries.ts / queries.ts, Gate-B
 * MAJOR-G): reine, tenant-scoped Lesezugriffe. Lägen sie in einer "use server"-
 * Datei, würde Next.js sie als client-aufrufbare RPC mit client-kontrolliertem
 * tenantId exponieren.
 *
 * ZWECK (Spec §7): Missbrauch sichtbar machen statt Scheinprüfung. Es werden
 * ausschließlich AGGREGATE über die Verifizierungs-Infrastruktur (QR-Codes,
 * Einlösungen, Termine) ausgewertet — NIEMALS Stimmverhalten, nie welcher
 * Bürger welchen QR eingelöst hat. Die einzige PII ist die E-Mail der
 * Rollenträger:innen (Verifier/QR-Ersteller) — zulässig auf der Admin-Fläche,
 * analog admin/rollen. Bürger-PII taucht nirgends auf.
 *
 * Konventionen: keine JS-Dates in Roh-SQL (Zeitfenster über DB-`now()`);
 * Tenant-Isolation in JEDER Query über die tenant_id-Redundanz.
 */

import { and, eq, asc, desc, count, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { qrCodes, qrRedemptions, regions, users, roles, verificationBookings, verificationLocations, verificationSlots } from "@/db/schema";
import { VERIFIER_ROLES } from "@/lib/auth/roles";
import type { RegionTyp } from "@/lib/region/ebenen";

// ---------------------------------------------------------------------------
// Schwellen der Auffälligkeits-Ableitung (bewusst zentral + benannt, damit die
// Tests dieselben Grenzen prüfen).
// ---------------------------------------------------------------------------

/** QR-Ausschöpfung ab dieser Quote gilt als „fast ausgeschöpft". */
export const AUSSCHOEPFUNG_SCHWELLE = 0.8;
/** Mehr als so viele Einlösungen an EINEM Kalendertag je Verifier = „Spitze". */
export const SPITZE_SCHWELLE = 20;

// ---------------------------------------------------------------------------
// 1) Einlösungen je Verifier (QR-Ersteller)
// ---------------------------------------------------------------------------

export interface VerifierAktivitaet {
  /** users.id des QR-Erstellers; null wenn der Ersteller gelöscht/anonymisiert wurde. */
  createdBy: string | null;
  /** E-Mail des Erstellers (nur Anzeige, admin-only); null wenn Ersteller entfernt. */
  email: string | null;
  /**
   * Trägt der Ersteller AKTUELL noch eine verifizierende Rolle (verifier/
   * kommune_admin/super_admin)? false ⇒ Anzeige „(Rolle entzogen)" + Grundlage
   * der Auffälligkeit „Aktivität nach Rollen-Entzug".
   */
  hatVerifierRolle: boolean;
  /** QR-Codes gesamt, die dieser Ersteller angelegt hat. */
  qrGesamt: number;
  /** Davon aktiv (nicht widerrufen UND nicht abgelaufen). */
  qrAktiv: number;
  einloesungen7d: number;
  einloesungen30d: number;
  einloesungenGesamt: number;
  /** Zeitpunkt der letzten Einlösung über alle QR-Codes dieses Erstellers. */
  letzteEinloesung: Date | null;
}

/**
 * Aktivität je QR-Ersteller (Verifier): Anzahl QR-Codes gesamt/aktiv,
 * Einlösungen 7d/30d/gesamt, letzte Einlösung. Tenant-scoped über
 * qr_codes.tenant_id bzw. qr_redemptions.tenant_id.
 *
 * Auch Verifier, deren Rolle inzwischen entzogen wurde, erscheinen (created_by
 * bleibt am QR-Code) — mit `hatVerifierRolle=false`. Gruppierung nach
 * created_by; ein gelöschter Ersteller (created_by = NULL, SET NULL) bildet eine
 * eigene Sammelzeile ohne E-Mail.
 */
export async function getEinloesungenJeVerifier(
  db: Db,
  tenantId: string,
): Promise<VerifierAktivitaet[]> {
  // QR-Codes je Ersteller: gesamt + aktiv (revoked_at IS NULL AND expires_at > now()).
  const codeAgg = await db
    .select({
      createdBy: qrCodes.createdBy,
      qrGesamt: count(qrCodes.id),
      qrAktiv:
        sql<number>`count(*) filter (where ${qrCodes.revokedAt} is null and ${qrCodes.expiresAt} > now())`.mapWith(
          Number,
        ),
    })
    .from(qrCodes)
    .where(eq(qrCodes.tenantId, tenantId))
    .groupBy(qrCodes.createdBy);

  // Einlösungen je Ersteller (join qr_codes für created_by), gefensterte Zählung
  // über DB-now(); letzte Einlösung als MAX(redeemed_at).
  const redAgg = await db
    .select({
      createdBy: qrCodes.createdBy,
      einloesungen7d:
        sql<number>`count(*) filter (where ${qrRedemptions.redeemedAt} >= now() - interval '7 days')`.mapWith(
          Number,
        ),
      einloesungen30d:
        sql<number>`count(*) filter (where ${qrRedemptions.redeemedAt} >= now() - interval '30 days')`.mapWith(
          Number,
        ),
      einloesungenGesamt: count(qrRedemptions.id),
      // max() über einen sql-Ausdruck trägt den timestamptz-Typ-Parser NICHT
      // automatisch (postgres-js liefert dann einen String) — daher explizit als
      // String selektieren und unten robust zu Date wandeln.
      letzteEinloesung: sql<string | null>`max(${qrRedemptions.redeemedAt})`,
    })
    .from(qrRedemptions)
    .innerJoin(qrCodes, eq(qrCodes.id, qrRedemptions.qrCodeId))
    .where(eq(qrRedemptions.tenantId, tenantId))
    .groupBy(qrCodes.createdBy);

  type CodeRow = { createdBy: string | null; qrGesamt: number; qrAktiv: number };
  type RedRow = {
    createdBy: string | null;
    einloesungen7d: number;
    einloesungen30d: number;
    einloesungenGesamt: number;
    letzteEinloesung: string | null;
  };

  const redByCreator = new Map<string | null, RedRow>(
    (redAgg as RedRow[]).map((r) => [r.createdBy, r]),
  );

  // E-Mail + aktuelle Rollen-Zugehörigkeit für die (nicht-null) Ersteller-IDs.
  const creatorIds = Array.from(
    new Set(
      (codeAgg as CodeRow[])
        .map((r) => r.createdBy)
        .filter((id): id is string => id !== null),
    ),
  );
  const { emailMap, verifierSet } = await ladeErstellerKontext(db, tenantId, creatorIds);

  const zeilen: VerifierAktivitaet[] = (codeAgg as CodeRow[]).map((c) => {
    const red = redByCreator.get(c.createdBy);
    return {
      createdBy: c.createdBy,
      email: c.createdBy ? (emailMap.get(c.createdBy) ?? null) : null,
      hatVerifierRolle: c.createdBy ? verifierSet.has(c.createdBy) : false,
      qrGesamt: Number(c.qrGesamt),
      qrAktiv: Number(c.qrAktiv),
      einloesungen7d: Number(red?.einloesungen7d ?? 0),
      einloesungen30d: Number(red?.einloesungen30d ?? 0),
      einloesungenGesamt: Number(red?.einloesungenGesamt ?? 0),
      letzteEinloesung: red?.letzteEinloesung ? new Date(red.letzteEinloesung) : null,
    };
  });

  // Meiste Einlösungen zuoberst; E-Mail als stabiler Sekundärschlüssel.
  zeilen.sort(
    (a, b) =>
      b.einloesungenGesamt - a.einloesungenGesamt ||
      (a.email ?? "").localeCompare(b.email ?? ""),
  );
  return zeilen;
}

/**
 * Hilfs-Lookup: E-Mail-Map + Menge der IDs mit AKTIVER verifizierender Rolle
 * (verifier/kommune_admin/super_admin) für eine gegebene Ersteller-ID-Liste.
 * Tenant-scoped; die Rollen-Zugehörigkeit wird über account_status='active'
 * gefiltert (ein gesperrtes Konto trägt effektiv keine wirksame Rolle mehr —
 * konsistent mit getUserRoleTypes/canVerify).
 */
async function ladeErstellerKontext(
  db: Db,
  tenantId: string,
  creatorIds: string[],
): Promise<{ emailMap: Map<string, string>; verifierSet: Set<string> }> {
  if (creatorIds.length === 0) {
    return { emailMap: new Map(), verifierSet: new Set() };
  }

  // E-Mails der Ersteller (tenant-scoped). inArray über die konkrete ID-Liste.
  const userRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, creatorIds)));
  const emailMap = new Map<string, string>(
    (userRows as { id: string; email: string }[]).map((u) => [u.id, u.email]),
  );

  // Wer trägt aktuell eine verifizierende Rolle (aktives Konto)?
  const rollenRows = await db
    .select({ userId: roles.userId })
    .from(roles)
    .innerJoin(users, eq(users.id, roles.userId))
    .where(
      and(
        eq(roles.tenantId, tenantId),
        eq(users.accountStatus, "active"),
        inArray(roles.roleType, [...VERIFIER_ROLES]),
        inArray(roles.userId, creatorIds),
      ),
    );
  const verifierSet = new Set<string>(
    (rollenRows as { userId: string }[]).map((r) => r.userId),
  );

  return { emailMap, verifierSet };
}

// ---------------------------------------------------------------------------
// 2) QR-Ausschöpfung je aktivem QR-Code
// ---------------------------------------------------------------------------

/** Anzeige-/Ableitungs-Obergrenze der Ausschöpfungs-Liste. */
export const AUSSCHOEPFUNG_MAX = 100;

export interface QrAusschoepfung {
  qrCodeId: string;
  label: string | null;
  regionTyp: RegionTyp;
  regionName: string;
  redemptionCount: number;
  maxRedemptions: number;
  /** redemptionCount / maxRedemptions in [0, 1]. */
  quote: number;
  /** E-Mail des Erstellers (Anzeige); null wenn Ersteller entfernt. */
  createdByEmail: string | null;
}

/**
 * Ausschöpfung je AKTIVEM QR-Code (nicht widerrufen, nicht abgelaufen),
 * absteigend nach Quote (redemption_count/max_redemptions). Region-Label wie
 * qrCodesListe (regions.typ + name), Ersteller-E-Mail via LEFT JOIN (Ersteller
 * kann entfernt sein). Auf AUSSCHOEPFUNG_MAX gedeckelt.
 */
export async function getQrAusschoepfung(
  db: Db,
  tenantId: string,
): Promise<QrAusschoepfung[]> {
  const rows = await db
    .select({
      qrCodeId: qrCodes.id,
      label: qrCodes.label,
      regionTyp: regions.typ,
      regionName: regions.name,
      redemptionCount: qrCodes.redemptionCount,
      maxRedemptions: qrCodes.maxRedemptions,
      createdByEmail: users.email,
    })
    .from(qrCodes)
    .innerJoin(regions, eq(regions.id, qrCodes.regionId))
    .leftJoin(users, eq(users.id, qrCodes.createdBy))
    .where(
      and(
        eq(qrCodes.tenantId, tenantId),
        sql`${qrCodes.revokedAt} is null`,
        sql`${qrCodes.expiresAt} > now()`,
      ),
    )
    // Sortierung über den Quotienten direkt in SQL (max_redemptions >= 1 laut
    // CHECK, daher kein Nulldivisions-Risiko), Sekundär nach Anzahl.
    .orderBy(
      desc(sql`${qrCodes.redemptionCount}::float / ${qrCodes.maxRedemptions}`),
      desc(qrCodes.redemptionCount),
    )
    .limit(AUSSCHOEPFUNG_MAX);

  type Row = {
    qrCodeId: string;
    label: string | null;
    regionTyp: RegionTyp;
    regionName: string;
    redemptionCount: number;
    maxRedemptions: number;
    createdByEmail: string | null;
  };

  return (rows as Row[]).map((r) => ({
    qrCodeId: r.qrCodeId,
    label: r.label,
    regionTyp: r.regionTyp,
    regionName: r.regionName,
    redemptionCount: Number(r.redemptionCount),
    maxRedemptions: Number(r.maxRedemptions),
    quote: r.maxRedemptions > 0 ? Number(r.redemptionCount) / Number(r.maxRedemptions) : 0,
    createdByEmail: r.createdByEmail,
  }));
}

// ---------------------------------------------------------------------------
// 3) Wahrgenommene Termine je Standort
// ---------------------------------------------------------------------------

export interface StandortTermine {
  locationId: string;
  name: string;
  isActive: boolean;
  wahrgenommen7d: number;
  wahrgenommen30d: number;
  wahrgenommenGesamt: number;
  /** Offene künftige Buchungen (status='gebucht' AND starts_at > now()). */
  offeneKuenftige: number;
}

/**
 * Termin-Kennzahlen je Standort (auch inaktive Standorte). „Wahrgenommen" =
 * verification_bookings.status='wahrgenommen' (Enum-Wert aus dem Schema, nicht
 * geraten); die Zeitfenster laufen über den TERMIN-Zeitpunkt (slot.starts_at) —
 * das ist der Zeitpunkt, an dem sich die Person vor Ort ausgewiesen hat. Offene
 * künftige Buchungen zusätzlich als Auslastungs-Signal. Tenant-scoped über
 * verification_bookings.tenant_id (Slot→Location-Join für die Zuordnung).
 */
export async function getTermineJeStandort(
  db: Db,
  tenantId: string,
): Promise<StandortTermine[]> {
  const locs = await db
    .select({
      id: verificationLocations.id,
      name: verificationLocations.name,
      isActive: verificationLocations.isActive,
    })
    .from(verificationLocations)
    .where(eq(verificationLocations.tenantId, tenantId))
    .orderBy(asc(verificationLocations.name));

  if (locs.length === 0) return [];

  const agg = await db
    .select({
      locationId: verificationSlots.locationId,
      wahrgenommen7d:
        sql<number>`count(*) filter (where ${verificationBookings.status} = 'wahrgenommen' and ${verificationSlots.startsAt} >= now() - interval '7 days')`.mapWith(
          Number,
        ),
      wahrgenommen30d:
        sql<number>`count(*) filter (where ${verificationBookings.status} = 'wahrgenommen' and ${verificationSlots.startsAt} >= now() - interval '30 days')`.mapWith(
          Number,
        ),
      wahrgenommenGesamt:
        sql<number>`count(*) filter (where ${verificationBookings.status} = 'wahrgenommen')`.mapWith(
          Number,
        ),
      offeneKuenftige:
        sql<number>`count(*) filter (where ${verificationBookings.status} = 'gebucht' and ${verificationSlots.startsAt} > now())`.mapWith(
          Number,
        ),
    })
    .from(verificationBookings)
    .innerJoin(verificationSlots, eq(verificationSlots.id, verificationBookings.slotId))
    .where(eq(verificationBookings.tenantId, tenantId))
    .groupBy(verificationSlots.locationId);

  type AggRow = {
    locationId: string;
    wahrgenommen7d: number;
    wahrgenommen30d: number;
    wahrgenommenGesamt: number;
    offeneKuenftige: number;
  };
  type LocRow = { id: string; name: string; isActive: boolean };

  const aggByLoc = new Map<string, AggRow>(
    (agg as AggRow[]).map((r) => [r.locationId, r]),
  );

  return (locs as LocRow[]).map((l) => {
    const a = aggByLoc.get(l.id);
    return {
      locationId: l.id,
      name: l.name,
      isActive: l.isActive,
      wahrgenommen7d: a?.wahrgenommen7d ?? 0,
      wahrgenommen30d: a?.wahrgenommen30d ?? 0,
      wahrgenommenGesamt: a?.wahrgenommenGesamt ?? 0,
      offeneKuenftige: a?.offeneKuenftige ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 4) Auffälligkeiten — reine Ableitung aus 1–3 (+ Tages-Spitzen aus SQL)
// ---------------------------------------------------------------------------

export type AuffaelligkeitTyp =
  | "qr_ausschoepfung"
  | "einloese_spitze"
  | "rollen_entzug";

export interface Auffaelligkeit {
  typ: AuffaelligkeitTyp;
  /** Klartext-Beschreibung OHNE Bürger-PII (nur Verifier-E-Mail/QR-Label/Standortname). */
  beschreibung: string;
  /** Kurzer Bezug (QR-Label, E-Mail, Datum) für die UI-Sekundärzeile. */
  bezug: string;
}

/**
 * Leitet Auffälligkeiten ab (kein LLM, kein Audit-Scan): fast ausgeschöpfte
 * QR-Codes, Einlöse-Spitzen (> SPITZE_SCHWELLE an einem Kalendertag je Verifier,
 * 7-Tage-Fenster) und Einlöse-Aktivität durch Ersteller ohne aktive
 * verifizierende Rolle. Leere Liste ⇒ positives Signal (die UI zeigt dann
 * „Keine Auffälligkeiten"). Beschreibungen enthalten NIE Bürger-PII.
 */
export async function getAuffaelligkeiten(
  db: Db,
  tenantId: string,
): Promise<Auffaelligkeit[]> {
  const [verifier, ausschoepfung] = await Promise.all([
    getEinloesungenJeVerifier(db, tenantId),
    getQrAusschoepfung(db, tenantId),
  ]);

  const auff: Auffaelligkeit[] = [];

  // (a) QR-Codes fast ausgeschöpft (≥ Schwelle). Absteigend nach Quote.
  for (const q of ausschoepfung) {
    if (q.quote >= AUSSCHOEPFUNG_SCHWELLE) {
      const label = q.label ?? "(ohne Bezeichnung)";
      auff.push({
        typ: "qr_ausschoepfung",
        beschreibung: `QR-Code „${label}" ist zu ${Math.round(q.quote * 100)} % ausgeschöpft (${q.redemptionCount}/${q.maxRedemptions}).`,
        bezug: q.createdByEmail ? `Ersteller: ${q.createdByEmail}` : "Ersteller entfernt",
      });
    }
  }

  // (b) Einlöse-Spitzen: > SPITZE_SCHWELLE Einlösungen an EINEM Kalendertag
  // (Europe/Berlin) je Ersteller im 7-Tage-Fenster. Tages-Gruppierung in SQL.
  const tagExpr = sql<string>`(${qrRedemptions.redeemedAt} at time zone 'Europe/Berlin')::date`;
  const spitzenRows = await db
    .select({
      createdBy: qrCodes.createdBy,
      tag: tagExpr,
      n: count(qrRedemptions.id),
    })
    .from(qrRedemptions)
    .innerJoin(qrCodes, eq(qrCodes.id, qrRedemptions.qrCodeId))
    .where(
      and(
        eq(qrRedemptions.tenantId, tenantId),
        sql`${qrRedemptions.redeemedAt} >= now() - interval '7 days'`,
      ),
    )
    .groupBy(qrCodes.createdBy, tagExpr)
    .having(sql`count(${qrRedemptions.id}) > ${SPITZE_SCHWELLE}`);

  type SpitzeRow = { createdBy: string | null; tag: string; n: number };
  const emailByCreator = new Map<string | null, string | null>(
    verifier.map((v) => [v.createdBy, v.email]),
  );
  for (const s of spitzenRows as SpitzeRow[]) {
    const email = emailByCreator.get(s.createdBy) ?? null;
    const tag = String(s.tag).slice(0, 10);
    auff.push({
      typ: "einloese_spitze",
      beschreibung: `Ungewöhnlich viele Einlösungen an einem Tag: ${Number(s.n)} am ${tag}${email ? ` durch ${email}` : ""}.`,
      bezug: `Kalendertag ${tag}`,
    });
  }

  // (c) Aktivität nach Rollen-Entzug: Ersteller ohne aktive verifizierende
  // Rolle, an dessen QR-Codes es Einlösungen gab. Nur zurechenbare Ersteller
  // (created_by nicht NULL).
  for (const v of verifier) {
    if (v.createdBy && !v.hatVerifierRolle && v.einloesungenGesamt > 0) {
      auff.push({
        typ: "rollen_entzug",
        beschreibung: `Einlösungen über QR-Codes von ${v.email ?? "einem entfernten Konto"}, obwohl aktuell keine Verifizierer-Rolle besteht (${v.einloesungenGesamt} gesamt).`,
        bezug: v.email ? `Konto: ${v.email}` : "Konto entfernt",
      });
    }
  }

  return auff;
}
