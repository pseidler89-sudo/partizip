/**
 * delete.ts — Kern-Logik der Konto-Löschung (H3 DSGVO, Art. 17).
 *
 * Bewusst KEIN "use server": dieses Modul enthält die testbare Kern-Logik
 * (deleteKontoCore, isLetzterAdmin) und die Konstante KONTO_LOESCHEN_BESTAETIGUNG.
 * Die dünne Server-Action liegt in actions.ts und ruft hier hinein.
 *
 * Tenant-scoped + user-scoped in jeder Query. Anliegen bleiben erhalten
 * (Pseudonymität via creator_ref). Audit ist PII-frei.
 */

import { and, eq, or, inArray, isNull, ne, count, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  users,
  roles,
  sessions,
  authTokens,
  anliegenFollowers,
  auditEvents,
  qrRedemptions,
  verificationBookings,
  verificationSlots,
  invitations,
  roleAppointments,
} from "@/db/schema";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { normalizeEmail } from "@/lib/auth/email";
import { buildAnonymizePayload, buildTombstoneEmail } from "@/lib/konto/anonymize";
import { KONTO_LOESCHEN_BESTAETIGUNG } from "@/lib/konto/constants";

export { KONTO_LOESCHEN_BESTAETIGUNG };

/**
 * Prüft, ob der User der letzte Admin (kommune_admin/super_admin) des Tenants
 * ist. Einfache Zählung: gibt es im Tenant noch einen ANDEREN User mit
 * Admin-Rolle? Wenn nicht UND der zu löschende User selbst Admin ist → letzter
 * Admin → Löschung verweigern (verhindert verwaisten Tenant).
 */
export async function isLetzterAdmin(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  // Ist der zu löschende User überhaupt Admin?
  const ownAdminRows = await db
    .select({ userId: roles.userId })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        eq(roles.userId, userId),
        inArray(roles.roleType, [...ADMIN_ROLES]),
      ),
    )
    .limit(1);
  if (ownAdminRows.length === 0) return false; // kein Admin → nie „letzter Admin"

  // Gibt es noch einen ANDEREN AKTIVEN Admin im Tenant? (Audit m2: gesperrte/
  // gelöschte Konten sind nicht handlungsfähig und dürfen den Schutz nicht
  // aushebeln.)
  const otherAdminRows = await db
    .select({ n: count() })
    .from(roles)
    .innerJoin(users, eq(users.id, roles.userId))
    .where(
      and(
        eq(roles.tenantId, tenantId),
        ne(roles.userId, userId),
        inArray(roles.roleType, [...ADMIN_ROLES]),
        eq(users.accountStatus, "active"),
      ),
    );
  const otherAdminCount = otherAdminRows[0]?.n ?? 0;
  return otherAdminCount === 0;
}

/**
 * Kern-Logik der Löschung — ohne Session/Cookie, damit sie unter Test
 * (Integrationstest mit echter DB) direkt aufrufbar ist.
 *
 * Schritte (alle in EINER Transaktion):
 *   1. users-Zeile anonymisieren (Zeile bleibt — referenzielle Integrität).
 *   2. roles des Users löschen.
 *   3. anliegen_followers des Users löschen.
 *   4. alle Sessions des Users revoken.
 *   5. offene auth_tokens des Users löschen (per alter E-Mail).
 *   6. Anliegen NICHT löschen (creator_ref bleibt pseudonym).
 *   7. Audit konto.deleted (PII-frei).
 */
export async function deleteKontoCore(
  db: Db,
  tenantId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; error?: string }> {
  // Gesamte Löschung in EINER Transaktion. Ein per-Tenant Advisory-Lock
  // serialisiert nebenläufige Konto-Löschungen DESSELBEN Tenants — sonst könnten
  // zwei „vorletzte" Admins gleichzeitig löschen, beide den jeweils anderen noch
  // als Admin sehen und den Tenant verwaisen lassen (Gate-B MAJOR-E).
  return await db.transaction(async (tx: Db) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);

    // Letzter-Admin-Guard INNERHALB der gesperrten Transaktion (race-frei).
    if (await isLetzterAdmin(tx, tenantId, userId)) {
      return {
        ok: false as const,
        error:
          "Sie sind die einzige Administratorin oder der einzige Administrator " +
          "dieser Kommune. Bitte übertragen Sie die Administration zuerst an eine " +
          "andere Person, bevor Sie Ihr Konto löschen.",
      };
    }

    // Alte E-Mail VOR der Anonymisierung lesen (für auth_tokens-Cleanup).
    const userRows = await tx
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    const userRow = userRows[0];
    if (!userRow) {
      return { ok: false as const, error: "Benutzer nicht gefunden." };
    }
    // J2a: users.email ist kanonisch gespeichert; normalizeEmail hier defensiv
    // (idempotent) — die eine normalisierte Form deckt auth_tokens- UND
    // invitations-Löschung ab (beide kanonisch gespeichert).
    const alteEmail = normalizeEmail(userRow.email);

    const payload = buildAnonymizePayload(userId, now);

    // 1. users-Zeile anonymisieren (tenant + user scoped).
    await tx
      .update(users)
      .set(payload)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));

    // 2. roles des Users löschen (kein Admin-Recht behalten).
    await tx
      .delete(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, userId)));

    // 2b. pending role_appointments des Users canceln (Gate-B K3): Die
    //     Produkt-Löschung ist eine ANONYMISIERUNG (users-Zeile bleibt) — der
    //     CASCADE-FK auf target_user_id feuert hier also NIE. Ohne dieses
    //     Cancel bliebe ein offener Ernennungs-Vorschlag als Datenleiche mit
    //     Tombstone-E-Mail in der Admin-Liste hängen. Auditiert je Vorschlag
    //     (PII-frei, via=account_deletion).
    const stornierteVorschlaege = await tx
      .update(roleAppointments)
      .set({ status: "cancelled", decidedBy: userId, decidedAt: now })
      .where(
        and(
          eq(roleAppointments.tenantId, tenantId),
          eq(roleAppointments.targetUserId, userId),
          eq(roleAppointments.status, "pending"),
        ),
      )
      .returning({
        id: roleAppointments.id,
        roleType: roleAppointments.roleType,
        regionId: roleAppointments.regionId,
      });
    for (const appt of stornierteVorschlaege) {
      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "user",
        actorRef: userId,
        action: "role.appointment_cancelled",
        targetType: "user",
        targetId: userId,
        metadata: {
          appointmentId: appt.id,
          roleType: appt.roleType,
          regionId: appt.regionId,
          via: "account_deletion",
        },
      });
    }

    // 3. anliegen_followers des Users löschen. anliegen_followers hat KEINE
    //    tenantId-Spalte; userId ist global eindeutig und gehört genau einem
    //    Tenant — der user-scoped Delete ist daher korrekt und tenant-sicher.
    await tx.delete(anliegenFollowers).where(eq(anliegenFollowers.userId, userId));

    // 4. alle Sessions des Users revoken (tenant-scoped).
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      );

    // 5. offene auth_tokens des Users löschen (per alter E-Mail, tenant-scoped).
    //    Block J2b: auth_tokens trägt seit 0034 einen user_id-FK (ON DELETE
    //    CASCADE) — er greift aber nur bei einem echten users-DELETE. Die
    //    Produkt-Löschung ANONYMISIERT die users-Zeile (kein DELETE), daher
    //    feuert die Kaskade hier NICHT; dieser E-Mail-basierte Delete bleibt der
    //    maßgebliche Cleanup. Er deckt Login- UND email_change-Tokens der alten
    //    Adresse ab; ein noch offenes email_change-Token mit ABWEICHENDER Ziel-
    //    E-Mail wird zusätzlich über den user_id-Zweig unten aufgeräumt.
    await tx
      .delete(authTokens)
      .where(
        and(
          eq(authTokens.tenantId, tenantId),
          or(eq(authTokens.email, alteEmail), eq(authTokens.userId, userId)),
        ),
      );

    // 5b. qr_redemptions des Users löschen (direkter user_id-FK → sonst nach der
    //     Anonymisierung re-identifizierbar; Art. 17). tenant+user-scoped. Der
    //     QR-Cap (redemption_count) bleibt unberührt — eine bereits erfolgte
    //     Verifizierung wird nicht „zurückgegeben", nur die personenbezogene Spur.
    await tx
      .delete(qrRedemptions)
      .where(and(eq(qrRedemptions.tenantId, tenantId), eq(qrRedemptions.userId, userId)));

    // 5c. verification_bookings des Users löschen (Audit M4). Der user_id-FK
    //     trägt onDelete:cascade, aber die users-Zeile wird nur ANONYMISIERT
    //     (nie gelöscht) → die Kaskade feuert nie, und ein Termin mit Ort/Zeit/
    //     user_id bliebe nach der Anonymisierung re-identifizierbar (Art. 17).
    //     DELETE ... RETURNING statt SELECT-dann-DELETE: der DELETE lockt die
    //     Zeile, sodass eine nebenläufig committete Selbst-Stornierung als
    //     'storniert' zurückkommt und NICHT ein zweites Mal dekrementiert wird
    //     (Gate-B: booked_count-Doppel-Dekrement-Race). Nur für tatsächlich
    //     'gebucht' gelöschte Termine die Slot-Kapazität freigeben.
    const geloeschteTermine = await tx
      .delete(verificationBookings)
      .where(
        and(
          eq(verificationBookings.tenantId, tenantId),
          eq(verificationBookings.userId, userId),
        ),
      )
      .returning({
        slotId: verificationBookings.slotId,
        status: verificationBookings.status,
      });
    for (const t of geloeschteTermine) {
      if (t.status !== "gebucht") continue;
      await tx
        .update(verificationSlots)
        .set({ bookedCount: sql`GREATEST(${verificationSlots.bookedCount} - 1, 0)` })
        .where(eq(verificationSlots.id, t.slotId));
    }

    // 5d. invitations: die eingeladene Klartext-E-Mail ist PII und überlebt die
    //     Anonymisierung (Audit M5) — sie ist über accepted_by=userId bzw.
    //     email=alteEmail trivial rückführbar. Tombstone setzen + accepted_by
    //     nullen; die PII-freie Historie (Rolle/Region/Status) bleibt erhalten.
    //     invitations.email UND users.email sind seit J2a kanonisch (trim+
    //     lowercase) gespeichert → alteEmail (oben normalisiert) trifft auch
    //     eine ehemals Mixed-Case-pending-Einladung (Gate-B MAJOR bleibt gedeckt).
    await tx
      .update(invitations)
      .set({ email: buildTombstoneEmail(userId), acceptedBy: null })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          or(
            eq(invitations.email, alteEmail),
            eq(invitations.acceptedBy, userId),
          ),
        ),
      );

    // 6. Anliegen werden NICHT gelöscht (pseudonymer Vorgang bleibt).

    // 7. Audit (PII-frei: actorRef=userId, metadata minimal).
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: userId,
      action: "konto.deleted",
      targetType: "user",
      targetId: userId,
      metadata: { tenantId },
    });

    return { ok: true as const };
  });
}
