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
import { kiPruefungen } from "@/db/schema";

export interface KiPruefungPublicItem {
  id: string;
  /**
   * Der Frage-Wortlaut zum Prüfzeitpunkt (frage_snapshot) — NUR bei verdict='neutral'
   * gesetzt (die Umfrage wurde ohnehin öffentlich). Bei 'angehalten' bewusst `null`:
   * die Frage blieb entwurf/nie öffentlich; das Transparenz-Log darf einen evtl.
   * problematischen (diffamierenden/Dritte nennenden) Wortlaut nicht doch publik machen.
   */
  frage: string | null;
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
 *
 * KEIN polls-Join (mehr): der Wortlaut steckt im frage_snapshot der Prüf-Zeile —
 * das Log überlebt eine Poll-Löschung (Manipulationssicherheit) und der Tenant-Filter
 * greift direkt (Defense-in-Depth, kein zweites eq(polls.tenantId) nötig). Bei
 * verdict='angehalten' wird die Frage NICHT ausgegeben (Redaktion, siehe interface).
 */
export async function getKiPruefungenPublic(
  db: Db,
  tenantId: string,
  limit = 50,
): Promise<KiPruefungPublicItem[]> {
  const rows = await db
    .select({
      id: kiPruefungen.id,
      frageSnapshot: kiPruefungen.frageSnapshot,
      verdict: kiPruefungen.verdict,
      begruendung: kiPruefungen.begruendung,
      verletzteRegel: kiPruefungen.verletzteRegel,
      promptVersion: kiPruefungen.promptVersion,
      modell: kiPruefungen.modell,
      createdAt: kiPruefungen.createdAt,
    })
    .from(kiPruefungen)
    .where(eq(kiPruefungen.tenantId, tenantId))
    .orderBy(desc(kiPruefungen.createdAt))
    .limit(limit);

  return rows.map((r: (typeof rows)[number]) => {
    const { frageSnapshot, ...rest } = r;
    const verdict = rest.verdict as "neutral" | "angehalten";
    return {
      ...rest,
      verdict,
      // Redaktion: angehaltene Frage NIE öffentlich (nur neutral zeigt den Wortlaut).
      frage: verdict === "neutral" ? frageSnapshot : null,
    };
  });
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
