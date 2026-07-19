/**
 * mail.ts — Magic-Link-E-Mail-Versand via nodemailer / SMTP
 *
 * Konfiguration via env:
 *   SMTP_URL oder EMAIL_SERVER: SMTP-URL (z. B. smtp://user:pass@host:port)
 *   EMAIL_FROM: Absender-Adresse
 *
 * Dev-Modus (NODE_ENV !== 'production'):
 *   Magic-Link wird via console.log ausgegeben — NUR der Link,
 *   NIEMALS E-Mail + Link in einer Zeile (PII-Minimierung).
 *
 * PII-DESIGN: Diese Funktion erhält E-Mail und Link. Sie loggt niemals
 * beides zusammen. Im Prod-Modus kein Logging.
 */

import nodemailer from "nodemailer";
import { BRAND_COLOR } from "@/lib/brand";
import { ANBIETER } from "@/lib/legal/anbieter";

const SMTP_URL =
  process.env.SMTP_URL ??
  process.env.EMAIL_SERVER ??
  "smtp://127.0.0.1:1025";

const EMAIL_FROM =
  process.env.EMAIL_FROM ?? "Partizip <noreply@partizip.online>";

function createTransport() {
  return nodemailer.createTransport(SMTP_URL);
}

export async function sendMagicLinkEmail(
  email: string,
  magicLinkUrl: string
): Promise<void> {
  const transport = createTransport();

  await transport.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: "Ihr Anmeldelink für Partizip",
    text: `Klicken Sie auf diesen Link, um sich anzumelden:\n\n${magicLinkUrl}\n\nDer Link ist 15 Minuten gültig und kann nur einmal verwendet werden.\n\nFalls Sie diesen Link nicht angefordert haben, können Sie diese E-Mail ignorieren.`,
    html: `
      <p>Klicken Sie auf den Link, um sich bei Partizip anzumelden:</p>
      <p><a href="${magicLinkUrl}" style="display:inline-block;padding:12px 24px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Jetzt anmelden</a></p>
      <p style="color:#6b7280;font-size:14px;">Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden.</p>
      <p style="color:#6b7280;font-size:14px;">Falls Sie keinen Anmeldelink angefordert haben, können Sie diese E-Mail ignorieren.</p>
    `,
  });

  // MIN2: console.log entfernt — Mailpit reicht im Dev als Empfänger.
  // Kein Logging des Links hier (PII-Minimierung, der Link ist ein Credential).
}

/**
 * Versendet eine Rollen-Einladung. Der Roh-Token steht ausschließlich in der
 * übergebenen URL (Credential) — hier wird er NIEMALS geloggt.
 *
 * `roleLabel` ist eine menschenlesbare Rollen-Bezeichnung (z. B. „Redakteur:in");
 * `kommuneName` der Kommunen-Name für die Anrede.
 */
export async function sendInvitationEmail(
  email: string,
  inviteUrl: string,
  roleLabel: string,
  kommuneName: string,
): Promise<void> {
  const transport = createTransport();

  await transport.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: `Ihre Einladung als ${roleLabel} bei Partizip`,
    text: `Sie wurden von ${kommuneName} eingeladen, bei Partizip als ${roleLabel} mitzuwirken.\n\nUm die Einladung anzunehmen, öffnen Sie diesen Link und melden sich mit dieser E-Mail-Adresse an:\n\n${inviteUrl}\n\nDie Einladung ist an Ihre E-Mail-Adresse gebunden und nur eine begrenzte Zeit gültig.\n\nFalls Sie diese Einladung nicht erwartet haben, können Sie diese E-Mail ignorieren.`,
    html: `
      <p>Sie wurden von <strong>${kommuneName}</strong> eingeladen, bei Partizip als <strong>${roleLabel}</strong> mitzuwirken.</p>
      <p>Um die Einladung anzunehmen, öffnen Sie den Link und melden sich mit dieser E-Mail-Adresse an:</p>
      <p><a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Einladung ansehen</a></p>
      <p style="color:#6b7280;font-size:14px;">Die Einladung ist an Ihre E-Mail-Adresse gebunden und nur eine begrenzte Zeit gültig.</p>
      <p style="color:#6b7280;font-size:14px;">Falls Sie diese Einladung nicht erwartet haben, können Sie diese E-Mail ignorieren.</p>
    `,
  });

  // Kein Logging des Links (PII-Minimierung, der Link ist ein Credential).
}

/**
 * Block J2b: Bestätigungs-Mail an die NEUE Adresse. Der Roh-Token steht
 * ausschließlich in der übergebenen URL (Credential) — hier NIE geloggt.
 * Ton „Sie". Nur wer diese Mail empfängt, kann die Änderung abschließen
 * (Kontrolle über die neue Adresse).
 */
export async function sendEmailChangeConfirmationEmail(
  neueEmail: string,
  bestaetigungsUrl: string,
): Promise<void> {
  const transport = createTransport();

  await transport.sendMail({
    from: EMAIL_FROM,
    to: neueEmail,
    subject: "Bestätigen Sie Ihre neue E-Mail-Adresse für Partizip",
    text: `Sie möchten die E-Mail-Adresse Ihres Partizip-Kontos auf diese Adresse ändern.\n\nUm die Änderung abzuschließen, öffnen Sie bitte diesen Link und bestätigen Sie:\n\n${bestaetigungsUrl}\n\nDer Link ist 15 Minuten gültig und kann nur einmal verwendet werden. Sie müssen dazu in Ihrem Konto angemeldet sein.\n\nFalls Sie diese Änderung nicht angefordert haben, können Sie diese E-Mail ignorieren — es wird nichts geändert.`,
    html: `
      <p>Sie möchten die E-Mail-Adresse Ihres Partizip-Kontos auf diese Adresse ändern.</p>
      <p>Um die Änderung abzuschließen, öffnen Sie den Link und bestätigen Sie:</p>
      <p><a href="${bestaetigungsUrl}" style="display:inline-block;padding:12px 24px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Neue Adresse bestätigen</a></p>
      <p style="color:#6b7280;font-size:14px;">Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden. Sie müssen dazu in Ihrem Konto angemeldet sein.</p>
      <p style="color:#6b7280;font-size:14px;">Falls Sie diese Änderung nicht angefordert haben, können Sie diese E-Mail ignorieren — es wird nichts geändert.</p>
    `,
  });

  // Kein Logging der URL (der Roh-Token darin ist ein Credential).
}

/**
 * Block J2b: Sicherheits-Info-Mail an die ALTE Adresse NACH erfolgtem Wechsel.
 * Enthält KEINEN Revert-Link (v1). `kontaktEmail` ist die Betreiber-Adresse
 * (lib/legal/anbieter.ts), an die sich „Das war ich nicht"-Fälle wenden.
 */
export async function sendEmailChangedInfoEmail(
  alteEmail: string,
  kontaktEmail: string,
): Promise<void> {
  const transport = createTransport();

  await transport.sendMail({
    from: EMAIL_FROM,
    to: alteEmail,
    replyTo: kontaktEmail,
    subject: "Ihre E-Mail-Adresse bei Partizip wurde geändert",
    text: `Die E-Mail-Adresse Ihres Partizip-Kontos wurde soeben geändert. Ab jetzt erfolgt die Anmeldung über die neue Adresse.\n\nWaren Sie das nicht, wenden Sie sich bitte umgehend an ${kontaktEmail} (oder antworten Sie auf diese E-Mail).`,
    html: `
      <p>Die E-Mail-Adresse Ihres Partizip-Kontos wurde soeben geändert. Ab jetzt erfolgt die Anmeldung über die neue Adresse.</p>
      <p style="color:#6b7280;font-size:14px;">Waren Sie das nicht, wenden Sie sich bitte umgehend an <a href="mailto:${kontaktEmail}">${kontaktEmail}</a> (oder antworten Sie auf diese E-Mail).</p>
    `,
  });
}

/**
 * Block N: Benachrichtigt den Betreiber (ANBIETER.email) über einen neuen
 * Interessenten-Lead (Formular oder Tymeslot-Buchung). Diese Mail geht an
 * Patricks EIGENES Postfach (den Betreiber) und darf daher die Lead-Angaben
 * enthalten — sie sind der Zweck der Benachrichtigung. `replyTo` = Adresse des
 * Interessenten, damit Patrick direkt antworten kann.
 *
 * WICHTIG: Best-effort — der Aufrufer fängt Fehler ab (der Lead ist bereits
 * gespeichert und darf nicht durch einen Mailfehler verloren gehen). Das
 * PII-freie Auditieren passiert getrennt beim Aufrufer (nur { quelle }).
 */
export async function sendInteressentNotification(lead: {
  quelle: "formular" | "tymeslot";
  ansprechpartner: string;
  email: string;
  kommune: string | null;
  rolle: string | null;
  groesse: string | null;
  nachricht: string | null;
  terminAm: Date | null;
}): Promise<void> {
  const transport = createTransport();

  const herkunft =
    lead.quelle === "tymeslot" ? "Terminbuchung (Tymeslot)" : "Mitmachen-Formular";
  const zeilen: string[] = [
    `Herkunft: ${herkunft}`,
    lead.kommune ? `Organisation: ${lead.kommune}` : null,
    `Ansprechpartner: ${lead.ansprechpartner}`,
    `E-Mail: ${lead.email}`,
    lead.rolle ? `Funktion: ${lead.rolle}` : null,
    lead.groesse ? `Größe: ${lead.groesse}` : null,
    lead.terminAm ? `Termin: ${lead.terminAm.toISOString()}` : null,
    lead.nachricht ? `\nNachricht:\n${lead.nachricht}` : null,
  ].filter((z): z is string => z !== null);

  await transport.sendMail({
    from: EMAIL_FROM,
    to: ANBIETER.email,
    replyTo: lead.email,
    subject: `Neuer Interessent (${herkunft})${lead.kommune ? ` — ${lead.kommune}` : ""}`,
    text: `Es ist ein neuer Interessent eingegangen:\n\n${zeilen.join("\n")}\n\nZur Verwaltung: /admin/interessenten`,
  });
}

export async function sendRegistrationHintEmail(email: string): Promise<void> {
  // Wird gesendet wenn User nicht existiert aber minAgeConfirmed NICHT mitgesandt wurde.
  // Neutral formuliert — kein User-Enumeration-Leak (gleiche Antwort nach außen).
  const transport = createTransport();

  await transport.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: "Anmeldung bei Partizip",
    text: `Sie haben einen Anmeldelink angefordert.\n\nUm ein Konto zu erstellen, bestätigen Sie bitte auf der Anmeldeseite, dass Sie mindestens 16 Jahre alt sind, und fordern Sie dann erneut einen Link an.\n\nFalls Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren.`,
    html: `
      <p>Sie haben einen Anmeldelink für Partizip angefordert.</p>
      <p>Um ein Konto zu erstellen, bestätigen Sie bitte auf der Anmeldeseite, dass Sie mindestens 16 Jahre alt sind, und fordern Sie dann erneut einen Link an.</p>
      <p style="color:#6b7280;font-size:14px;">Falls Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren.</p>
    `,
  });
}
