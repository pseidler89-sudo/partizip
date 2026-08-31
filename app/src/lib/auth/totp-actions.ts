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
 *   - Gerätewechsel (zweitFaktorNeuEinrichten) verlangt eine FRISCHE Bestätigung
 *     dieser Session — Begründung am Kopf der Action.
 *   - Jede Änderung am zweiten Faktor geht als Info-Mail an die Kontoadresse
 *     (best effort, ohne Codes/Secret/Link).
 */

import { and, eq, isNull, isNotNull, or, lt } from "drizzle-orm";
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
import { totpAktiv, stepUpErfuellt, STEP_UP_MAX_ALTER_MINUTEN } from "@/lib/auth/zwei-faktor";
import { writeTotpRateLimitEvents, checkTotpRateLimit } from "@/lib/auth/rate-limit";
import { sendZweiFaktorAenderungEmail, type ZweiFaktorEreignis } from "@/lib/auth/mail";
import { ANBIETER } from "@/lib/legal/anbieter";

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
    // Der Weg zum Gerätewechsel führt über zweitFaktorNeuEinrichten() — dort
    // steht die frische Bestätigung als Bedingung. Der Text sagt genau das und
    // verspricht keinen Ablauf, den es nicht gibt (Review #59, Befund 1).
    return {
      ok: false,
      error:
        "Die Zwei-Faktor-Authentisierung ist bereits aktiv. Für einen Gerätewechsel setzen Sie sie zuerst unter Gerät wechseln zurück.",
    };
  }

  // Auch die Secret-Erzeugung braucht ein Limit: Sie schreibt in users und war
  // vorher die einzige Action hier ohne Deckel (Gate-B, MINOR).
  const grenze = await rateLimitPruefen(ctx);
  if (grenze) return grenze;

  const secret = generateTotpSecret();
  const gesetzt = await ctx.db
    .update(users)
    .set({ totpSecretEnc: encryptTotpSecret(secret), totpConfirmedAt: null, totpLastStep: null })
    .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id), isNull(users.totpConfirmedAt)))
    .returning({ id: users.id });

  // Traf das UPDATE keine Zeile, wurde parallel bestätigt. Dann darf der QR-Code
  // NICHT ausgeliefert werden — er zeigte ein Secret, das nirgends gespeichert ist.
  if (gesetzt.length === 0) {
    return { ok: false, error: "Die Zwei-Faktor-Authentisierung ist bereits aktiv." };
  }

  await protokoll(ctx, "auth.totp_einrichtung_gestartet");

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

  // isNull(totpConfirmedAt) als CAS: Zwischen der Lese-Prüfung oben und hier
  // könnte ein paralleler Aufruf bereits bestätigt haben. Dann gewinnt der erste,
  // und der zweite bekommt keine zweite Garnitur Wiederherstellungscodes.
  const aktiviert = await ctx.db
    .update(users)
    .set({ totpConfirmedAt: jetzt, totpLastStep: pruefung.step, totpGraceUntil: null })
    .where(
      and(
        eq(users.id, ctx.user.id),
        eq(users.tenantId, ctx.tenant.id),
        isNull(users.totpConfirmedAt)
      )
    )
    .returning({ id: users.id });

  if (aktiviert.length === 0) {
    return { ok: false, error: "Die Zwei-Faktor-Authentisierung ist bereits aktiv." };
  }

  // Frühere Codes eines abgebrochenen Versuchs verfallen mit der Neu-Einrichtung.
  await ctx.db
    .delete(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, ctx.user.id), eq(totpRecoveryCodes.tenantId, ctx.tenant.id)));
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
    .where(and(eq(sessions.id, ctx.session.id), eq(sessions.tenantId, ctx.tenant.id)));

  await protokoll(ctx, "auth.totp_aktiviert");
  await benachrichtige(ctx, "aktiviert", jetzt);

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
  //
  // CAS statt schlichtem UPDATE (Gate-B 2026-08-05, MAJOR): Der gelesene
  // totp_last_step stammt vom Anfang des Requests. Ohne Bedingung auf den
  // erwarteten Vorzustand könnten zwei gleichzeitige Requests mit DEMSELBEN Code
  // beide bestehen — genau der Replay, den die Sperre verhindern soll. Nur wer
  // die Zeile wirklich von "kleiner" auf diesen Schritt dreht, hat den Code
  // eingelöst; der Verlierer bekommt 0 Zeilen zurück.
  const gesperrt = await ctx.db
    .update(users)
    .set({ totpLastStep: pruefung.step })
    .where(
      and(
        eq(users.id, ctx.user.id),
        eq(users.tenantId, ctx.tenant.id),
        or(isNull(users.totpLastStep), lt(users.totpLastStep, pruefung.step))
      )
    )
    .returning({ id: users.id });

  if (gesperrt.length === 0) {
    await protokoll(ctx, "auth.totp_fehlversuch", { grund: "wiederverwendet" });
    return { ok: false, error: codeFehlertext("wiederverwendet") };
  }

  await ctx.db
    .update(sessions)
    .set({ totpVerifiedAt: jetzt })
    .where(and(eq(sessions.id, ctx.session.id), eq(sessions.tenantId, ctx.tenant.id)));

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
    .where(and(eq(sessions.id, ctx.session.id), eq(sessions.tenantId, ctx.tenant.id)));

  const offen = await ctx.db
    .select({ id: totpRecoveryCodes.id })
    .from(totpRecoveryCodes)
    .where(
      and(
        eq(totpRecoveryCodes.userId, ctx.user.id),
        eq(totpRecoveryCodes.tenantId, ctx.tenant.id),
        isNull(totpRecoveryCodes.usedAt)
      )
    );

  await protokoll(ctx, "auth.totp_wiederherstellung", { verbleibend: offen.length });
  await benachrichtige(ctx, "wiederherstellungscode", jetzt);
  return { ok: true, verbleibend: offen.length };
}

/**
 * Gerätewechsel: entfernt den vorhandenen zweiten Faktor, damit der Nutzer ihn
 * anschließend regulär über starteEinrichtung/bestaetigeEinrichtung neu
 * einrichten kann (Review #59, Befund 1).
 *
 * WARUM ES DIESEN WEG BRAUCHT: Ohne ihn endet ein Handywechsel in einer
 * Sackgasse. Der Nutzer löst einen Wiederherstellungscode ein, ist angemeldet —
 * aber TOTP zeigt weiter auf das tote Gerät. Die zehn Codes sind dann eine
 * schrumpfende Ressource ohne Nachschub, und danach hilft nur noch
 * scripts/totp-reset.ts mit Serverzugriff.
 *
 * WARUM ES NICHTS SCHWÄCHT: Bedingung ist eine FRISCHE Bestätigung dieser
 * Session (stepUpErfuellt, höchstens STEP_UP_MAX_ALTER_MINUTEN alt). Wer sie
 * hat, hat gerade einen gültigen Einmalcode ODER einen Wiederherstellungscode
 * geliefert — er besitzt den zweiten Faktor bereits. Ihn wechseln zu lassen,
 * gibt einem Angreifer nichts, was er nicht schon hätte. Ohne frische
 * Bestätigung geht es nicht: Eine übernommene, alte Session darf den zweiten
 * Faktor NICHT ersetzen können.
 *
 * `totp_grace_until` bleibt bewusst unangetastet: Ein Admin ohne Frist ist ab
 * hier bis zum Abschluss der Neu-Einrichtung von den Admin-Flächen ausgesperrt.
 * Das ist gewollt — die Einrichtungsseite liegt außerhalb von /admin, der Weg
 * zurück ist zwei Minuten lang, und eine frisch geschenkte Kulanzfrist wäre
 * genau die Lücke, die die Zwei-Faktor-Pflicht aushebelt.
 */
export async function zweitFaktorNeuEinrichten(): Promise<{ ok: true } | Fehler> {
  const vor = await eingeloggt();
  if (!vor.ok) return vor;
  const { ctx } = vor;

  // Ohne aktiven zweiten Faktor gibt es nichts zurückzusetzen — dann ist der
  // normale Einrichtungsweg der richtige (und stepUpErfuellt wäre hier über die
  // Kulanzfrist erfüllbar, ohne dass je ein Code vorlag).
  if (!totpAktiv(ctx.user)) {
    return {
      ok: false,
      error:
        "Für dieses Konto ist keine Zwei-Faktor-Authentisierung eingerichtet. Sie können sie direkt einrichten.",
    };
  }

  if (!stepUpErfuellt({ user: ctx.user, session: ctx.session })) {
    return {
      ok: false,
      error: `Bitte bestätigen Sie zuerst Ihre Anmeldung mit einem Einmalcode oder einem Wiederherstellungscode. Die Bestätigung darf höchstens ${STEP_UP_MAX_ALTER_MINUTEN} Minuten alt sein.`,
    };
  }

  const grenze = await rateLimitPruefen(ctx);
  if (grenze) return grenze;

  // CAS auf isNotNull(totpConfirmedAt): Nur wer die Zeile wirklich von „aktiv"
  // auf „nicht eingerichtet" dreht, hat zurückgesetzt. Zwei parallele Aufrufe
  // löschen so nicht zweimal, und ein Aufruf, dem ein anderer Weg (CLI-Reset)
  // zuvorgekommen ist, meldet ehrlich, dass nichts mehr zu tun war.
  const zurueckgesetzt = await ctx.db
    .update(users)
    .set({ totpSecretEnc: null, totpConfirmedAt: null, totpLastStep: null })
    .where(
      and(
        eq(users.id, ctx.user.id),
        eq(users.tenantId, ctx.tenant.id),
        isNotNull(users.totpConfirmedAt)
      )
    )
    .returning({ id: users.id });

  if (zurueckgesetzt.length === 0) {
    return { ok: false, error: "Die Zwei-Faktor-Authentisierung ist bereits zurückgesetzt." };
  }

  // Die alten Wiederherstellungscodes gehören zum alten Secret und verfallen
  // mit ihm — sonst blieben sie als Zweitschlüssel zu einem Konto liegen,
  // dessen zweiter Faktor längst ein anderer ist.
  await ctx.db
    .delete(totpRecoveryCodes)
    .where(
      and(
        eq(totpRecoveryCodes.userId, ctx.user.id),
        eq(totpRecoveryCodes.tenantId, ctx.tenant.id)
      )
    );

  await protokoll(ctx, "auth.totp_neu_einrichtung");
  await benachrichtige(ctx, "neu_eingerichtet", new Date());

  return { ok: true };
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

/**
 * Sicherheits-Benachrichtigung an die Kontoadresse (Review #59, Befund 3).
 *
 * BEST EFFORT: Ein fehlgeschlagener Versand darf die Aktion selbst nicht
 * scheitern lassen — der zweite Faktor ist zu diesem Zeitpunkt bereits gesetzt
 * bzw. entfernt, ein Fehler hier würde dem Nutzer nur einen Abbruch vorspielen,
 * den es nicht gibt (CLAUDE.md: Nebeneffekte mit try/catch).
 *
 * Die Fehlermeldung wird NICHT ausgegeben: SMTP-Bibliotheken zitieren gern die
 * Empfängeradresse. Geloggt wird nur die Fehlerklasse — keine Adresse, kein
 * Konto (gleiche Regel wie in konto/email-change-actions.ts).
 */
async function benachrichtige(
  ctx: EingeloggterCtx,
  ereignis: ZweiFaktorEreignis,
  zeitpunkt: Date
): Promise<void> {
  try {
    await sendZweiFaktorAenderungEmail(ctx.user.email, ereignis, zeitpunkt, ANBIETER.email);
  } catch (fehler) {
    const klasse = fehler instanceof Error ? fehler.name : typeof fehler;
    console.error(`totp: Benachrichtigung fehlgeschlagen (${ereignis}, ${klasse})`);
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
