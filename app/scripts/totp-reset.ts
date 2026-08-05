/**
 * totp-reset.ts — Notfall-Rücksetzung der Zwei-Faktor-Authentisierung (#59).
 *
 * WOFÜR: Wenn ein Admin sowohl seinen Authenticator als auch alle
 * Wiederherstellungscodes verloren hat, gibt es aus der Anwendung heraus keinen
 * Weg zurück — das ist Absicht. Dieses Skript ist der zweite Weg und setzt
 * Serverzugriff voraus: Wer es ausführen kann, hat ohnehin Zugriff auf die
 * Datenbank.
 *
 * WAS ES TUT: Es entfernt Secret, Bestätigung und alle Wiederherstellungscodes
 * des Kontos und setzt eine neue Kulanzfrist. Der Nutzer kann sich danach per
 * Magic-Link anmelden und die Einrichtung neu durchlaufen. Bestehende Sessions
 * werden dabei revoziert — hätte jemand die Anmeldung übernommen, endet sie hier.
 *
 * WAS ES NICHT TUT: Es umgeht keine Anmeldung. Ohne Zugriff auf das E-Mail-Postfach
 * des Kontos nützt die Rücksetzung nichts.
 *
 * AUFRUF (im Deployment-Verzeichnis):
 *   DATABASE_URL=... npx tsx scripts/totp-reset.ts --tenant <slug> --email <adresse>
 *   Zusätzlich --ja, sonst wird nur angezeigt, was passieren würde.
 */

import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { users, tenants, sessions, totpRecoveryCodes, auditEvents } from "../src/db/schema";
import { normalizeEmail } from "../src/lib/auth/email";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function main() {
  const tenantSlug = arg("tenant");
  const email = arg("email");
  const bestaetigt = process.argv.includes("--ja");

  if (!tenantSlug || !email) {
    console.error(
      "Aufruf: DATABASE_URL=... npx tsx scripts/totp-reset.ts --tenant <slug> --email <adresse> [--ja]"
    );
    process.exit(2);
  }

  const datenbank = process.env.DATABASE_URL;
  if (!datenbank) {
    console.error("DATABASE_URL fehlt.");
    process.exit(2);
  }

  const db = createDb(datenbank);

  const tenantZeilen = await db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
  const tenant = tenantZeilen[0];
  if (!tenant) {
    console.error(`Kein Mandant mit dem Kürzel "${tenantSlug}".`);
    process.exit(1);
  }

  const nutzerZeilen = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.email, normalizeEmail(email))))
    .limit(1);
  const nutzer = nutzerZeilen[0];
  if (!nutzer) {
    console.error(`Kein Konto mit dieser Adresse im Mandanten "${tenantSlug}".`);
    process.exit(1);
  }

  const offeneCodes = await db
    .select({ id: totpRecoveryCodes.id })
    .from(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, nutzer.id), isNull(totpRecoveryCodes.usedAt)));

  const aktiveSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, nutzer.id), isNull(sessions.revokedAt)));

  console.log(`Mandant:               ${tenant.slug}`);
  console.log(`Konto:                 ${nutzer.id}`);
  console.log(`Zwei-Faktor aktiv:     ${nutzer.totpConfirmedAt ? `ja, seit ${nutzer.totpConfirmedAt.toISOString()}` : "nein"}`);
  console.log(`Offene Codes:          ${offeneCodes.length}`);
  console.log(`Aktive Sessions:       ${aktiveSessions.length}`);

  if (!bestaetigt) {
    console.log("\nProbelauf — nichts geändert. Mit --ja ausführen.");
    process.exit(0);
  }

  const jetzt = new Date();
  const neueFrist = new Date(jetzt.getTime() + 14 * 24 * 60 * 60 * 1000);

  await db
    .update(users)
    .set({
      totpSecretEnc: null,
      totpConfirmedAt: null,
      totpLastStep: null,
      totpGraceUntil: neueFrist,
    })
    .where(eq(users.id, nutzer.id));

  await db.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, nutzer.id));

  // Alle Sessions beenden: Wäre die Rücksetzung nötig, weil ein Konto übernommen
  // wurde, bliebe die fremde Anmeldung sonst bestehen.
  await db
    .update(sessions)
    .set({ revokedAt: jetzt })
    .where(and(eq(sessions.userId, nutzer.id), isNull(sessions.revokedAt)));

  await db.insert(auditEvents).values({
    tenantId: tenant.id,
    actorType: "system",
    actorRef: nutzer.id,
    action: "auth.totp_zurueckgesetzt",
    metadata: { weg: "cli", neueFrist: neueFrist.toISOString(), sessionsBeendet: aktiveSessions.length },
  });

  console.log("\nZurückgesetzt.");
  console.log(`Neue Frist zur Einrichtung: ${neueFrist.toISOString()}`);
  console.log("Der Nutzer meldet sich per Anmeldelink an und richtet die Bestätigung neu ein.");
  process.exit(0);
}

main().catch((fehler) => {
  console.error(fehler);
  process.exit(1);
});
