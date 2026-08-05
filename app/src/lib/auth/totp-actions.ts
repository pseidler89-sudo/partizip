"use server";

/**
 * totp-actions.ts — Server Actions für die Zwei-Faktor-Einrichtung und -Prüfung (#59).
 *
 * Nur Actions in dieser Datei (CLAUDE.md): Lesende Hilfen gehören in
 * lib/auth/totp.ts bzw. lib/auth/zwei-faktor.ts. Jede Action ist ein
 * client-aufrufbarer RPC-Endpunkt — deshalb kommt der Nutzer AUSSCHLIESSLICH aus
 * dem Server-Kontext (getOptionalAuthContext), nie aus einem Parameter.
 *
 * SICHERHEITS-KERN:
 *   - Wiederverwendung: jeder eingelöste Zeitschritt wird in users.totp_last_step
 *     festgehalten; derselbe Code wird kein zweites Mal akzeptiert.
 *   - Rate-Limit: 5 Versuche je 15 Minuten und Konto (lib/auth/rate-limit.ts).
 *   - Der zweite Faktor wird an der SESSION vermerkt, nicht am Nutzer.
 *   - Wiederherstellungscodes werden per CAS entwertet (UPDATE … WHERE used_at
 *     IS NULL RETURNING), damit zwei parallele Einlösungen nicht beide gewinnen.
 */

import { and, eq, isNull } from "drizzle-orm";
import { users, sessions, totpRecoveryCodes, auditEvents } from "@/db/schema";
import { getOptionalAuthContext, getClientIp, type OptionalAuthContext } from "@/lib/auth/action-context";
import {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotp,
  otpauthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/auth/totp";
import { totpAktiv } from "@/lib/auth/zwei-faktor";
import { writeTotpRateLimitEvents, checkTotpRateLimit } from "@/lib/auth/rate-limit";

type Fehler = { ok: false; error: string };

/**
 * Kontext mit garantiert vorhandenem Nutzer und garantiert vorhandener Session.
 * Nicht exportiert — "use server"-Dateien geben nur Actions nach außen.
 */
type EingeloggterCtx = OptionalAuthContext & {
  user: NonNullable<OptionalAuthContext["user"]>;
  session: NonNullable<OptionalAuthContext["session"]>;
};

/** Gemeinsame Vorprüfung: eingeloggt und mit gültiger Session. */
async function eingeloggt(): Promise<{ ok: true; ctx: EingeloggterCtx } | Fehler> {
  const ctx = await getOptionalAuthContext();
  if (!ctx) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (!ctx.user || !ctx.session) return { ok: false, error: "Bitte melden Sie sich an." };
  return { ok: true, ctx: { ...ctx, user: ctx.user, session: ctx.session } };
}

/**
 * Startet die Einrichtung: erzeugt ein neues Secret und legt es UNBESTÄTIGT ab.
 *
 * Unbestätigt heißt: `totp_confirmed_at` bleibt NULL, TOTP gilt noch nicht als
 * aktiv. Sonst würde ein abgebrochener Einrichtungsversuch den Nutzer aussperren,
 * bevor er einen funktionierenden Authenticator hat.
 *
 * Ein erneuter Aufruf überschreibt ein unbestätigtes Secret (der Nutzer hat den
 * QR-Code vielleicht nie gescannt), lässt ein BESTÄTIGTES aber unangetastet —
 * ein aktiver zweiter Faktor darf nicht durch einen unauthentisierten Klick
 * zurückgesetzt werden.
 */
export async function starteEinrichtung(): Promise<
  { ok: true; uri: string; secret: string } | Fehler
> {
  const vor = await eingeloggt();
  if (!vor.ok) return vor;
  const { ctx } = vor;

  if (totpAktiv(ctx.user)) {
    return {
      ok: false,
      error:
        "Die Zwei-Faktor-Authentisierung ist bereits aktiv. Zum Wechsel des Geräts bitte zuerst die vorhandene Bestätigung eingeben.",
    };
  }

  const secret = generateTotpSecret();
  await ctx.db
    .update(users)
    .set({ totpSecretEnc: encryptTotpSecret(secret), totpConfirmedAt: null, totpLastStep: null })
    .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id), isNull(users.totpConfirmedAt)));

  return {
    ok: true,
    secret,
    uri: otpauthUri({
      secretBase32: secret,
      konto: ctx.user.email,
      herausgeber: `Partizip ${ctx.tenant.name}`,
    }),
  };
}

/**
 * Schließt die Einrichtung ab: prüft den ersten Code, aktiviert TOTP und gibt die
 * Wiederherstellungscodes EINMALIG zurück.
 */
export async function bestaetigeEinrichtung(
  code: string
): Promise<{ ok: true; wiederherstellungscodes: string[] } | Fehler> {
  const vor = await eingeloggt();
  if (!vor.ok) return vor;
  const { ctx } = vor;

  if (totpAktiv(ctx.user)) {
    return { ok: false, error: "Die Zwei-Faktor-Authentisierung ist bereits aktiv." };
  }
  if (!ctx.user.totpSecretEnc) {
    return { ok: false, error: "Die Einrichtung wurde noch nicht begonnen. Bitte laden Sie die Seite neu." };
  }

  const grenze = await rateLimitPruefen(ctx);
  if (grenze) return grenze;

  const pruefung = verifyTotp(decryptTotpSecret(ctx.user.totpSecretEnc), code, {
    letzterVerwendeterStep: ctx.user.totpLastStep,
  });
  if (!pruefung.ok) return { ok: false, error: codeFehlertext(pruefung.grund) };

  const jetzt = new Date();
  const codes = generateRecoveryCodes();

  await ctx.db
    .update(users)
    .set({ totpConfirmedAt: jetzt, totpLastStep: pruefung.step, totpGraceUntil: null })
    .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id)));

  // Frühere Codes eines abgebrochenen Versuchs verfallen mit der Neu-Einrichtung.
  await ctx.db.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, ctx.user.id));
  await ctx.db.insert(totpRecoveryCodes).values(
    codes.map((c) => ({
      userId: ctx.user.id,
      tenantId: ctx.tenant.id,
      codeHash: hashRecoveryCode(c),
    }))
  );

  // Die einrichtende Session gilt sofort als geprüft — der Nutzer hat gerade
  // einen gültigen Code geliefert; ihn erneut zu fragen wäre reine Schikane.
  await ctx.db
    .update(sessions)
    .set({ totpVerifiedAt: jetzt })
    .where(eq(sessions.id, ctx.session.id));

  await protokoll(ctx, "auth.totp_aktiviert");

  return { ok: true, wiederherstellungscodes: codes };
}

/**
 * Prüft einen Einmalcode für Anmeldung und Step-up und markiert die Session als
 * geprüft.
 */
export async function bestaetigeCode(code: string): Promise<{ ok: true } | Fehler> {
  const vor = await eingeloggt();
  if (!vor.ok) return vor;
  const { ctx } = vor;

  if (!totpAktiv(ctx.user) || !ctx.user.totpSecretEnc) {
    return { ok: false, error: "Für dieses Konto ist keine Zwei-Faktor-Authentisierung eingerichtet." };
  }

  const grenze = await rateLimitPruefen(ctx);
  if (grenze) return grenze;

  const pruefung = verifyTotp(decryptTotpSecret(ctx.user.totpSecretEnc), code, {
    letzterVerwendeterStep: ctx.user.totpLastStep,
  });
  if (!pruefung.ok) {
    await protokoll(ctx, "auth.totp_fehlversuch", { grund: pruefung.grund });
    return { ok: false, error: codeFehlertext(pruefung.grund) };
  }

  const jetzt = new Date();
  // Der Zeitschritt wird gesperrt, BEVOR die Session als geprüft gilt: Fällt der
  // zweite Schreibvorgang aus, ist der Code verbraucht statt weiter gültig.
  await ctx.db
    .update(users)
    .set({ totpLastStep: pruefung.step })
    .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id)));
  await ctx.db
    .update(sessions)
    .set({ totpVerifiedAt: jetzt })
    .where(eq(sessions.id, ctx.session.id));

  await protokoll(ctx, "auth.totp_bestaetigt");
  return { ok: true };
}

/**
 * Löst einen Wiederherstellungscode ein, wenn der Authenticator verloren ist.
 *
 * Der Code wird per CAS entwertet: Nur wer die Zeile von `used_at IS NULL` auf
 * einen Zeitstempel dreht, hat ihn wirklich eingelöst. Zwei gleichzeitige
 * Versuche mit demselben Code können so nicht beide gewinnen.
 */
export async function loeseWiederherstellungscodeEin(
  code: string
): Promise<{ ok: true; verbleibend: number } | Fehler> {
  const vor = await eingeloggt();
  if (!vor.ok) return vor;
  const { ctx } = vor;

  if (!totpAktiv(ctx.user)) {
    return { ok: false, error: "Für dieses Konto ist keine Zwei-Faktor-Authentisierung eingerichtet." };
  }

  const grenze = await rateLimitPruefen(ctx);
  if (grenze) return grenze;

  const jetzt = new Date();
  const eingeloest = await ctx.db
    .update(totpRecoveryCodes)
    .set({ usedAt: jetzt })
    .where(
      and(
        eq(totpRecoveryCodes.userId, ctx.user.id),
        eq(totpRecoveryCodes.tenantId, ctx.tenant.id),
        eq(totpRecoveryCodes.codeHash, hashRecoveryCode(code)),
        isNull(totpRecoveryCodes.usedAt)
      )
    )
    .returning({ id: totpRecoveryCodes.id });

  if (eingeloest.length === 0) {
    await protokoll(ctx, "auth.totp_wiederherstellung_fehlversuch");
    return { ok: false, error: "Dieser Wiederherstellungscode ist ungültig oder bereits verbraucht." };
  }

  await ctx.db
    .update(sessions)
    .set({ totpVerifiedAt: jetzt })
    .where(eq(sessions.id, ctx.session.id));

  const offen = await ctx.db
    .select({ id: totpRecoveryCodes.id })
    .from(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, ctx.user.id), isNull(totpRecoveryCodes.usedAt)));

  await protokoll(ctx, "auth.totp_wiederherstellung", { verbleibend: offen.length });
  return { ok: true, verbleibend: offen.length };
}

// --- interne Helfer (keine Actions nach außen) -----------------------------

async function rateLimitPruefen(ctx: EingeloggterCtx): Promise<Fehler | null> {
  const ip = await getClientIp();
  await writeTotpRateLimitEvents(ctx.db, { tenantId: ctx.tenant.id, userId: ctx.user.id, ipAddress: ip });
  const erlaubt = await checkTotpRateLimit(ctx.db, {
    tenantId: ctx.tenant.id,
    userId: ctx.user.id,
    ipAddress: ip,
  });
  if (erlaubt.allowed) return null;
  return {
    ok: false,
    error: "Zu viele Versuche. Bitte warten Sie 15 Minuten und versuchen Sie es dann erneut.",
  };
}

function codeFehlertext(grund: "format" | "falsch" | "wiederverwendet"): string {
  switch (grund) {
    case "format":
      return "Bitte geben Sie die sechs Ziffern aus Ihrer Authenticator-App ein.";
    case "wiederverwendet":
      return "Dieser Code wurde bereits verwendet. Bitte warten Sie auf den nächsten.";
    default:
      return "Der Code stimmt nicht. Prüfen Sie die Uhrzeit Ihres Geräts und versuchen Sie es erneut.";
  }
}

/** Protokolleintrag, PII-frei (actor_ref ist die User-UUID, keine E-Mail). */
async function protokoll(
  ctx: EingeloggterCtx,
  action: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await ctx.db.insert(auditEvents).values({
      tenantId: ctx.tenant.id,
      actorType: "user",
      actorRef: ctx.user.id,
      action,
      metadata,
    });
  } catch {
    // Best effort: Ein fehlgeschlagener Protokolleintrag darf die Anmeldung nicht
    // verhindern (CLAUDE.md: Nebeneffekte außerhalb der Transaktion, mit catch).
  }
}
