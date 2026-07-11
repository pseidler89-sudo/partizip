/**
 * notify.ts — Mail-Benachrichtigung bei Anliegen-Statuswechsel (M8)
 *
 * Bei Statuswechsel: Mail an alle Follower.
 * Follower-E-Mails werden nur für den Versand geladen, nie geloggt.
 *
 * Versand-Fehler verhindern den Statuswechsel NICHT:
 *   - try/catch um sendMail
 *   - audit anliegen.notify_error ohne PII bei Fehler
 *
 * Transport injizierbar für Tests (Spy).
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { BRAND_COLOR } from "@/lib/brand";

export type NotifyTransport = Pick<Transporter, "sendMail">;

/**
 * Erstellt den Standard-Nodemailer-Transport aus SMTP_URL.
 * Für Tests: eigenen Transport übergeben.
 */
export function createDefaultTransport(): NotifyTransport {
  const smtpUrl =
    process.env.SMTP_URL ??
    process.env.EMAIL_SERVER ??
    "smtp://127.0.0.1:1025";
  return nodemailer.createTransport(smtpUrl);
}

const EMAIL_FROM =
  process.env.EMAIL_FROM ?? "Partizip <noreply@partizip.online>";

/**
 * Status-Labels für neutrale Darstellung in der Mail.
 * Kein Vorwurf, nur Status (Kernprinzip 6).
 */
const STATUS_LABELS: Record<string, string> = {
  eingegangen: "Eingegangen",
  in_pruefung: "In Prüfung",
  im_gremium: "Im Gremium",
  beantwortet: "Beantwortet",
  umgesetzt: "Umgesetzt",
  abgelehnt: "Abgelehnt",
};

export interface NotifyStatusChangeParams {
  trackingCode: string;
  tenantSlug: string;
  previousStatus: string;
  newStatus: string;
  quelleUrl?: string | null;
  followerEmails: string[];
  transport?: NotifyTransport;
}

export interface NotifyResult {
  sent: number;
  errors: number;
}

/**
 * Sendet Benachrichtigungs-Mails an alle Follower bei Statuswechsel.
 *
 * @returns Anzahl gesendeter und fehlgeschlagener Mails
 */
export async function notifyFollowersStatusChanged(
  params: NotifyStatusChangeParams
): Promise<NotifyResult> {
  const transport = params.transport ?? createDefaultTransport();
  const {
    trackingCode,
    tenantSlug,
    previousStatus,
    newStatus,
    quelleUrl,
    followerEmails,
  } = params;

  if (followerEmails.length === 0) return { sent: 0, errors: 0 };

  const prevLabel = STATUS_LABELS[previousStatus] ?? previousStatus;
  const newLabel = STATUS_LABELS[newStatus] ?? newStatus;

  // Public Code-Seite URL (kein https-Hardcoding für Tests)
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
    ? `https://${tenantSlug}.${process.env.NEXT_PUBLIC_BASE_URL}`
    : `http://${tenantSlug}.localhost:3000`;
  const codeUrl = `${baseUrl}/anliegen/${trackingCode}`;

  const subject = `Ihr Anliegen ${trackingCode}: neuer Status`;

  const quelleHtml = quelleUrl
    ? `<p>Dokument: <a href="${quelleUrl}">${quelleUrl}</a></p>`
    : "";
  const quelleText = quelleUrl ? `\nDokument: ${quelleUrl}` : "";

  const textBody = `Ihr Anliegen ${trackingCode} hat einen neuen Status.\n\nAlter Status: ${prevLabel}\nNeuer Status: ${newLabel}${quelleText}\n\nStatusseite: ${codeUrl}\n\nDiese Benachrichtigung wurde automatisch generiert.`;
  const htmlBody = `
    <p>Ihr Anliegen <strong>${trackingCode}</strong> hat einen neuen Status.</p>
    <table style="border-collapse:collapse;margin:16px 0;">
      <tr><td style="color:#6b7280;padding-right:16px;">Alter Status:</td><td><strong>${prevLabel}</strong></td></tr>
      <tr><td style="color:#6b7280;padding-right:16px;">Neuer Status:</td><td><strong>${newLabel}</strong></td></tr>
    </table>
    ${quelleHtml}
    <p><a href="${codeUrl}" style="display:inline-block;padding:10px 20px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Statusseite öffnen</a></p>
    <p style="color:#6b7280;font-size:13px;">Diese Benachrichtigung wurde automatisch generiert.</p>
  `;

  let sent = 0;
  let errors = 0;

  for (const email of followerEmails) {
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
      // E-Mail wird nie geloggt (PII); nur Zähler erhöhen
      errors++;
    }
  }

  return { sent, errors };
}

// ---------------------------------------------------------------------------
// H4: Tracking-Code per E-Mail an den Ersteller
// ---------------------------------------------------------------------------

export interface TrackingCodeEmailParams {
  email: string;
  trackingCode: string;
  tenantSlug: string;
  transport?: NotifyTransport;
}

/**
 * Berechnet die öffentliche Basis-URL für einen Tenant.
 * Mit NEXT_PUBLIC_BASE_URL: https://<slug>.<base>; sonst localhost (Dev/Test).
 */
function tenantBaseUrl(tenantSlug: string): string {
  return process.env.NEXT_PUBLIC_BASE_URL
    ? `https://${tenantSlug}.${process.env.NEXT_PUBLIC_BASE_URL}`
    : `http://${tenantSlug}.localhost:3000`;
}

/**
 * Sendet dem Ersteller seinen Tracking-Code per E-Mail (H4).
 *
 * Damit ist der Code auch dann auffindbar, wenn der Nutzer die einmalige
 * Anzeige verpasst. Der Aufrufer (createAnliegen) fängt Fehler ab — ein
 * Mailfehler darf die Anliegen-Erstellung NICHT scheitern lassen.
 *
 * @returns true bei erfolgreichem Versand, false bei Fehler.
 */
export async function sendTrackingCodeEmail(
  params: TrackingCodeEmailParams
): Promise<boolean> {
  const transport = params.transport ?? createDefaultTransport();
  const { email, trackingCode, tenantSlug } = params;

  const codeUrl = `${tenantBaseUrl(tenantSlug)}/anliegen/${trackingCode}`;
  const subject = "Ihr Anliegen-Tracking-Code";

  const textBody = `Vielen Dank — Ihr Anliegen wurde eingereicht.

Ihr Tracking-Code lautet: ${trackingCode}

Mit diesem Code können Sie den Bearbeitungsstand jederzeit verfolgen:
${codeUrl}

Bitte bewahren Sie den Code auf. Aus Datenschutzgründen ist Ihr Anliegen nicht direkt mit Ihrem Konto verknüpft.

Diese Nachricht wurde automatisch generiert.`;

  const htmlBody = `
    <p>Vielen Dank — Ihr Anliegen wurde eingereicht.</p>
    <p>Ihr Tracking-Code lautet:</p>
    <p style="font-family:monospace;font-size:20px;font-weight:bold;letter-spacing:2px;">${trackingCode}</p>
    <p>Mit diesem Code können Sie den Bearbeitungsstand jederzeit verfolgen:</p>
    <p><a href="${codeUrl}" style="display:inline-block;padding:10px 20px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Status ansehen</a></p>
    <p style="color:#6b7280;font-size:13px;">Bitte bewahren Sie den Code auf. Aus Datenschutzgründen ist Ihr Anliegen nicht direkt mit Ihrem Konto verknüpft.</p>
    <p style="color:#6b7280;font-size:13px;">Diese Nachricht wurde automatisch generiert.</p>
  `;

  try {
    await transport.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject,
      text: textBody,
      html: htmlBody,
    });
    return true;
  } catch {
    // E-Mail wird nie geloggt (PII); Fehler wird vom Aufrufer auditiert.
    return false;
  }
}
