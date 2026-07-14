/**
 * kennzahlen.ts — PII-freie Civic-Kennzahlen fürs Admin-Dashboard (P2, CANNANAS_EVAL §Empf. 5).
 *
 * BEWUSST OHNE "use server": reine, tenant-scoped Lese-Aggregate für Server-
 * Komponenten (vgl. polls/queries.ts). Liefert NUR Aggregatzahlen — keine
 * personenbezogenen Daten, keine Einzelstimmen.
 *
 * RE-IDENTIFIKATIONS-SCHUTZ (Critic-Auflage): Teilnahmezahlen (Stimmen) werden im
 * UI über `maskTeilnahme` maskiert — kleine Zahlen (1..n-1) würden bei einer
 * kleinen Ortsteil-Abstimmung Rückschlüsse auf einzelne Personen erlauben.
 */

import { and, eq, or, isNull, lte, gt, ne, count, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { polls, votes, qrCodes, anliegen } from "@/db/schema";

/** Schwelle, unter der Teilnahmezahlen maskiert werden (k-Anonymity-Heuristik). */
export const TEILNAHME_SCHWELLE = 5;

export interface AdminKennzahlen {
  /** Aktive, im Zeitfenster offene Abstimmungen (Objektzahl — unkritisch). */
  aktiveAbstimmungen: number;
  /** Stimmen auf laufenden Abstimmungen (Teilnahmezahl — im UI ab <Schwelle maskiert). */
  stimmenLaufend: number;
  /** Aktive QR-Codes: nicht widerrufen, nicht abgelaufen, Einlösungen frei (unkritisch). */
  aktiveQrCodes: number;
  /** Offene Anliegen (nicht beantwortet/umgesetzt/abgelehnt) (unkritisch). */
  offeneAnliegen: number;
}

/**
 * Tenant-scoped Aggregate fürs Dashboard. Vier kleine Count-Queries (kein N+1),
 * alle mit Drizzle-Operatoren (kein Roh-SQL-Date → kein Treiber-Abbruch).
 */
export async function getAdminKennzahlen(db: Db, tenantId: string): Promise<AdminKennzahlen> {
  const now = new Date();

  // Aktive, im Zeitfenster offene Abstimmungen des Tenants. BEWUSST OHNE Viewer-
  // Scheibe (kein Gebietsbaum-Filter): die Admin-Kennzahl zählt ALLE aktiven
  // Tenant-Polls, nicht die für einen einzelnen Wohnort sichtbare Teilmenge —
  // anders als getAktivePolls (das über den Baum scheibt). Nur Status/Zeitfenster.
  const aktivePollRows = await db
    .select({ id: polls.id })
    .from(polls)
    .where(
      and(
        eq(polls.tenantId, tenantId),
        eq(polls.status, "aktiv"),
        or(isNull(polls.opensAt), lte(polls.opensAt, now)),
        or(isNull(polls.closesAt), gt(polls.closesAt, now))
      )
    );
  const aktivePollIds = aktivePollRows.map((r: { id: string }) => r.id);

  // Stimmen auf laufenden Abstimmungen (Aggregat über alle aktiven Polls).
  let stimmenLaufend = 0;
  if (aktivePollIds.length > 0) {
    const r = await db
      .select({ c: count() })
      .from(votes)
      .where(and(eq(votes.tenantId, tenantId), inArray(votes.pollId, aktivePollIds)));
    stimmenLaufend = Number(r[0]?.c ?? 0);
  }

  // Aktive QR-Codes: nicht widerrufen, gültig, noch freie Einlösungen.
  const qrRows = await db
    .select({ c: count() })
    .from(qrCodes)
    .where(
      and(
        eq(qrCodes.tenantId, tenantId),
        isNull(qrCodes.revokedAt),
        gt(qrCodes.expiresAt, now),
        sql`${qrCodes.redemptionCount} < ${qrCodes.maxRedemptions}`
      )
    );
  const aktiveQrCodes = Number(qrRows[0]?.c ?? 0);

  // Offene Anliegen (nicht abgeschlossen).
  const anlRows = await db
    .select({ c: count() })
    .from(anliegen)
    .where(
      and(
        eq(anliegen.tenantId, tenantId),
        ne(anliegen.status, "beantwortet"),
        ne(anliegen.status, "umgesetzt"),
        ne(anliegen.status, "abgelehnt")
      )
    );
  const offeneAnliegen = Number(anlRows[0]?.c ?? 0);

  return {
    aktiveAbstimmungen: aktivePollIds.length,
    stimmenLaufend,
    aktiveQrCodes,
    offeneAnliegen,
  };
}

/**
 * Maskiert kleine Teilnahmezahlen gegen Re-Identifikation (Critic-Auflage P2 §5):
 * 0 ist unkritisch (niemand hat teilgenommen → exakt), 1..Schwelle-1 → "<Schwelle".
 * Ab der Schwelle exakte Zahl. Nur auf Teilnahme-/Stimmenzahlen anwenden, NICHT auf
 * Objektzahlen (aktive Polls, QR-Codes, Anliegen) — die sind nicht re-identifizierend.
 */
export function maskTeilnahme(n: number, schwelle = TEILNAHME_SCHWELLE): string {
  if (n > 0 && n < schwelle) return `<${schwelle}`;
  return String(n);
}
