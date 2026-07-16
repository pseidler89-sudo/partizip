/**
 * gebiet.ts — Gebiets-Zuständigkeit fürs Abstimmen (Audit M2, ADR-024).
 *
 * Die Lese-Sicht (queries.getAktivePolls) blendet Fragen außerhalb des eigenen
 * Gebiets aus — aber `abstimmen()` prüfte das NICHT. Ein in Ortsteil A
 * verifizierter Bürger konnte per Detail-URL/Direktaufruf bei einer (auch
 * verbindlichen) Ortsteil-B-Abstimmung mitstimmen. Diese Funktion schließt das:
 *
 * Regel: Die Region der Frage muss VORFAHRE-ODER-SELBST des Zuständigkeits-Ankers
 * des Nutzers sein (`poll.path @> anker.path`). Damit gilt:
 *   - Frage auf Gemeinde/Kreis/Land/Bund → jeder Bürger dieses Gebiets darf.
 *   - Frage auf Ortsteil X → nur, wer in X (oder darunter) wohnt; Nachbar-
 *     ortsteile sind ausgeschlossen (poll(X) ist nicht Vorfahre von Ortsteil Y).
 *
 * Zuständigkeits-Anker:
 *   - verbindliche Frage → NUR der HARTE verifizierte Wohnsitz (residency_region_id).
 *     KEIN home-Fallback: home_region_id ist von jedem Stufe-1-Konto frei auf jeden
 *     Ortsteil des Tenants setzbar (ortsteilSetzen prüft nur Tenant-Zugehörigkeit)
 *     — würde man darauf zurückfallen, könnte ein Verifizierter ohne residency-Anker
 *     per selbst-gesetztem home in einer FREMDEN Ortsteil-Abstimmung mitstimmen
 *     (Gate-B MAJOR, wäre die M2-Lücke über den Fallback). Fehlt residency → null →
 *     Gemeinde-Fallback: verbindliche Gemeinde-/Kreis-Fragen bleiben wählbar,
 *     verbindliche ORTSTEIL-Fragen verlangen einen echten Anker (fail-closed).
 *   - unverbindliche Frage → home_region_id (weich), ersatzweise residency. Weiche
 *     Stimmungsbilder sind bewusst so gebietsscharf wie die Lese-Sicht (auch home).
 *   - fehlt der Anker → Gemeinde-Knoten des Tenants (nicht-verorteter Nutzer darf
 *     Gemeinde/Kreis/Land, aber KEINE Ortsteil-Fragen — spec-konform).
 *
 * Ein bewusst GROBER Anker (Kreis/Land-QR) schränkt fail-closed ein: für eine
 * feinere Gemeinde-/Ortsteil-Frage ist poll.path NICHT Vorfahre des groben
 * Ankers → nicht stimmberechtigt. Das ist die sichere Richtung (wir kennen die
 * genaue Gemeinde des grob Verifizierten nicht). Grobe Residency-QRs sind atypisch.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";

/** Anker-Knoten je nach Verbindlichkeit auswählen (kann null sein → Fallback). */
export function waehleAnkerRegionId(
  user: { residencyRegionId: string | null; homeRegionId: string | null },
  verbindlich: boolean,
): string | null {
  return verbindlich
    ? user.residencyRegionId ?? null // KEIN home-Fallback (Gate-B MAJOR, s. o.)
    : user.homeRegionId ?? user.residencyRegionId ?? null;
}

/**
 * Ist der Nutzer für die (tenant-scoped bereits geladene) Frage gebietszuständig?
 * pollRegionId = polls.region_id. ankerRegionId = Ergebnis von waehleAnkerRegionId.
 */
export async function istGebietsZustaendig(
  db: Db,
  tenantId: string,
  pollRegionId: string,
  ankerRegionId: string | null,
): Promise<boolean> {
  const rows = (await db.execute(
    sql`
      WITH anker AS (
        SELECT COALESCE(
          (SELECT path FROM regions WHERE id = ${ankerRegionId}::uuid),
          (SELECT g.path FROM regions g
             WHERE g.typ = 'gemeinde' AND g.tenant_id = ${tenantId}::uuid
             ORDER BY g.created_at LIMIT 1)
        ) AS path
      )
      SELECT EXISTS (
        SELECT 1
        FROM regions pr, anker
        WHERE pr.id = ${pollRegionId}::uuid
          AND anker.path IS NOT NULL
          AND pr.path @> anker.path
      ) AS ok
    `,
  )) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}
