/**
 * konto-sicherheit-core.ts — Konto-Sicherheit: Sperren/Entsperren, Sitzungen
 * beenden, Offboarding (Block K2, IR-Playbook §8/§9). Reine DB-Logik.
 *
 * Schließt die Audit-Lücke: `account_status` wird überall durchgesetzt, aber es
 * gab bislang KEINE Admin-Aktion zum Sperren und kein „alle Sitzungen beenden".
 * Offboarding (Spec §9) = alle Rollen weg + alle Sitzungen weg als EINE Aktion —
 * das Konto bleibt dabei AKTIV (der/die Ex-Rollenträger:in ist weiterhin
 * Bürger:in!). Sperren (IR-Eskalation) ist davon getrennt und beendet
 * zusätzlich die Sitzungen.
 *
 * BEWUSST OHNE "use server" und ohne Request-Kontext (Muster role-actions/
 * invitation-core/standort-core): alle Funktionen nehmen db/tenantId/Caller als
 * PARAMETER — dadurch von den "use server"-Actions wiederverwendbar UND in
 * DB-Integrationstests als ECHTE Funktionen aufrufbar (keine gespiegelte Logik).
 *
 * SICHERHEITS-INVARIANTEN (Vertrauensprodukt):
 *   - Tenant-Isolation in JEDER Query (tenant_id immer im WHERE).
 *   - KEIN Selbst-Ziel: Ein Admin kann keine dieser Aktionen auf sein eigenes
 *     Konto anwenden (kein Selbst-Aussperren, kein Selbst-Offboarding).
 *   - Gelöschte Konten (account_status='deleted') werden NIE angefasst.
 *   - ESKALATIONSGRENZE über die ZIEL-Rollen: existiert am Ziel eine Rolle, die
 *     der Caller nicht verwalten darf (canManageRole), wird die GESAMTE Aktion
 *     verweigert — ein kommune_admin kann damit nie einen super_admin/
 *     Reserve-Träger sperren/offboarden oder dessen Sitzungen beenden.
 *     WICHTIG: die Ziel-Rollen werden DIREKT aus `roles` gelesen (NICHT über
 *     getUserRoleTypes, das nach account_status='active' filtert) — sonst
 *     könnte ein kommune_admin einen GESPERRTEN super_admin entsperren.
 *   - LETZTER-AKTIVER-ADMIN (Sperren/Offboarding, race-frei via
 *     pg_advisory_xact_lock): trägt das Ziel eine Admin-Rolle, muss ein ANDERER
 *     User mit Admin-Rolle und account_status='active' übrig bleiben. Der
 *     CALLER zählt dabei als „anderer aktiver Admin" (er ist handlungsfähig) —
 *     Sperren des einzigen ANDEREN Admins ist also erlaubt, solange der Caller
 *     selbst aktiv Admin ist. Da das Selbst-Ziel-Verbot den Fall „Caller sperrt
 *     sich selbst" bereits ausschließt, ist dieser Guard TIEFENVERTEIDIGUNG für
 *     Konstellationen, in denen der Caller nicht (mehr) als aktiver Admin in
 *     der DB steht (gesperrtes Caller-Konto bei noch gültiger Session, Races).
 *   - Atomare bedingte UPDATEs mit RETURNING (kein TOCTOU): Sperren nur aus
 *     'active', Entsperren nur aus 'locked'.
 *   - KEIN JS-Date in Roh-`sql` — revoked_at wird per DB-now() gesetzt.
 *   - Audit PII-frei: actorRef = Caller-UUID, targetId = Ziel-UserId,
 *     metadata enthält NIEMALS eine E-Mail.
 */

import { and, count, eq, isNull, ne, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users, roles, sessions, auditEvents } from "@/db/schema";
import { ADMIN_ROLES, canManageRole, isAdmin } from "@/lib/auth/roles";

/** Einheitliches, serialisierbares Ergebnis aller Konto-Sicherheits-Aktionen. */
export type KontoSicherheitResult = { ok: boolean; error?: string; message?: string };

// ---------------------------------------------------------------------------
// Interne Guards (gemeinsam für alle vier Aktionen)
// ---------------------------------------------------------------------------

interface ZielKontext {
  ziel: { id: string; accountStatus: string };
  /** ALLE Rollen des Ziels im Tenant — bewusst UNGEFILTERT nach account_status. */
  zielRollen: { id: string; roleType: string }[];
}

/**
 * Lädt das Ziel-Konto tenant-scoped und prüft die gemeinsamen Guards:
 * Selbst-Ziel, Existenz, gelöscht, Eskalationsgrenze über die Ziel-Rollen.
 * Läuft INNERHALB der jeweiligen Transaktion (konsistent zum advisory lock).
 */
async function ladeZielMitGuards(
  tx: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  targetUserId: string,
): Promise<{ ok: true; ctx: ZielKontext } | { ok: false; error: string }> {
  // KEIN Selbst-Ziel — ein Admin sperrt/offboardet sich nicht selbst und beendet
  // nicht die eigene Sitzung über diesen Weg (dafür gibt es Logout).
  if (targetUserId === callerUserId) {
    return {
      ok: false,
      error: "Sie können diese Aktion nicht auf Ihr eigenes Konto anwenden.",
    };
  }

  // Ziel tenant-scoped laden — fremde Tenants sehen generisch „nicht gefunden".
  const zielRows = await tx
    .select({ id: users.id, accountStatus: users.accountStatus })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, targetUserId)))
    .limit(1);
  const ziel = zielRows[0];
  if (!ziel) {
    return { ok: false, error: "Konto nicht gefunden." };
  }

  // Gelöschte Konten (DSGVO-anonymisiert) werden NIE angefasst.
  if (ziel.accountStatus === "deleted") {
    return { ok: false, error: "Dieses Konto wurde gelöscht." };
  }

  // ESKALATIONSGRENZE über die ZIEL-Rollen (ALL-OR-NOTHING): eine einzige nicht
  // verwaltbare Rolle am Ziel ⇒ komplette Verweigerung. Direkt aus `roles`
  // gelesen (ungefiltert!), damit auch die Rollen eines GESPERRTEN Ziels zählen.
  // Ein Ziel ohne Rollen ist einfache:r Bürger:in ⇒ erlaubt.
  const zielRollen = await tx
    .select({ id: roles.id, roleType: roles.roleType })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, targetUserId)));
  for (const r of zielRollen) {
    if (!canManageRole(callerRoleTypes, r.roleType)) {
      return { ok: false, error: "Keine Berechtigung für dieses Konto." };
    }
  }

  return { ok: true, ctx: { ziel, zielRollen } };
}

/**
 * Revoziert alle AKTIVEN Sitzungen des Ziels (tenant-scoped) und liefert die
 * Anzahl. revoked_at per DB-now() (kein JS-Date in Roh-SQL); bereits revozierte
 * Zeilen bleiben unangetastet (revoked_at IS NULL im WHERE — idempotent).
 */
async function revokeAktiveSessions(
  tx: Db,
  tenantId: string,
  targetUserId: string,
): Promise<number> {
  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.userId, targetUserId),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * LETZTER-AKTIVER-ADMIN-Guard: existiert im Tenant ein ANDERER User (≠ Ziel)
 * mit Admin-Rolle und account_status='active'? Muster revokeRoleCore Schritt 3;
 * hier über userId ausgeschlossen (das Ziel verliert beim Offboarding ALLE
 * Rollen bzw. wird beim Sperren komplett handlungsunfähig).
 */
async function hatAnderenAktivenAdmin(
  tx: Db,
  tenantId: string,
  targetUserId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ n: count() })
    .from(roles)
    .innerJoin(users, eq(users.id, roles.userId))
    .where(
      and(
        eq(roles.tenantId, tenantId),
        ne(roles.userId, targetUserId),
        inArray(roles.roleType, [...ADMIN_ROLES]),
        eq(users.accountStatus, "active"),
      ),
    );
  return (rows[0]?.n ?? 0) > 0;
}

function hatAdminRolle(zielRollen: { roleType: string }[]): boolean {
  return zielRollen.some((r) => (ADMIN_ROLES as readonly string[]).includes(r.roleType));
}

function sitzungenText(anzahl: number): string {
  return anzahl === 1 ? "1 aktive Sitzung beendet" : `${anzahl} aktive Sitzungen beendet`;
}

// ---------------------------------------------------------------------------
// sessionsBeendenCore — alle aktiven Sitzungen eines Kontos beenden (IR §8)
// ---------------------------------------------------------------------------

/**
 * Beendet alle aktiven Sitzungen des Ziel-Kontos (tenant-scoped, auditiert).
 * Auch bei 0 aktiven Sitzungen ok:true — die Message nennt die Anzahl.
 * Der Konto-Status bleibt UNVERÄNDERT (fürs Sperren gibt es kontoSperrenCore).
 */
export async function sessionsBeendenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  targetUserId: string,
): Promise<KontoSicherheitResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  return await db.transaction(async (tx: Db) => {
    const guard = await ladeZielMitGuards(tx, tenantId, callerRoleTypes, callerUserId, targetUserId);
    if (!guard.ok) return { ok: false as const, error: guard.error };

    const anzahl = await revokeAktiveSessions(tx, tenantId, targetUserId);

    // Audit PII-frei: nur die Anzahl, nie E-Mail.
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "account.sessions_revoked",
      targetType: "user",
      targetId: targetUserId,
      metadata: { anzahl },
    });

    return { ok: true as const, message: `${sitzungenText(anzahl)}.` };
  });
}

// ---------------------------------------------------------------------------
// kontoSperrenCore — Konto sperren + alle Sitzungen beenden (IR-Eskalation)
// ---------------------------------------------------------------------------

/**
 * Sperrt ein aktives Konto (account_status active→locked, atomar) und beendet
 * IN DERSELBEN Transaktion alle aktiven Sitzungen. Rollen bleiben bestehen —
 * sie sind über getUserRoleTypes (filtert auf active) sofort inert; die Sperre
 * ist per Entsperren umkehrbar.
 *
 * Race-frei: Letzter-Admin-Guard + Update + Session-Revoke + Audit in EINER
 * Transaktion, serialisiert per pg_advisory_xact_lock(hashtext(tenantId)) —
 * zwei parallele Sperren können den Tenant nicht gemeinsam admin-los machen.
 */
export async function kontoSperrenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  targetUserId: string,
): Promise<KontoSicherheitResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  return await db.transaction(async (tx: Db) => {
    // Per-Tenant-Lock (Muster revokeRoleCore): serialisiert Sperren/Offboarding/
    // Rollen-Entzug desselben Tenants gegen den Letzter-Admin-Guard.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);

    const guard = await ladeZielMitGuards(tx, tenantId, callerRoleTypes, callerUserId, targetUserId);
    if (!guard.ok) return { ok: false as const, error: guard.error };

    // LETZTER-AKTIVER-ADMIN: Tiefenverteidigung (s. Kopfkommentar) — trägt das
    // Ziel eine Admin-Rolle, muss ein anderer AKTIVER Admin übrig bleiben.
    if (hatAdminRolle(guard.ctx.zielRollen)) {
      if (!(await hatAnderenAktivenAdmin(tx, tenantId, targetUserId))) {
        return {
          ok: false as const,
          error:
            "Dieses Konto trägt die letzte aktive Administrator-Rolle dieser " +
            "Kommune und kann nicht gesperrt werden. Bitte zuerst eine andere " +
            "Person zur Administratorin oder zum Administrator ernennen.",
        };
      }
    }

    // Atomar: nur ein AKTIVES Konto lässt sich sperren (kein TOCTOU).
    const updated = await tx
      .update(users)
      .set({ accountStatus: "locked" })
      .where(
        and(
          eq(users.id, targetUserId),
          eq(users.tenantId, tenantId),
          eq(users.accountStatus, "active"),
        ),
      )
      .returning({ id: users.id });
    if (updated.length === 0) {
      return {
        ok: false as const,
        error: "Konto ist nicht aktiv (bereits gesperrt oder gelöscht).",
      };
    }

    // IN DERSELBEN Tx: alle aktiven Sitzungen beenden — die Sperre wirkt sofort,
    // nicht erst beim nächsten Rollen-Check.
    const sessionsBeendet = await revokeAktiveSessions(tx, tenantId, targetUserId);

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "account.locked",
      targetType: "user",
      targetId: targetUserId,
      metadata: { sessionsBeendet },
    });

    return { ok: true as const, message: `Konto gesperrt, ${sitzungenText(sessionsBeendet)}.` };
  });
}

// ---------------------------------------------------------------------------
// kontoEntsperrenCore — Sperre aufheben (locked→active)
// ---------------------------------------------------------------------------

/**
 * Entsperrt ein gesperrtes Konto (atomar locked→active). Die Eskalationsgrenze
 * gilt auch hier (ein kommune_admin kann keinen gesperrten super_admin
 * entsperren — Ziel-Rollen werden ungefiltert gelesen); ein Letzter-Admin-Thema
 * gibt es beim Entsperren nicht.
 */
export async function kontoEntsperrenCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  targetUserId: string,
): Promise<KontoSicherheitResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  return await db.transaction(async (tx: Db) => {
    const guard = await ladeZielMitGuards(tx, tenantId, callerRoleTypes, callerUserId, targetUserId);
    if (!guard.ok) return { ok: false as const, error: guard.error };

    // Atomar: nur ein GESPERRTES Konto lässt sich entsperren.
    const updated = await tx
      .update(users)
      .set({ accountStatus: "active" })
      .where(
        and(
          eq(users.id, targetUserId),
          eq(users.tenantId, tenantId),
          eq(users.accountStatus, "locked"),
        ),
      )
      .returning({ id: users.id });
    if (updated.length === 0) {
      return { ok: false as const, error: "Konto ist nicht gesperrt." };
    }

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "account.unlocked",
      targetType: "user",
      targetId: targetUserId,
      metadata: {},
    });

    return { ok: true as const, message: "Konto entsperrt." };
  });
}

// ---------------------------------------------------------------------------
// offboardingCore — alle Rollen + alle Sitzungen entfernen (Spec §9)
// ---------------------------------------------------------------------------

/**
 * Offboarding eines Rollenträgers: ALLE Rollen des Ziels löschen + alle aktiven
 * Sitzungen beenden — als EINE atomare Aktion (advisory-gelockte Transaktion).
 *
 * Der Konto-Status bleibt BEWUSST UNVERÄNDERT: der/die Ex-Rollenträger:in ist
 * weiterhin Bürger:in und kann sich normal anmelden und teilnehmen. Für den
 * IR-Fall (Konto komplett stilllegen) gibt es das getrennte Sperren.
 *
 * ALL-OR-NOTHING: eine einzige nicht verwaltbare Rolle am Ziel (Eskalations-
 * grenze) ⇒ komplette Verweigerung, KEIN Teil-Offboarding.
 */
export async function offboardingCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  targetUserId: string,
): Promise<KontoSicherheitResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  return await db.transaction(async (tx: Db) => {
    // Per-Tenant-Lock gegen den Letzter-Admin-Guard (wie Sperren/Rollen-Entzug).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);

    const guard = await ladeZielMitGuards(tx, tenantId, callerRoleTypes, callerUserId, targetUserId);
    if (!guard.ok) return { ok: false as const, error: guard.error };
    const { zielRollen } = guard.ctx;

    // Ohne Rollen gibt es nichts zu offboarden. Die Sitzungen werden BEWUSST
    // nicht angefasst — dafür gibt es die eigene Aktion „Sitzungen beenden".
    if (zielRollen.length === 0) {
      return { ok: false as const, error: "Dieses Konto hat keine Rollen." };
    }

    // LETZTER-AKTIVER-ADMIN — wie beim Sperren (Tiefenverteidigung, s. o.).
    if (hatAdminRolle(zielRollen)) {
      if (!(await hatAnderenAktivenAdmin(tx, tenantId, targetUserId))) {
        return {
          ok: false as const,
          error:
            "Dieses Konto trägt die letzte aktive Administrator-Rolle dieser " +
            "Kommune und kann nicht offgeboardet werden. Bitte zuerst eine " +
            "andere Person zur Administratorin oder zum Administrator ernennen.",
        };
      }
    }

    // ALLE Rollen des Ziels löschen (tenant-scoped) + Sitzungen beenden.
    await tx
      .delete(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.userId, targetUserId)));
    const sessionsBeendet = await revokeAktiveSessions(tx, tenantId, targetUserId);

    const roleTypes = zielRollen.map((r) => r.roleType);
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "admin",
      actorRef: callerUserId,
      action: "account.offboarded",
      targetType: "user",
      targetId: targetUserId,
      metadata: { roleTypes, sessionsBeendet },
    });

    return {
      ok: true as const,
      message:
        `Offboarding abgeschlossen: ${roleTypes.length} Rolle${roleTypes.length === 1 ? "" : "n"} ` +
        `entfernt, ${sitzungenText(sessionsBeendet)}. Das Konto bleibt als Bürgerkonto aktiv.`,
    };
  });
}

// ---------------------------------------------------------------------------
// kontoSperrenPerEmailCore — IR-Notfall: Bürger:in ohne Rolle per E-Mail sperren
// ---------------------------------------------------------------------------

/**
 * Löst eine E-Mail tenant-scoped zu einer UserId auf und delegiert an
 * kontoSperrenCore (IR-Fall: Bürger:in ohne Rolle, die nicht in der
 * Rollen-Liste steht).
 *
 * users.email ist NICHT normalisiert gespeichert — der Vergleich läuft IMMER
 * `lower(trim(...))` beidseitig (Muster invitation-core). Nicht gefunden ⇒
 * bewusst GENERISCH „Konto nicht gefunden." (keine Bestätigung, ob eine
 * Adresse ein Konto hat — gleiches Verhalten wie fremder Tenant).
 */
export async function kontoSperrenPerEmailCore(
  db: Db,
  tenantId: string,
  callerRoleTypes: string[],
  callerUserId: string,
  targetEmail: string,
): Promise<KontoSicherheitResult> {
  if (!isAdmin(callerRoleTypes)) {
    return { ok: false, error: "Keine Berechtigung (Admin erforderlich)." };
  }

  const email = targetEmail.trim().toLowerCase();
  if (!email) {
    return { ok: false, error: "Bitte eine E-Mail-Adresse angeben." };
  }

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${email}`))
    .limit(1);
  const target = rows[0];
  if (!target) {
    return { ok: false, error: "Konto nicht gefunden." };
  }

  return kontoSperrenCore(db, tenantId, callerRoleTypes, callerUserId, target.id);
}
