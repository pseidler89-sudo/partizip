/**
 * reverify-reminders.ts — Erinnerung vor Ablauf der Wohnort-Verifizierung (Roadmap).
 *
 * Wohnort-Verifizierung (Stufe 2) läuft nach 24 Monaten ab (ADR-014). Ohne Hinweis
 * fällt ein Konto still auf Stufe 1 zurück (kein verbindliches Abstimmen mehr).
 * Dieses Modul findet Konten im Ablauf-Fenster und liefert Inhalt + Markierung;
 * der eigentliche Versand passiert im Skript (scripts/reverify-reminders.ts), damit
 * das Modul SMTP-frei und unit-testbar bleibt.
 *
 * Datenschutz: Die Abfrage ist tenant-scoped möglich; die E-Mail-Adresse wird NUR
 * zum Versand genutzt, nie geloggt/auditiert. Der „erinnert"-Marker ist ein
 * Zeitstempel (kein PII), der Mehrfach-Versand pro Zyklus verhindert.
 */

import { and, eq, isNull, gt, lte, inArray, notLike } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users, tenants } from "@/db/schema";
import { BRAND_COLOR } from "@/lib/brand";

/** Standard-Fenster: 60 Tage (rund 2 Monate) vor Ablauf erinnern. */
export const DEFAULT_REVERIFY_WINDOW_DAYS = 60;

export interface ReVerifyFaellig {
  userId: string;
  email: string;
  tenantId: string;
  tenantSlug: string;
  ablaeuftAm: Date;
}

/**
 * Konten, deren Wohnort-Verifizierung bald abläuft und die noch nicht erinnert
 * wurden. Bedingungen: aktives Konto · `residency_verified_until` noch gültig
 * (> now) aber innerhalb des Fensters (≤ now + windowDays) · noch kein
 * `reverify_reminder_sent_at` (NULL) im aktuellen Zyklus. Tenant-scoped optional.
 *
 * Zeitvergleiche über Drizzle-Operatoren (kein Roh-SQL-Date → kein Treiber-Abbruch).
 * NULL-`residency_verified_until` fällt durch gt/lte automatisch heraus.
 */
export async function getReVerifyFaellige(
  db: Db,
  opts?: { windowDays?: number; now?: Date; tenantId?: string }
): Promise<ReVerifyFaellig[]> {
  const now = opts?.now ?? new Date();
  const windowDays = opts?.windowDays ?? DEFAULT_REVERIFY_WINDOW_DAYS;
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const conds = [
    eq(users.accountStatus, "active"),
    // Block J2c: das Opt-out „notify_reverify" wirksam machen.
    eq(users.notifyReverify, true),
    isNull(users.reverifyReminderSentAt),
    gt(users.residencyVerifiedUntil, now),
    lte(users.residencyVerifiedUntil, windowEnd),
    // Hygiene-Parität zum notifyNewPolls-Muster (bisher fehlend): gelöschte/
    // anonymisierte Tombstones und ephemere Demo-Adressen (RFC-2606) ausschließen.
    isNull(users.deletedAt),
    notLike(users.email, "%@deleted.invalid"),
    notLike(users.email, "%@demo.invalid"),
  ];
  if (opts?.tenantId) conds.push(eq(users.tenantId, opts.tenantId));

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      tenantId: users.tenantId,
      tenantSlug: tenants.slug,
      ablaeuftAm: users.residencyVerifiedUntil,
    })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(...conds));

  // gt/lte garantieren residency_verified_until != null → Cast sicher.
  return rows.map((r: { userId: string; email: string; tenantId: string; tenantSlug: string; ablaeuftAm: Date | null }) => ({
    userId: r.userId,
    email: r.email,
    tenantId: r.tenantId,
    tenantSlug: r.tenantSlug,
    ablaeuftAm: r.ablaeuftAm as Date,
  }));
}

export interface ReVerifyEmail {
  subject: string;
  text: string;
  html: string;
}

/** Baut die Erinnerungs-Mail (positiv, ohne Drohton). Teal-Button via BRAND_COLOR. */
export function buildReVerifyEmail(params: { verifyUrl: string; ablaeuftAm: Date }): ReVerifyEmail {
  const datum = params.ablaeuftAm.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const subject = "Ihre Wohnort-Bestätigung läuft bald ab";
  const text =
    `Ihre Wohnort-Bestätigung (Stufe 2) auf Partizip läuft am ${datum} ab.\n\n` +
    `Danach können Sie weiterhin bei Stimmungsbildern mitstimmen, aber nicht mehr ` +
    `bei verbindlichen Abstimmungen. So bestätigen Sie Ihren Wohnort erneut:\n` +
    `${params.verifyUrl}\n\n` +
    `Diese Erinnerung wurde automatisch generiert.`;
  const html = `
    <p>Ihre <strong>Wohnort-Bestätigung (Stufe 2)</strong> auf Partizip läuft am <strong>${datum}</strong> ab.</p>
    <p>Danach können Sie weiterhin bei Stimmungsbildern mitstimmen, aber nicht mehr bei <strong>verbindlichen</strong> Abstimmungen.</p>
    <p><a href="${params.verifyUrl}" style="display:inline-block;padding:10px 20px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Wohnort erneut bestätigen</a></p>
    <p style="color:#6b7280;font-size:13px;">Diese Erinnerung wurde automatisch generiert.</p>
  `;
  return { subject, text, html };
}

/**
 * Markiert die angegebenen Konten als „erinnert" (reverify_reminder_sent_at = when).
 * Best-effort: nur IDs übergeben, an die wirklich gesendet wurde (Fehler werden so
 * im nächsten Lauf erneut versucht). Gibt die Anzahl markierter Zeilen zurück.
 */
export async function markReVerifyReminded(
  db: Db,
  userIds: string[],
  when?: Date
): Promise<number> {
  if (userIds.length === 0) return 0;
  await db
    .update(users)
    .set({ reverifyReminderSentAt: when ?? new Date() })
    .where(inArray(users.id, userIds));
  return userIds.length;
}
