/**
 * interessenten/webhook.ts — testbarer Kern des Tymeslot-Webhooks (Block N2),
 * BEWUSST OHNE "use server"/next-Imports: vom Route-Handler UND den
 * DB-Integrationstests genutzt.
 *
 * Tymeslot feuert `meeting.created` (u. a.) mit statischem Bearer-Token im Header
 * `X-Tymeslot-Token` (KEIN HMAC/Body-Signatur). Nach 10 Fehlversuchen deaktiviert
 * Tymeslot den Webhook → der Handler MUSS bei gültigem Token zuverlässig 2xx
 * liefern (auch bei Duplikat/ignoriertem Event/fehlenden Feldern).
 */

import { timingSafeEqual } from "node:crypto";
import type { Db } from "@/db/client";
import { interessenten, auditEvents } from "@/db/schema";
import { sendInteressentNotification } from "@/lib/auth/mail";
import { tymeslotZuInsert, TYMESLOT_MAX_BODY_BYTES, type TymeslotWebhookBody } from "./core";
import type { InteressentNotifier } from "./formular";

/**
 * Konstant-zeitiger Token-Vergleich. false, wenn der erwartete Token fehlt/leer
 * ist (fail-closed: ohne konfiguriertes Secret nimmt der Handler NICHTS an) oder
 * der übergebene Token fehlt/abweicht. Der Längen-Guard vor timingSafeEqual ist
 * nötig, weil die Funktion bei ungleicher Puffer-Länge wirft.
 */
export function tokenGueltig(
  provided: string | null | undefined,
  expected: string | undefined | null
): boolean {
  if (!expected || expected.length === 0) return false;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WebhookVerarbeitenOpts {
  /** Test-Injektion; Default = echte SMTP-Betreiber-Mail. */
  notify?: InteressentNotifier;
}

export interface WebhookVerarbeitenResult {
  /** true, wenn ein NEUER Lead geschrieben wurde (kein Duplikat/ignoriert). */
  inserted: boolean;
}

/**
 * Verarbeitet einen bereits geparsten Webhook-Body. NUR `event === "meeting.created"`
 * führt zu einem Insert; alles andere ist ein No-Op (Aufrufer antwortet 2xx).
 *
 *   - Mapping/Robustheit in tymeslotZuInsert (fehlende attendee.email ODER uid ⇒
 *     null ⇒ kein Insert).
 *   - Idempotenz: onConflictDoNothing auf dem partiellen Unique-Index
 *     (tymeslot_meeting_uid) — mehrfache Zustellung desselben Meetings = EIN Lead.
 *   - Best-effort Betreiber-Mail NUR bei echtem Neu-Insert.
 *   - PII-freies Audit (nur { quelle:'tymeslot' }), tenant-frei (tenant_id NULL —
 *     der Webhook hat keinen Tenant-Kontext).
 */
export async function verarbeiteWebhookEvent(
  db: Db,
  body: TymeslotWebhookBody,
  opts: WebhookVerarbeitenOpts = {}
): Promise<WebhookVerarbeitenResult> {
  if (body?.event !== "meeting.created") return { inserted: false };

  // Größen-Guard (Gate-B, defense-in-depth): absurd große Payloads werden OHNE
  // Insert verworfen (der Route-Handler prüft zusätzlich schon den rohen Body).
  // PII-frei geloggt; der Aufrufer antwortet weiterhin 2xx (Tymeslot-Auto-Disable).
  if (JSON.stringify(body).length > TYMESLOT_MAX_BODY_BYTES) {
    console.warn("[interessent-webhook] Payload zu groß — verworfen (kein Insert).");
    return { inserted: false };
  }

  const insert = tymeslotZuInsert(body);
  if (!insert) return { inserted: false };

  // Idempotent: bare ON CONFLICT DO NOTHING greift den partiellen uid-Unique ab.
  const rows = await db
    .insert(interessenten)
    .values(insert)
    .onConflictDoNothing()
    .returning({ id: interessenten.id });

  const inserted = rows.length > 0;
  if (!inserted) return { inserted: false };

  // Best-effort Mail (nur bei Neu-Insert; Fehler kippt den Lead nicht).
  const notify = opts.notify ?? sendInteressentNotification;
  try {
    await notify(insert);
  } catch (err) {
    console.error("[interessent-webhook] Benachrichtigungs-Mail fehlgeschlagen:", err);
  }

  // PII-freies Audit (tenant-frei).
  try {
    await db.insert(auditEvents).values({
      tenantId: null,
      actorType: "system",
      actorRef: null,
      action: "interessent.created",
      targetType: "interessent",
      targetId: null,
      metadata: { quelle: "tymeslot" },
    });
  } catch (err) {
    console.error("[interessent-webhook] Audit fehlgeschlagen:", err);
  }

  return { inserted: true };
}
