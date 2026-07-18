/**
 * queries.ts — Lese-Query für das öffentliche KI-Neutralitäts-Transparenz-Log (L4).
 *
 * BEWUSST OHNE "use server" (Muster: polls/queries.ts): reine, tenant-scoped
 * Lese-Funktion. Sie selektiert AUSSCHLIESSLICH die öffentlich freizugebenden
 * Felder — insbesondere NICHT `geprueft_von` (welcher Betreiber) und nichts über
 * den Ersteller. Institutionsebene, keine Person (PII-frei).
 */

import { eq, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kiPruefungen, polls } from "@/db/schema";

export interface KiPruefungPublicItem {
  id: string;
  /** Die (öffentliche) Umfrage-Frage — join auf polls. */
  frage: string;
  verdict: "neutral" | "angehalten";
  begruendung: string;
  /** Nur bei 'angehalten' gesetzt. */
  verletzteRegel: string | null;
  promptVersion: string;
  modell: string;
  createdAt: Date;
}

/**
 * Die letzten `limit` Neutralitätsprüfungen dieses Tenants, neu→alt. Tenant-scoped
 * (kein Cross-Tenant-Leak). PII-FREI: KEIN geprueft_von/erstellt_von im SELECT.
 */
export async function getKiPruefungenPublic(
  db: Db,
  tenantId: string,
  limit = 50,
): Promise<KiPruefungPublicItem[]> {
  const rows = await db
    .select({
      id: kiPruefungen.id,
      frage: polls.frage,
      verdict: kiPruefungen.verdict,
      begruendung: kiPruefungen.begruendung,
      verletzteRegel: kiPruefungen.verletzteRegel,
      promptVersion: kiPruefungen.promptVersion,
      modell: kiPruefungen.modell,
      createdAt: kiPruefungen.createdAt,
    })
    .from(kiPruefungen)
    .innerJoin(polls, eq(polls.id, kiPruefungen.pollId))
    .where(eq(kiPruefungen.tenantId, tenantId))
    .orderBy(desc(kiPruefungen.createdAt))
    .limit(limit);

  return rows.map((r: (typeof rows)[number]) => ({
    ...r,
    verdict: r.verdict as "neutral" | "angehalten",
  }));
}

export interface LetztePruefung {
  verdict: "neutral" | "angehalten";
  begruendung: string;
  verletzteRegel: string | null;
  createdAt: Date;
}

/**
 * Die JEWEILS NEUESTE Prüf-Zeile je Umfrage dieses Tenants (Map poll_id → Zeile),
 * für die ADMIN-Sicht: nach dem Anhalten sieht der Ersteller im entwurf-Zweig die
 * letzte Begründung. Tenant-scoped. Interne Sicht — dennoch OHNE geprueft_von
 * selektiert (wird hier nicht gebraucht; Datensparsamkeit). Reduktion in JS
 * (Menge je Tenant klein/gebunden an die Umfrage-Zahl).
 */
export async function getLetztePruefungProPoll(
  db: Db,
  tenantId: string,
): Promise<Map<string, LetztePruefung>> {
  const rows = await db
    .select({
      pollId: kiPruefungen.pollId,
      verdict: kiPruefungen.verdict,
      begruendung: kiPruefungen.begruendung,
      verletzteRegel: kiPruefungen.verletzteRegel,
      createdAt: kiPruefungen.createdAt,
    })
    .from(kiPruefungen)
    .where(eq(kiPruefungen.tenantId, tenantId))
    .orderBy(desc(kiPruefungen.createdAt));

  const map = new Map<string, LetztePruefung>();
  for (const r of rows as Array<{
    pollId: string;
    verdict: string;
    begruendung: string;
    verletzteRegel: string | null;
    createdAt: Date;
  }>) {
    // rows sind neu→alt sortiert → der ERSTE Treffer je pollId ist der neueste.
    if (map.has(r.pollId)) continue;
    map.set(r.pollId, {
      verdict: r.verdict as "neutral" | "angehalten",
      begruendung: r.begruendung,
      verletzteRegel: r.verletzteRegel,
      createdAt: r.createdAt,
    });
  }
  return map;
}
