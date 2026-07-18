/**
 * pii-cleanup.ts — Datenminimierung der öffentlichen Rollenträger-Identität
 * (Block J1, Gate-B-Fund 1a). Reine DB-Logik, KEIN "use server".
 *
 * Zweckbindung: Klarname (display_name) + Funktion existieren ausschließlich für
 * die ROLLENAUSÜBUNG. Verliert ein Konto seine letzte Rolle ≠ `user` (Entzug der
 * einzelnen Rolle ODER vollständiges Offboarding), entfällt die Zweckbindung →
 * die Identitäts-PII wird in DERSELBEN Transaktion serverseitig entfernt. Ein
 * Bestandsfall (herabgestufter Ex-Rollenträger, der seinen Namen sonst nicht mehr
 * selbst sieht) entsteht so gar nicht erst.
 *
 * Audit `profile.updated` PII-FREI: nur die geänderten FELDNAMEN + der Anlass
 * (`via`), NIE die Werte. Actor ist der handelnde Admin (actorType='admin').
 */

import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users, roles, auditEvents } from "@/db/schema";

/**
 * Entfernt display_name + funktion des Ziel-Users, WENN er im Tenant keine Rolle
 * ≠ `user` mehr hält UND überhaupt eine dieser PII-Angaben gesetzt ist. Muss
 * INNERHALB der aufrufenden Transaktion (tx) NACH dem Löschen/Entziehen der
 * Rolle laufen, damit der Rollen-Rest den Endzustand widerspiegelt.
 *
 * No-op (kein Audit), wenn der User weiterhin Rollenträger ist oder ohnehin keine
 * Identitäts-PII trägt — idempotent und ohne Rausch-Audit.
 *
 * @param via  Anlass für das Audit-metadata (z. B. "role_revoked", "offboarding").
 */
export async function identitaetPiiEntfernenWennKeinRollentraeger(
  tx: Db,
  tenantId: string,
  targetUserId: string,
  callerUserId: string,
  via: string,
): Promise<void> {
  // Aktuelle Identitäts-PII lesen (tenant-scoped). Nichts gesetzt → nichts zu tun.
  const rows = await tx
    .select({ displayName: users.displayName, funktion: users.funktion })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, targetUserId)))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  if (row.displayName === null && row.funktion === null) return;

  // Hält der User noch IRGENDEINE Rolle ≠ `user`? Dann bleibt die Zweckbindung
  // bestehen — PII behalten (fail-safe: lieber behalten als einem noch aktiven
  // Rollenträger den Namen wegnehmen).
  const restRolle = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        eq(roles.userId, targetUserId),
        ne(roles.roleType, "user"),
      ),
    )
    .limit(1);
  if (restRolle.length > 0) return;

  // Genau die tatsächlich gesetzten Felder als geändert protokollieren.
  const feldGeaendert: string[] = [];
  if (row.displayName !== null) feldGeaendert.push("display_name");
  if (row.funktion !== null) feldGeaendert.push("funktion");

  await tx
    .update(users)
    .set({ displayName: null, funktion: null })
    .where(and(eq(users.tenantId, tenantId), eq(users.id, targetUserId)));

  // Audit PII-frei: nur Feldnamen + Anlass, actor = handelnder Admin.
  await tx.insert(auditEvents).values({
    tenantId,
    actorType: "admin",
    actorRef: callerUserId,
    action: "profile.updated",
    targetType: "user",
    targetId: targetUserId,
    metadata: { feldGeaendert, via },
  });
}
