/**
 * beleg.ts — Beleg-Code für den receipt-freien Aufnahme-Beleg (D4, ADR-016).
 *
 * Pro Stimme ein zufälliger Code (Format BELEG-XXXX-XXXX). Er beweist DASS die
 * Stimme im Ergebnis enthalten ist (öffentliche Liste nach Poll-Ende), nie WIE.
 *
 * Sicherheits-/Datenschutz-Eigenschaften (siehe schema.ts vote_receipts):
 *   - CSPRNG: jede Stelle wird über node:crypto randomInt (kryptografisch sicher,
 *     verzerrungsfrei dank Rejection-Sampling) gezogen — nicht erratbar/aufzählbar.
 *   - Der Code trägt KEINE Information über Person oder Wahl (rein zufällig).
 *   - 8 Zeichen aus 32er-Alphabet = 40 Bit Entropie; in Kombination mit
 *     UNIQUE(poll_id, code) + Insert-Retry sind Kollisionen praktisch ausgeschlossen.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { polls, voteReceipts } from "@/db/schema";
import { generateReadableCode, readableCodePattern } from "@/lib/readable-code";

export const BELEG_PREFIX = "BELEG";

/** Format-Prüfung: BELEG-XXXX-XXXX mit gültigem Alphabet. Für Tests/Validierung. */
export const BELEG_PATTERN = readableCodePattern(BELEG_PREFIX);

/**
 * Erzeugt einen neuen Beleg-Code (z. B. "BELEG-7F3A-K29Q"). Reine Funktion ohne
 * DB — die Eindeutigkeit je Umfrage stellt insertBelegCode über die UNIQUE-
 * Bedingung sicher. Format/Entropie liegen zentral in @/lib/readable-code.
 */
export function generateBelegCode(): string {
  return generateReadableCode(BELEG_PREFIX);
}

/**
 * Fügt EINEN Beleg-Code für eine Stimme ein und gibt ihn zurück. MUSS in
 * derselben Transaktion wie der votes-Insert laufen (Invariante #Belege == #Stimmen).
 *
 * Kollisionssicher: onConflictDoNothing liefert bei einer (extrem seltenen)
 * Code-Kollision 0 Zeilen, OHNE die Transaktion abzubrechen — wir ziehen einen
 * neuen Code und versuchen es erneut. Bei 40 Bit Entropie je Code ist das ein
 * reines Sicherheitsnetz; im Pilotmaßstab feuert der Retry praktisch nie.
 *
 * Fail-closed: bricht selbst nach mehreren Versuchen alles fehl (oder tritt ein
 * anderer DB-Fehler auf), wirft die Funktion. Da sie in DERSELBEN Transaktion wie
 * der votes-Insert läuft, rollt die ganze Stimme zurück — es entsteht KEINE Stimme
 * ohne Beleg (Invariante #Belege == #Stimmen bleibt gewahrt). Dem Bürger zeigt der
 * Client dann einen generischen Fehler; die Stimme ist nicht gezählt, er stimmt
 * erneut ab. Das ist gewollt (lieber keine Stimme als eine ohne Aufnahme-Beleg).
 */
export async function insertBelegCode(
  tx: Db,
  tenantId: string,
  pollId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateBelegCode();
    const inserted = await tx
      .insert(voteReceipts)
      .values({ pollId, tenantId, code })
      .onConflictDoNothing({ target: [voteReceipts.pollId, voteReceipts.code] })
      .returning({ id: voteReceipts.id });
    if (inserted.length > 0) return code;
  }
  throw new Error("Beleg-Code konnte nicht kollisionsfrei erzeugt werden.");
}

/**
 * Liefert die anonyme, sortierte Liste aller Beleg-Codes einer GESCHLOSSENEN
 * Umfrage (tenant-scoped). null, wenn die Umfrage nicht existiert/nicht zum
 * Tenant gehört ODER noch nicht geschlossen ist (vor Poll-Ende kein Beleg-Leak).
 *
 * Sortierung NACH CODE (nicht Insert-Reihenfolge) — die Liste verrät damit keine
 * zeitliche Abgabe-Reihenfolge. Da die Tabelle weder Person noch Wahl kennt,
 * bleibt die Liste ein reines „diese Belege sind im Ergebnis enthalten".
 *
 * Bewusst OHNE "use server" (reine Lese-Query, nur Server-Component-Nutzung) —
 * analog der übrigen polls/queries.
 */
export async function getBelegListe(
  db: Db,
  tenantId: string,
  pollId: string,
): Promise<string[] | null> {
  const pollRows = await db
    .select({ status: polls.status, closesAt: polls.closesAt })
    .from(polls)
    .where(and(eq(polls.id, pollId), eq(polls.tenantId, tenantId)))
    .limit(1);
  const poll = pollRows[0];
  // Belege sind prüfbar, sobald die ABSTIMMUNG BEENDET ist — entweder hart
  // geschlossen (status) ODER die Schlusszeit ist erreicht (closesAt<=now, analog
  // zur Stimm-Schlusslogik in abstimmen). Reiner JS-Vergleich, kein Date in Roh-SQL.
  const beendet =
    !!poll &&
    poll.status !== "entwurf" && // Entwürfe sind nie öffentlich (Defense-in-Depth)
    (poll.status === "geschlossen" ||
      (poll.closesAt != null && poll.closesAt <= new Date()));
  if (!beendet) return null;

  const rows = await db
    .select({ code: voteReceipts.code })
    .from(voteReceipts)
    .where(and(eq(voteReceipts.pollId, pollId), eq(voteReceipts.tenantId, tenantId)))
    .orderBy(asc(voteReceipts.code));
  return rows.map((r: { code: string }) => r.code);
}
