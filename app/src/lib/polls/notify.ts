/**
 * notify.ts — Benachrichtigungs-Motor: E-Mail bei neuer aktiver Abstimmung.
 *
 * Wenn eine Umfrage entwurf→aktiv geht (pollAktivieren), erhalten die Bürger:innen
 * IM SCOPE der Umfrage, die Benachrichtigungen aktiviert haben (notify_new_polls),
 * eine E-Mail: „Neue Abstimmung in <Kommune> – jetzt mitstimmen" + Frage + Link.
 * Das ist der Wiederkehr-Motor.
 *
 * BEWUSST OHNE "use server": reine, tenant-scoped Funktionen, aus der Action
 * (actions.ts) heraus aufgerufen. Lägen sie in der "use server"-Datei, würde
 * Next.js sie als client-aufrufbare RPC mit client-kontrolliertem Tenant
 * exponieren (Gate-B MAJOR-G).
 *
 * SICHERHEIT / DSGVO:
 *   - Tenant-Isolation in JEDER Query.
 *   - Anonymisierte/gelöschte Konten ausgeschlossen (deletedAt IS NULL UND
 *     E-Mail endet NICHT auf '@deleted.invalid').
 *   - Best-Effort-Versand: ein Mail-Fehler kippt den Rest NICHT.
 *   - KEINE E-Mail-Adresse wird je geloggt oder ins Audit geschrieben.
 *   - Nur Drizzle-Operatoren, KEIN Roh-SQL mit JS-Date (brach den Treiber).
 */

import { and, eq, isNull, notLike, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users, ortsteile, regions } from "@/db/schema";
import type { TenantRow } from "@/lib/tenant";
import { BRAND_COLOR } from "@/lib/brand";
import {
  createDefaultTransport,
  type NotifyTransport,
} from "@/lib/anliegen/notify";

const EMAIL_FROM =
  process.env.EMAIL_FROM ?? "Partizip <noreply@partizip.online>";

/** Minimal benötigte Poll-Daten für die Benachrichtigung (ADR-024: Gebietsknoten). */
export interface NotifyPoll {
  id: string;
  frage: string;
  regionId: string;
}

/**
 * Ermittelt die E-Mail-Empfänger:innen für eine neu aktivierte Umfrage.
 * Tenant-scoped, NUR Drizzle-Operatoren.
 *
 * Basis-Filter:
 *   - tenantId = tenant.id
 *   - accountStatus = 'active'
 *   - notify_new_polls = true
 *   - deletedAt IS NULL
 *   - E-Mail endet NICHT auf '@deleted.invalid' (anonymisierte Tombstones aus)
 *
 * Scope-Filter (ADR-024, über den Gebietsknoten der Umfrage):
 *   - Knoten ist ein Ortsteil (regions.typ='ortsteil') → nur User mit passendem
 *     users.ortsteilId. Der ortsteile-Datensatz wird über sein normalisiertes
 *     Label (regions_ltree_label(code)=regions.path_label) tenant-scoped
 *     aufgelöst. Kein passender Ortsteil → leere Liste (kein tenant-weiter Fallback).
 *   - sonst (Gemeinde/Kreis/Land/Bund) → tenant-weit alle.
 */
export async function getPollNotifyEmpfaenger(
  db: Db,
  tenant: TenantRow,
  poll: NotifyPoll,
): Promise<string[]> {
  // Gemeinsame Basis-Bedingungen (Tenant + Opt-in + nicht gelöscht/anonymisiert).
  const baseConditions = [
    eq(users.tenantId, tenant.id),
    eq(users.accountStatus, "active"),
    eq(users.notifyNewPolls, true),
    isNull(users.deletedAt),
    // Anonymisierte Tombstones (geloescht-<id>@deleted.invalid) ausschließen.
    notLike(users.email, "%@deleted.invalid"),
    // Ephemere Demo-Konten der Akquise-Spielwiese (lib/demo/actions.ts) ausschließen:
    // sie entstehen mit notifyNewPolls=false, könnten das Opt-in aber über die
    // Konto-Seite reaktivieren — die Adressen sind nie zustellbar (RFC-2606),
    // jeder Versandversuch wäre nur ein Bounce (Gate-B MINOR-3).
    notLike(users.email, "%@demo.invalid"),
  ];

  // Gebietsart + Label des Umfrage-Knotens laden (tenant-frei, nur lesend).
  const regionRows = await db
    .select({ typ: regions.typ, pathLabel: regions.pathLabel })
    .from(regions)
    .where(eq(regions.id, poll.regionId))
    .limit(1);
  const region = regionRows[0];

  // Ortsteil-Knoten: nur User mit passendem Ortsteil. Auflösung über das Label
  // (identisch zur Baum-Spiegelung), tenant-scoped.
  if (region?.typ === "ortsteil") {
    const otRows = await db
      .select({ id: ortsteile.id })
      .from(ortsteile)
      .where(
        and(
          eq(ortsteile.tenantId, tenant.id),
          sql`regions_ltree_label(${ortsteile.code}) = ${region.pathLabel}`,
        ),
      )
      .limit(1);
    const ortsteilId = otRows[0]?.id;
    // Kein passender Ortsteil → niemand im Scope (kein tenant-weiter Fallback).
    if (!ortsteilId) return [];

    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(...baseConditions, eq(users.ortsteilId, ortsteilId)));
    return rows.map((r: { email: string }) => r.email);
  }

  // Gemeinde/Kreis/Land/Bund → tenant-weit.
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(...baseConditions));
  return rows.map((r: { email: string }) => r.email);
}

export interface NotifyNewPollParams {
  db: Db;
  tenant: TenantRow;
  poll: NotifyPoll;
  /** Host-Header (Tenant-Subdomain) für den Link-Bau. */
  host: string;
  /** Transport injizierbar für Tests; Default createDefaultTransport(). */
  transport?: NotifyTransport;
}

export interface NotifyNewPollResult {
  sent: number;
  errors: number;
}

/**
 * Versendet die „Neue Abstimmung"-Mail an alle Empfänger:innen im Scope.
 *
 * Best-Effort: try/catch je Mail — ein Fehlschlag kippt den Rest NICHT. Bei 0
 * Empfängern: {sent:0, errors:0}. Es wird NIE eine E-Mail-Adresse geloggt.
 *
 * Link-Bau wie qr-actions.ts: proto aus host (localhost/127.0.0.1 → http, sonst
 * https): `${proto}://${host}/${tenant.slug}/umfrage/${poll.id}`.
 */
export async function notifyNewPoll(
  params: NotifyNewPollParams,
): Promise<NotifyNewPollResult> {
  const { db, tenant, poll, host } = params;
  const transport = params.transport ?? createDefaultTransport();

  const empfaenger = await getPollNotifyEmpfaenger(db, tenant, poll);
  if (empfaenger.length === 0) return { sent: 0, errors: 0 };

  const proto =
    host.startsWith("localhost") || host.includes("127.0.0.1") ? "http" : "https";
  const link = `${proto}://${host}/${tenant.slug}/umfrage/${poll.id}`;

  const subject = `Neue Abstimmung in ${tenant.name}`;

  const textBody = `Neue Abstimmung in ${tenant.name} – jetzt mitstimmen.

${poll.frage}

Jetzt mitstimmen:
${link}

Sie erhalten diese E-Mail, weil Sie Benachrichtigungen über neue Abstimmungen aktiviert haben. Diese können Sie jederzeit in Ihrem Konto abbestellen.`;

  const htmlBody = `
    <p style="font-size:16px;"><strong>Neue Abstimmung in ${tenant.name}</strong> – jetzt mitstimmen.</p>
    <p style="font-size:15px;color:#111827;">${escapeHtml(poll.frage)}</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Jetzt mitstimmen</a></p>
    <p style="color:#6b7280;font-size:13px;">Sie erhalten diese E-Mail, weil Sie Benachrichtigungen über neue Abstimmungen aktiviert haben. Diese können Sie jederzeit in Ihrem Konto abbestellen.</p>
  `;

  let sent = 0;
  let errors = 0;

  for (const email of empfaenger) {
    try {
      await transport.sendMail({
        from: EMAIL_FROM,
        to: email,
        subject,
        text: textBody,
        html: htmlBody,
      });
      sent++;
    } catch {
      // E-Mail wird NIE geloggt (PII); nur Zähler erhöhen.
      errors++;
    }
  }

  return { sent, errors };
}

/** Minimales HTML-Escaping für die Frage im HTML-Body (kein Markup-Inject). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
