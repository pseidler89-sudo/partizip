/**
 * qr-core.ts — Reine DB-Logik der QR-Verifizierung (ADR-014 Block 2).
 *
 * BEWUSST OHNE "use server" und ohne Request-Kontext (Cookies/Headers): Diese
 * Funktionen nehmen db/tenantId/userId als PARAMETER. Damit sind sie
 *   1. von den "use server"-Actions wiederverwendbar (die nur Auth/Tenant
 *      auflösen und dann hierher delegieren), und
 *   2. in DB-Integrationstests als ECHTE Funktionen aufrufbar (keine Spiegelung
 *      der Logik im Test — wie vom Auftrag gefordert).
 *
 * SICHERHEITS-KERN (Vertrauensprodukt):
 *   - Token wie Magic-Link: raw Token (CSPRNG) verlässt nie den Server; in der DB
 *     steht NUR sha256Hex(token). Der RAW-Token wird beim Erstellen GENAU EINMAL
 *     zurückgegeben (für den QR) und danach nie wieder abrufbar.
 *   - Cap-Atomarität: redemptionCount wird per atomarem bedingten UPDATE erhöht
 *     (WHERE redemptionCount < maxRedemptions ...) — kein Race-Überlauf.
 *   - Idempotenz: UNIQUE(qrCodeId, userId) + ON CONFLICT DO NOTHING → derselbe
 *     User kann nicht doppelt einlösen (kein Cap-Verbrauch beim Zweitversuch).
 *   - Ablauf/Widerruf: expiresAt/revokedAt machen einen QR uneinlösbar.
 *   - Kein Selbst-Hochstufen: Verifizierung NUR über gültigen Token (hier).
 *     Berechtigungsprüfung (canVerify) liegt in den Actions davor.
 *   - Tenant-Isolation: JEDE Query/jedes Update ist tenant-scoped.
 *
 * KEIN JS-Date in Roh-`sql` — Zeitvergleiche laufen über now() in der DB bzw.
 * Drizzle-Operatoren (lte/gt). Das vermeidet den Treiber-Abbruch („Received an
 * instance of Date") und ist race-frei (DB-Uhr statt App-Uhr im Cap-Update).
 */

import { and, eq, isNull, gt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  qrCodes,
  qrRedemptions,
  regions,
  users,
  ortsteile,
  auditEvents,
} from "@/db/schema";
import { generateRawToken, sha256Hex } from "@/lib/auth/crypto";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import type { ScopeInputLevel } from "@/lib/region/ebenen";

/** Composer-Eingabe-Ebene für die QR-Erstellung (TS-Union, kein DB-Enum mehr). */
export type ScopeLevel = ScopeInputLevel;

/** Wohnsitz-Verifizierung gilt nach Einlösung standardmäßig 24 Monate. */
export const QR_VERIFICATION_MONTHS = 24;

/** Verifizierungs-Methode für die Stufe-2-Vergabe (QR oder Termin vor Ort). */
export type ResidencyMethod = "qr" | "in_person";

/**
 * grantResidency — DER gemeinsame Stufe-2-Übergang (Privileg-Erhöhung), genutzt
 * von der QR-Einlösung UND der Termin-Bestätigung vor Ort. EINMAL definiert, damit
 * beide Wege identisch (und konservativ) verifizieren.
 *
 * Setzt die Person auf wohnsitz-verifiziert (verificationStatus='verified'),
 * hält die Methode fest, stempelt residencyVerifiedAt=now() und Ablauf in 24
 * Monaten und setzt die Re-Verify-Erinnerungs-Marke zurück (neuer Zyklus → vor
 * dem nächsten Ablauf wird erneut erinnert). Optional wird ein Ortsteil gesetzt.
 *
 * SICHERHEIT (nicht verhandelbar):
 *   - Tenant-scoped: WHERE id=userId AND tenant_id=tenantId (kein Cross-Tenant-Grant).
 *   - MUSS in der Transaktion des jeweiligen atomaren Einlöse-/Bestätigungs-Schritts
 *     laufen (Aufrufer übergibt tx) — kein eigenständiger Endpoint.
 *   - Kein Selbst-Hochstufen: Aufrufer haben den Token (QR) bzw. canVerify (Termin)
 *     bereits geprüft; diese Funktion vergibt ausschließlich, prüft keine Berechtigung.
 *   - residencyVerifiedUntil in JS berechnet (Monatsarithmetik) und als gebundener
 *     Parameter gesetzt — KEIN JS-Date in Roh-SQL. Rückgabe = der Ablauf-Zeitpunkt.
 */
export async function grantResidency(
  tx: Db,
  tenantId: string,
  userId: string,
  method: ResidencyMethod,
  opts?: { ortsteilId?: string; regionId?: string | null; regionTyp?: string | null },
): Promise<Date> {
  const verifiedUntil = addMonths(new Date(), QR_VERIFICATION_MONTHS);
  // Weichen Wohnort (home_region_id) nur an einen FEINEN Knoten (Gemeinde/
  // Ortsteil) koppeln: ein grober Kreis-/Land-QR würde die Standard-Sicht sonst
  // auf das gesamte Untergebiet aufweiten (path <@). residency_region_id (der
  // harte Anker) bildet dagegen exakt ab, was verifiziert wurde — auch grob.
  const homeGeeignet =
    opts?.regionTyp === "gemeinde" || opts?.regionTyp === "ortsteil";
  await tx
    .update(users)
    .set({
      verificationStatus: "verified",
      verificationMethod: method,
      residencyVerifiedAt: sql`now()`,
      residencyVerifiedUntil: verifiedUntil,
      // Neuer Verifizierungs-Zyklus → Erinnerungs-Marke zurücksetzen.
      reverifyReminderSentAt: null,
      ...(opts?.ortsteilId ? { ortsteilId: opts.ortsteilId } : {}),
      // Audit M3: den VERIFIZIERTEN Wohnsitz-Knoten festhalten (QR-Knoten bzw.
      // Standort-Region). Bisher blieb residency_region_id trotz Verifizierung
      // NULL — der „harte" Anker fehlte, auf den die Gebiets-Eligibility baut.
      ...(opts?.regionId
        ? {
            residencyRegionId: opts.regionId,
            // Weichen Wohnort nur setzen, wenn (a) noch keiner gewählt ist und
            // (b) der Knoten fein genug ist — bewusste Wahl nicht überschreiben.
            ...(homeGeeignet
              ? { homeRegionId: sql`COALESCE(${users.homeRegionId}, ${opts.regionId})` }
              : {}),
          }
        : {}),
    })
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
  return verifiedUntil;
}

export const QR_LIMITS = {
  MAX_REDEMPTIONS_MIN: 1,
  MAX_REDEMPTIONS_MAX: 10000,
  GUELTIGKEIT_STUNDEN_MIN: 1,
  GUELTIGKEIT_STUNDEN_MAX: 720, // 30 Tage
} as const;

export interface QrErstellenInput {
  scopeLevel: ScopeLevel;
  scopeCode?: string | null;
  label?: string | null;
  maxRedemptions: number;
  gueltigkeitStunden: number;
}

export interface QrErstellenResult {
  qrId: string;
  /** RAW-Token — GENAU EINMAL zurückgegeben, danach nie wieder abrufbar. */
  rawToken: string;
  expiresAt: Date;
}

/**
 * Erzeugt einen QR-Code (tenant-scoped). Speichert NUR tokenHash + Felder.
 * expiresAt = now() + gueltigkeitStunden (in der DB berechnet, kein JS-Date in
 * Roh-SQL für den Wert — wir nutzen Drizzle-Insert mit einem JS-Date, das der
 * Treiber korrekt als Parameter bindet).
 *
 * Berechtigung (canVerify) wird in der aufrufenden Action geprüft.
 * `createdBy` ist der einlösungsfähige Verifier/Admin (für die Audit-Spur).
 */
export async function qrErstellenCore(
  db: Db,
  tenantId: string,
  createdBy: string,
  input: QrErstellenInput,
): Promise<QrErstellenResult> {
  const rawToken = generateRawToken();
  const tokenHash = sha256Hex(rawToken);
  // JS-Date als gebundener Insert-Wert ist unkritisch (Treiber bindet es als
  // Parameter); nur in Roh-`sql`-Templates wäre ein JS-Date verboten.
  const expiresAt = new Date(Date.now() + input.gueltigkeitStunden * 60 * 60 * 1000);

  // ADR-024 contract: die Scope-Eingabe wird via Baum zu region_id aufgelöst — der
  // EINZIGE geschriebene Gebietsbezug (scope_level/scope_code sind entfernt).
  const regionId = await resolveRegionIdForScope(
    db,
    tenantId,
    input.scopeLevel,
    input.scopeCode ?? null
  );

  return db.transaction(async (tx: Db) => {
    const [row] = await tx
      .insert(qrCodes)
      .values({
        tenantId,
        regionId,
        tokenHash,
        label: input.label ?? null,
        maxRedemptions: input.maxRedemptions,
        expiresAt,
        createdBy,
      })
      .returning({ id: qrCodes.id, expiresAt: qrCodes.expiresAt });

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: createdBy,
      action: "qr.created",
      targetType: "qr_code",
      targetId: row.id,
      // PII-frei: nur Scope/Limit, NIEMALS der tokenHash oder raw Token.
      metadata: {
        qrId: row.id,
        scopeLevel: input.scopeLevel,
        maxRedemptions: input.maxRedemptions,
      },
    });

    return { qrId: row.id, rawToken, expiresAt: row.expiresAt };
  });
}

/**
 * Widerruft einen QR-Code (tenant-scoped). Setzt revokedAt nur, wenn noch nicht
 * widerrufen (idempotent). Berechtigung (canVerify) prüft die Action.
 */
export async function qrWiderrufenCore(
  db: Db,
  tenantId: string,
  actorUserId: string,
  qrId: string,
): Promise<{ ok: boolean; error?: string }> {
  return db.transaction(async (tx: Db) => {
    const updated = await tx
      .update(qrCodes)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(qrCodes.id, qrId),
          eq(qrCodes.tenantId, tenantId),
          isNull(qrCodes.revokedAt),
        ),
      )
      .returning({ id: qrCodes.id });

    if (updated.length === 0) {
      return { ok: false, error: "QR-Code nicht gefunden oder bereits widerrufen." };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: actorUserId,
      action: "qr.revoked",
      targetType: "qr_code",
      targetId: qrId,
      metadata: { qrId },
    });

    return { ok: true };
  });
}

export interface QrEinloesenResult {
  ok: boolean;
  /** true ⇒ derselbe User hatte schon eingelöst (kein Cap-Verbrauch). */
  alreadyRedeemed?: boolean;
  /** Ablauf der Wohnsitz-Verifizierung nach erfolgreicher Einlösung. */
  verifiedUntil?: Date;
  error?: string;
}

/**
 * Löst einen QR-Code für einen EINGELOGGTEN User ein (Stufe ≥ 1 — die Action
 * erzwingt das). Race-frei in EINER Transaktion:
 *
 *   1. INSERT redemption ON CONFLICT (qrCodeId,userId) DO NOTHING RETURNING id.
 *      Kein Row → User hat schon eingelöst → {ok:true, alreadyRedeemed:true}
 *      (KEIN Cap-Verbrauch, kein Re-Verify nötig).
 *   2. Sonst: atomare bedingte Erhöhung
 *      UPDATE qr_codes SET redemptionCount = redemptionCount+1
 *      WHERE id=? AND tenantId=? AND revokedAt IS NULL AND expiresAt > now()
 *            AND redemptionCount < maxRedemptions RETURNING id.
 *      0 Rows → voll/abgelaufen/widerrufen → throw → Rollback (auch der Insert).
 *   3. User verifizieren: verificationStatus='verified', method='qr',
 *      residencyVerifiedAt=now(), residencyVerifiedUntil = now + 24 Monate;
 *      bei scopeLevel='ortsteil' + scopeCode → passenden ortsteile-Datensatz
 *      (code+tenant) finden und users.ortsteilId setzen (sonst unverändert).
 *   4. Audit qr.redeemed (PII-frei: actorRef=userId, metadata {qrId, scopeLevel}).
 *
 * Vorab-Lookup über tokenHash (tenant-scoped) für freundliche Fehler. Die harte
 * Race-/Cap-/Ablauf-Prüfung passiert im bedingten UPDATE in der Transaktion.
 */
export async function qrEinloesenCore(
  db: Db,
  tenantId: string,
  userId: string,
  rawToken: string,
): Promise<QrEinloesenResult> {
  const tokenHash = sha256Hex(rawToken);

  // Vorab-Lookup (tenant-scoped) — nur für freundliche Fehlermeldungen. Die
  // verbindliche Prüfung erfolgt atomar im bedingten UPDATE. Die Gebietsart des
  // QR-Knotens (regions.typ) + sein path_label ersetzen das alte scope_level/
  // scope_code für die Ortsteil-Zuordnung beim Einlösen (ADR-024 contract).
  const found = await db
    .select({
      id: qrCodes.id,
      regionId: qrCodes.regionId,
      regionTyp: regions.typ,
      regionPathLabel: regions.pathLabel,
      expiresAt: qrCodes.expiresAt,
      revokedAt: qrCodes.revokedAt,
    })
    .from(qrCodes)
    .innerJoin(regions, eq(regions.id, qrCodes.regionId))
    .where(and(eq(qrCodes.tokenHash, tokenHash), eq(qrCodes.tenantId, tenantId)))
    .limit(1);

  const qr = found[0];
  if (!qr) {
    return { ok: false, error: "Dieser Code ist ungültig." };
  }
  if (qr.revokedAt) {
    return { ok: false, error: "Dieser Code wurde widerrufen." };
  }
  if (qr.expiresAt <= new Date()) {
    return { ok: false, error: "Dieser Code ist abgelaufen." };
  }

  try {
    return await db.transaction(async (tx: Db) => {
      // 1. Redemption-Insert (Idempotenz via UNIQUE).
      const inserted = await tx
        .insert(qrRedemptions)
        .values({ qrCodeId: qr.id, userId, tenantId })
        .onConflictDoNothing({
          target: [qrRedemptions.qrCodeId, qrRedemptions.userId],
        })
        .returning({ id: qrRedemptions.id });

      if (inserted.length === 0) {
        // Schon eingelöst → kein Cap-Verbrauch, kein Re-Verify.
        return { ok: true, alreadyRedeemed: true };
      }

      // 2. Atomare bedingte Cap-Erhöhung. Zeit über DB-now() (race-frei).
      const bumped = await tx
        .update(qrCodes)
        .set({ redemptionCount: sql`${qrCodes.redemptionCount} + 1` })
        .where(
          and(
            eq(qrCodes.id, qr.id),
            eq(qrCodes.tenantId, tenantId),
            isNull(qrCodes.revokedAt),
            gt(qrCodes.expiresAt, sql`now()`),
            sql`${qrCodes.redemptionCount} < ${qrCodes.maxRedemptions}`,
          ),
        )
        .returning({ id: qrCodes.id });

      if (bumped.length === 0) {
        // Voll/abgelaufen/widerrufen — throw, damit der Redemption-Insert
        // ZURÜCKROLLT (kein „Phantom"-Redemption ohne Cap-Verbrauch).
        throw new QrCapError();
      }

      // 3. User verifizieren (tenant-scoped) über den gemeinsamen Stufe-2-Grant.
      // Optionalen Ortsteil setzen, wenn der QR-Knoten ein Ortsteil ist: der
      // passende ortsteile-Datensatz wird über sein normalisiertes Label
      // (regions_ltree_label(code) = regions.path_label) tenant-scoped aufgelöst —
      // identisch zur Baum-Spiegelung (ADR-024), ersetzt das alte code-Matching.
      let ortsteilId: string | undefined;
      if (qr.regionTyp === "ortsteil") {
        const ot = await tx
          .select({ id: ortsteile.id })
          .from(ortsteile)
          .where(
            and(
              eq(ortsteile.tenantId, tenantId),
              sql`regions_ltree_label(${ortsteile.code}) = ${qr.regionPathLabel}`,
            ),
          )
          .limit(1);
        if (ot[0]) ortsteilId = ot[0].id;
      }

      const verifiedUntil = await grantResidency(tx, tenantId, userId, "qr", {
        ortsteilId,
        // Der verifizierte Wohnsitz-Knoten = der Gebietsknoten des QR-Codes.
        regionId: qr.regionId,
        regionTyp: qr.regionTyp,
      });

      // 4. Audit (PII-frei: actorRef=userId ist eine UUID, kein Personenbezug
      //    ohne DB; metadata nur qrId + Gebietsart — kein tokenHash, keine E-Mail).
      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "user",
        actorRef: userId,
        action: "qr.redeemed",
        targetType: "qr_code",
        targetId: qr.id,
        metadata: { qrId: qr.id, regionTyp: qr.regionTyp },
      });

      return { ok: true, alreadyRedeemed: false, verifiedUntil };
    });
  } catch (err) {
    if (err instanceof QrCapError) {
      return { ok: false, error: "Dieser Code ist aufgebraucht oder abgelaufen." };
    }
    throw err;
  }
}

/** Interner Marker-Fehler für den atomaren Cap-Rollback (siehe oben). */
export class QrCapError extends Error {
  constructor() {
    super("qr-cap-exhausted");
    this.name = "QrCapError";
  }
}

/**
 * Addiert ganze Monate auf ein Datum (kalendergenau, mit Überlauf-Korrektur).
 * Reine JS-Funktion — das Ergebnis wird als gebundener Parameter gesetzt (nie in
 * Roh-SQL). Beispiel: 31.01. + 1 Monat → 28./29.02. (kein 03.03.).
 */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetMonth = d.getMonth() + months;
  const result = new Date(d.getTime());
  result.setMonth(targetMonth);
  // Überlauf-Korrektur: wenn der Zielmonat weniger Tage hat, auf Monatsletzten.
  if (result.getDate() !== d.getDate()) {
    result.setDate(0);
  }
  return result;
}
