/**
 * reverify-reminders.ts — versendet Erinnerungen vor Ablauf der Wohnort-Verifizierung.
 *
 * Findet Konten im Ablauf-Fenster (Default 30 Tage) und schickt EINE Erinnerung pro
 * Verifizierungs-Zyklus (Marke reverify_reminder_sent_at verhindert Mehrfach-Versand;
 * wird bei Re-Verifizierung zurückgesetzt). Fehlversand → nächster Lauf versucht erneut.
 *
 * Verwendung:
 *   REVERIFY_BASE_URL=https://taunusstein-staging.partizip.online \
 *     npm run reverify:reminders            # versendet
 *   npm run reverify:reminders -- --dry-run # nur zählen, nichts senden/markieren
 *
 * Env: DATABASE_URL · REVERIFY_BASE_URL (Pflicht beim Versand) ·
 *      REVERIFY_WINDOW_DAYS (opt, Default 30) · SMTP_URL · EMAIL_FROM
 *
 * Cron (täglich 05:00; Installation = Ops/Patrick, NICHT Teil dieses Skripts):
 *   0 5 * * * cd /pfad/zum/deployment && \
 *     docker compose --profile tools run --rm \
 *     -e REVERIFY_BASE_URL=https://<host> tools npm run reverify:reminders
 *
 * Hinweis Multi-Tenant: Der Link wird als <REVERIFY_BASE_URL>/<tenantSlug>/verifizieren
 * gebaut. Im Single-Domain-Pilot genügt EINE Base-URL; bei echten Subdomains pro Host
 * laufen lassen (oder die Base-URL je Tenant ableiten).
 */

import nodemailer from "nodemailer";
import { createDb } from "../src/db/client.js";
import {
  getReVerifyFaellige,
  buildReVerifyEmail,
  markReVerifyReminded,
  DEFAULT_REVERIFY_WINDOW_DAYS,
} from "../src/lib/verification/reverify-reminders.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip";
const SMTP_URL = process.env.SMTP_URL ?? "smtp://localhost:1025";
const EMAIL_FROM = process.env.EMAIL_FROM ?? "Partizip <noreply@partizip.online>";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const windowDays = process.env.REVERIFY_WINDOW_DAYS
    ? Number(process.env.REVERIFY_WINDOW_DAYS)
    : DEFAULT_REVERIFY_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error(`Ungültiges REVERIFY_WINDOW_DAYS: "${process.env.REVERIFY_WINDOW_DAYS}".`);
    process.exit(1);
  }

  const baseUrl = process.env.REVERIFY_BASE_URL?.replace(/\/+$/, "");
  if (!dryRun && !baseUrl) {
    console.error("REVERIFY_BASE_URL ist nicht gesetzt (Pflicht beim Versand). Oder --dry-run nutzen.");
    process.exit(1);
  }

  const db = createDb(databaseUrl);
  const faellige = await getReVerifyFaellige(db, { windowDays });
  console.log(`Fällige Erinnerungen (Fenster ${windowDays} Tage): ${faellige.length}`);

  if (dryRun) {
    console.log("--dry-run: nichts versendet, nichts markiert.");
    process.exit(0);
  }

  const transport = nodemailer.createTransport(SMTP_URL);
  const gesendet: string[] = [];
  let fehler = 0;

  for (const f of faellige) {
    const verifyUrl = `${baseUrl}/${f.tenantSlug}/verifizieren`;
    const mail = buildReVerifyEmail({ verifyUrl, ablaeuftAm: f.ablaeuftAm });
    try {
      await transport.sendMail({
        from: EMAIL_FROM,
        to: f.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      gesendet.push(f.userId);
    } catch (e) {
      fehler += 1;
      // KEINE E-Mail-Adresse loggen (PII) — nur userId (UUID) + Fehlertext.
      console.error(`Versand fehlgeschlagen für ${f.userId}:`, e instanceof Error ? e.message : e);
    }
  }

  const markiert = await markReVerifyReminded(db, gesendet);
  console.log(`Versendet: ${gesendet.length}, markiert: ${markiert}, Fehler: ${fehler}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Re-Verify-Erinnerungen fehlgeschlagen:", err);
  process.exit(1);
});
