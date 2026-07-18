/**
 * follower-recipients.ts — Empfänger der Anliegen-Status-Mails (M8, Block J2c).
 *
 * BEWUSST ohne "use server" (analog polls/notify.ts, region/tree.ts): reiner,
 * lesender DB-Helfer für die Server-Action changeAnliegenStatus — kein
 * client-aufrufbarer RPC-Endpunkt, dafür unit-testbar gegen PG16.
 *
 * Versandfilter (Block J2c, Teil A3): Ein Follower erhält die Status-Mail nur,
 * wenn er das Opt-out `notify_anliegen_updates` NICHT abbestellt hat. Zugleich
 * dieselbe Hygiene-Parität wie das notifyNewPolls-Muster (polls/notify.ts):
 * gelöschte/anonymisierte Tombstones und ephemere Demo-Adressen (RFC-2606) sind
 * ausgeschlossen — jeder Versand an sie wäre nur ein Bounce. (Der Demo-Mandant
 * ist zusätzlich durch den isDemoTenant-Fence in der Action davor geschützt; die
 * notLike-Zeile ist Defense-in-Depth.)
 */

import { and, eq, isNull, notLike } from "drizzle-orm";
import type { Db } from "@/db/client";
import { anliegenFollowers, users } from "@/db/schema";

/**
 * E-Mail-Adressen der Follower eines Anliegens, die Status-Mails empfangen
 * dürfen (Opt-in + aktive, zustellbare Adresse). Die Tenant-Isolation liefert
 * der Aufrufer über die anliegenId (bereits tenant-scoped geladen).
 */
export async function getAnliegenFollowerEmails(
  db: Db,
  anliegenId: string,
): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(anliegenFollowers)
    .innerJoin(users, eq(anliegenFollowers.userId, users.id))
    .where(
      and(
        eq(anliegenFollowers.anliegenId, anliegenId),
        // Block J2c: das Opt-out wirksam machen.
        eq(users.notifyAnliegenUpdates, true),
        // Hygiene-Parität zum notifyNewPolls-Muster (bisher fehlend):
        isNull(users.deletedAt),
        notLike(users.email, "%@deleted.invalid"),
        notLike(users.email, "%@demo.invalid"),
      ),
    );
  return rows.map((r: { email: string }) => r.email);
}
