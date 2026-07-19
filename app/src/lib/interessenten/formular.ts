/**
 * interessenten/formular.ts — DB-berührender Kern des Formular-Lead-Pfades (N1),
 * BEWUSST OHNE "use server": von der Server Action (actions.ts) UND den
 * DB-Integrationstests aufgerufen. Die Action ist nur die dünne RPC-Hülle
 * (Origin/Honeypot/Host/IP), die validierten Daten kommen hier an.
 *
 * Ablauf (Reihenfolge sicherheitsrelevant):
 *   1. DEMO-FENCE (fail-closed): auf dem Demo-Mandanten KEIN Lead, KEINE Mail —
 *      der Trichter richtet sich an echte Kommunen, nicht an die Spielwiese.
 *   2. Rate-Limit (eigener Scope, Events VOR Prüfung) → bei Block neutrale
 *      Erfolgsmeldung (kein Oracle/Spam-Feedback).
 *   3. Insert (quelle='formular').
 *   4. Best-effort Betreiber-Mail (try/catch — Lead darf nicht verloren gehen).
 *   5. PII-freies Audit `interessent.created` (nur { quelle }) auf dem
 *      host-aufgelösten Pilot-Tenant (audit_events braucht tenantId).
 *
 * Nach außen IMMER { ok: true } (auch bei Demo-Fence/Rate-Limit) — kein Oracle.
 */

import type { Db } from "@/db/client";
import { interessenten, auditEvents } from "@/db/schema";
import { isDemoTenant } from "@/lib/demo/config";
import { sendInteressentNotification } from "@/lib/auth/mail";
import { checkInteressentRateLimit } from "./rate-limit";
import { formularZuInsert, type InteressentFormular, type InteressentInsert } from "./core";

/** Injizierbarer Notifier (Tests mocken ihn; Default = echte SMTP-Mail). */
export type InteressentNotifier = (lead: InteressentInsert) => Promise<void>;

export interface FormularLeadOpts {
  tenantId: string;
  tenantSlug: string;
  data: InteressentFormular;
  ipAddress: string | null;
  /** Test-Injektion; Default ruft sendInteressentNotification. */
  notify?: InteressentNotifier;
}

export interface FormularLeadResult {
  ok: true;
  /** true, wenn tatsächlich ein Lead geschrieben wurde (Tests/Diagnose). */
  gespeichert: boolean;
}

export async function verarbeiteFormularLead(
  db: Db,
  opts: FormularLeadOpts
): Promise<FormularLeadResult> {
  // 1. Demo-Fence (fail-closed): keine Außenwirkung auf dem Demo-Mandanten.
  if (isDemoTenant(opts.tenantSlug)) {
    return { ok: true, gespeichert: false };
  }

  // 2. Rate-Limit (Events werden intern VOR der Prüfung geschrieben).
  const rl = await checkInteressentRateLimit(db, {
    tenantId: opts.tenantId,
    email: opts.data.email,
    ipAddress: opts.ipAddress,
  });
  if (!rl.allowed) {
    // Neutral: kein Lead, aber nach außen Erfolg (kein Spam-Oracle).
    return { ok: true, gespeichert: false };
  }

  // 3. Insert.
  const insert = formularZuInsert(opts.data);
  await db.insert(interessenten).values(insert);

  // 4. Best-effort Betreiber-Mail (außerhalb jeder Tx; Fehler kippt den Lead nicht).
  const notify = opts.notify ?? sendInteressentNotification;
  try {
    await notify(insert);
  } catch (err) {
    console.error("[interessent] Benachrichtigungs-Mail fehlgeschlagen:", err);
  }

  // 5. PII-freies Audit (NIE Name/E-Mail/Nachricht — nur die Herkunft).
  try {
    await db.insert(auditEvents).values({
      tenantId: opts.tenantId,
      actorType: "system",
      actorRef: null,
      action: "interessent.created",
      targetType: "interessent",
      targetId: null,
      metadata: { quelle: "formular" },
    });
  } catch (err) {
    console.error("[interessent] Audit fehlgeschlagen:", err);
  }

  return { ok: true, gespeichert: true };
}
