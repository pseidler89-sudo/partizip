/**
 * interessenten/formular.ts — DB-berührender Kern des Formular-Lead-Pfades (N1),
 * BEWUSST OHNE "use server": von der Server Action (actions.ts) UND den
 * DB-Integrationstests aufgerufen. Die Action ist nur die dünne RPC-Hülle
 * (Origin/Honeypot/Host/IP), die validierten Daten kommen hier an.
 *
 * Ablauf (Reihenfolge sicherheitsrelevant):
 *   1. DEMO-FENCE: auf dem konfigurierten Demo-Mandanten KEIN Lead, KEINE Mail —
 *      der Trichter richtet sich an echte Kommunen, nicht an die Spielwiese.
 *      HINWEIS zur Reichweite (kein Über-Versprechen): die Fence greift nur, wenn
 *      `DEMO_TENANT_SLUG` gesetzt ist (isDemoTenant). In Prod IST der Slug gesetzt;
 *      ist er es NICHT, gibt es schlicht keinen Demo-Mandanten, gegen den man
 *      abschirmen müsste (jeder Tenant ist dann ein echter). Es ist also kein
 *      offener Bypass, sondern deckungsgleich mit der Definition „Demo-Mandant".
 *   2. Rate-Limit (eigener Scope, Events VOR Prüfung) → bei Block neutrale
 *      Erfolgsmeldung (kein Oracle/Spam-Feedback).
 *   3. Insert (quelle='formular').
 *   4. Best-effort Betreiber-Mail — via after() HINTER die Antwort verlegt
 *      (Timing-Invariante, s. verabeiteFormularLead), Fehler PII-frei geloggt.
 *   5. PII-freies Audit `interessent.created` (nur { quelle }) auf dem
 *      host-aufgelösten Pilot-Tenant (audit_events braucht tenantId).
 *
 * Nach außen IMMER { ok: true } (auch bei Demo-Fence/Rate-Limit) — kein Oracle.
 */

import { after } from "next/server";
import type { Db } from "@/db/client";
import { interessenten, auditEvents } from "@/db/schema";
import { isDemoTenant } from "@/lib/demo/config";
import { sendInteressentNotification } from "@/lib/auth/mail";
import { checkInteressentRateLimit } from "./rate-limit";
import { formularZuInsert, type InteressentFormular, type InteressentInsert } from "./core";

/**
 * Verlegt den Mail-Versand HINTER die Antwort (Gate-B, Timing-Invariante, Muster
 * `versandNachAntwort` aus J2b/email-change-actions): bevorzugt via Next.js
 * after() (läuft nach dem Senden der Response); außerhalb eines Request-Scopes
 * (z. B. Vitest) Fallback auf fire-and-forget. Fehler werden PII-frei geloggt
 * (nur die Fehlerklasse — SMTP-Meldungen können Empfänger enthalten).
 */
function versandNachAntwort(task: () => Promise<unknown>): void {
  const sicher = async () => {
    try {
      await task();
    } catch (err) {
      const klasse = err instanceof Error ? err.name : typeof err;
      console.error(`[interessent] Benachrichtigungs-Mail fehlgeschlagen (${klasse})`);
    }
  };
  try {
    after(sicher);
  } catch {
    // Kein Request-Scope (z. B. Vitest): best-effort im Hintergrund. task() wird
    // dabei synchron aufgerufen (die await-Suspension kommt erst danach), sodass
    // Tests den Notify-Aufruf unmittelbar nach dem await beobachten.
    void sicher();
  }
}

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
  // TIMING-INVARIANTE (Gate-B): Der dominante, netzlatenz-große Oracle war der
  // frühere SYNCHRONE SMTP-Round-Trip im Erfolgspfad (hunderte ms), der Erfolg
  // von Demo-Fence/Rate-Limit/Honeypot zeitlich unterscheidbar machte. Er ist
  // jetzt via after() OFF-PATH (s. u.). Die verbleibenden Zweig-Unterschiede sind
  // nur lokale DB-Operationen (0–3 kleine Queries) — nicht über das Netz messbar
  // und für diesen niedrigfrequenten, low-value Endpoint kein praktikables Oracle.
  //
  // 1. Demo-Fence: keine Außenwirkung auf dem konfigurierten Demo-Mandanten
  //    (Reichweite s. Datei-Kopf — greift, wenn DEMO_TENANT_SLUG gesetzt ist).
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

  // 3. Insert (bleibt SYNCHRON — der Lead darf nicht verloren gehen).
  const insert = formularZuInsert(opts.data);
  await db.insert(interessenten).values(insert);

  // 4. Best-effort Betreiber-Mail — NICHT im Antwortpfad awaiten (Timing-Oracle,
  //    s. o.), sondern via after() hinter die Antwort verlegen. Der Lead ist zu
  //    diesem Zeitpunkt bereits persistiert; ein Mail-Fehler kippt ihn nicht.
  const notify = opts.notify ?? sendInteressentNotification;
  versandNachAntwort(() => notify(insert));

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
