/**
 * einrichtung.ts — Status der Einrichtungs-Schritte eines Kontos (Checkliste).
 *
 * BEWUSST OHNE "use server": Diese Funktionen sind reine, tenant-scoped
 * Lesezugriffe und werden nur aus Server-Komponenten/Route-Handlern aufgerufen.
 * Lägen sie in einer "use server"-Action-Datei, würde Next.js sie als
 * client-aufrufbare RPC-Endpunkte mit client-kontrolliertem tenantId
 * exponieren (vgl. polls/queries.ts, Gate-B MAJOR-G).
 *
 * Zweck: Nutzer sehen leise und ehrlich, welche Einrichtungs-Schritte ihren
 * Handlungsspielraum erweitern (Wohnort → Sicht, Verifizierung → verbindliche
 * Stimme, Benachrichtigung → nichts verpassen, erste Teilnahme → Einstieg).
 * KEINE Gamification — die Flächen verschwinden vollständig, wenn alles
 * erledigt ist (alleErledigt).
 *
 * SECRET BALLOT: Die Teilnahme-Existenz wird ausschließlich über den voter_ref
 * (HMAC, kein User-FK an der Stimme) gegen votes ∪ vote_allocations ∪
 * vote_resistances geprüft — es wird NUR die Existenz (boolean) ermittelt,
 * NIE choice/Punkte/Werte selektiert.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { votes, voteAllocations, voteResistances } from "@/db/schema";
import type { TenantRow } from "@/lib/tenant";
import { computeVoterRefForUser } from "@/lib/polls/voter-ref";
import { getStufe } from "@/lib/eligibility/stufe";

export interface EinrichtungsStatus {
  /** Weicher Wohnort-Knoten (home_region_id) ODER Konto-Ortsteil gesetzt. */
  wohnortGesetzt: boolean;
  /** Wohnsitz verifiziert (Stufe ≥ 2 über getStufe — inkl. Ablauf/Entzug). */
  verifiziert: boolean;
  /** E-Mail bei neuen Abstimmungen aktiv (notify_new_polls). */
  benachrichtigungAn: boolean;
  /** Mindestens eine Teilnahme in irgendeinem Abstimm-Format (nur das OB). */
  ersteTeilnahme: boolean;
  /** Alle vier Schritte erledigt → Checkliste/Nudge verschwinden vollständig. */
  alleErledigt: boolean;
}

/** Der eine als Nächstes empfohlene Einrichtungs-Schritt (Fläche B zeigt nie mehrere). */
export type EinrichtungsSchritt =
  | "wohnort"
  | "verifizierung"
  | "benachrichtigung"
  | "teilnahme";

/**
 * user-row-Ausschnitt für die Status-Berechnung. Enthält die vollen
 * getStufe-Felder (Stufe NIE aus Teilinformationen ableiten) plus die
 * Einrichtungs-Felder — datensparsam, keine PII wie E-Mail nötig.
 */
export interface EinrichtungsUserRow {
  ortsteilId: string | null;
  homeRegionId: string | null;
  notifyNewPolls: boolean;
  verificationStatus: "pending" | "verified" | "rejected";
  residencyVerifiedAt: Date | null;
  residencyVerifiedUntil?: Date | null;
  accountStatus: "active" | "locked" | "deleted";
  minAgeConfirmedAt: Date | null;
}

/**
 * Berechnet den Einrichtungs-Status eines eingeloggten Users (tenant-scoped).
 *
 * ersteTeilnahme: drei parallele Existenz-Queries (limit 1, nur id) über die
 * drei Stimm-Tabellen. Schlägt die voter_ref-Ableitung fehl (Salt nicht
 * konfiguriert), gilt der Schritt als erledigt — Schritt ausblenden statt
 * fälschlich nörgeln (die Checkliste ist ein Hinweis, kein Gate).
 */
export async function getEinrichtungsStatus(
  db: Db,
  tenant: TenantRow,
  user: EinrichtungsUserRow,
  userId: string,
): Promise<EinrichtungsStatus> {
  const wohnortGesetzt = user.homeRegionId != null || user.ortsteilId != null;
  const verifiziert = getStufe(user) >= 2;
  const benachrichtigungAn = user.notifyNewPolls;

  let ersteTeilnahme = true;
  let voterRef: string | null;
  try {
    voterRef = computeVoterRefForUser(userId);
  } catch {
    voterRef = null;
  }
  if (voterRef != null) {
    // Deckt ALLE Abstimm-Formate ab: Ja/Nein liegt in `votes`, Dot-Voting NUR
    // in `vote_allocations`, Widerstandsabfragen NUR in `vote_resistances`
    // (vgl. hatBereitsAbgestimmtBatch). Jede Query tenant-scoped.
    const [voteRows, allocRows, resistRows] = await Promise.all([
      db
        .select({ id: votes.id })
        .from(votes)
        .where(and(eq(votes.tenantId, tenant.id), eq(votes.voterRef, voterRef)))
        .limit(1),
      db
        .select({ id: voteAllocations.id })
        .from(voteAllocations)
        .where(
          and(
            eq(voteAllocations.tenantId, tenant.id),
            eq(voteAllocations.voterRef, voterRef),
          ),
        )
        .limit(1),
      db
        .select({ id: voteResistances.id })
        .from(voteResistances)
        .where(
          and(
            eq(voteResistances.tenantId, tenant.id),
            eq(voteResistances.voterRef, voterRef),
          ),
        )
        .limit(1),
    ]);
    ersteTeilnahme =
      voteRows.length > 0 || allocRows.length > 0 || resistRows.length > 0;
  }

  const alleErledigt =
    wohnortGesetzt && verifiziert && benachrichtigungAn && ersteTeilnahme;

  return { wohnortGesetzt, verifiziert, benachrichtigungAn, ersteTeilnahme, alleErledigt };
}

/**
 * Der EINE als Nächstes empfohlene Schritt — reine, testbare Funktion.
 *
 * Priorität bewusst in dieser Reihenfolge: Wohnort zuerst (erweitert sofort
 * die Sicht auf Ortsteil-Fragen), dann Verifizierung (verbindliche Stimme),
 * dann Benachrichtigung (nur falls abbestellt), zuletzt die erste Teilnahme.
 * Alles erledigt → null (kein Nudge, Anti-Empörungs-Linie: keine Dauerpräsenz).
 */
export function naechsterSchritt(status: EinrichtungsStatus): EinrichtungsSchritt | null {
  if (!status.wohnortGesetzt) return "wohnort";
  if (!status.verifiziert) return "verifizierung";
  if (!status.benachrichtigungAn) return "benachrichtigung";
  if (!status.ersteTeilnahme) return "teilnahme";
  return null;
}
