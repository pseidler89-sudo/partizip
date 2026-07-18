/**
 * email-change-core.ts — Kern-Logik „E-Mail-Adresse ändern" (Block J2b).
 *
 * BEWUSST OHNE "use server": reine, testbare Kern-Logik (Anfordern + Prüfen +
 * Bestätigen). Die dünnen "use server"-Wrapper (Auth-/Tenant-/Demo-Auflösung,
 * konkreter Mailversand) liegen in email-change-actions.ts.
 *
 * SICHERHEITSMODELL (Spec J2b, bindend):
 *   1. Anfordern nur aus aktiver, eingeloggter Session (Action-Kontext).
 *      Demo-Tenant: fail-closed Fence — KEINE Mail, KEIN Token, KEINE Änderung.
 *   2. Bestätigung beweist Kontrolle über die NEUE Adresse: Token (purpose
 *      'email_change') geht ausschließlich an die neue Adresse, TTL wie Login,
 *      single-use via CAS-consume.
 *   3. Kein Adress-Oracle: Antwort der Anforderung ist IMMER neutral. Ist die
 *      Ziel-Adresse im Tenant bereits vergeben → KEINE Mail, Antwort identisch.
 *   4. Bestätigen erfordert die Session DESSELBEN Users (userId-Bindung am
 *      Token). GET prüft nur (kein Verbrauch), POST konsumiert.
 *   5. Konsum atomar (CAS) → account_status erneut prüfen → UPDATE users.email;
 *      der funktionale Unique-Index ist das Netz gegen die Race auf eine
 *      zwischenzeitlich vergebene Ziel-Adresse (23505 → freundlicher Fehler,
 *      Token bleibt konsumiert, kein Retry-Oracle).
 *   6. Nach Erfolg: Info-Mail an die ALTE Adresse (best-effort), alle offenen
 *      Login-Tokens der alten Adresse + weitere email_change-Tokens des Users
 *      invalidieren, Audit PII-frei.
 *   8. Pseudonym-Stabilität: voter_ref/creator_ref hashen die user_id, NICHT
 *      die E-Mail → Stimmabgaben/Anliegen bleiben von der Änderung unberührt
 *      (in email-change.test.ts explizit abgesichert).
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users, auditEvents } from "@/db/schema";
import { scopedDb } from "@/lib/db/tenant-scope";
import { emailSchema, normalizeEmail } from "@/lib/auth/email";
import { generateRawToken, sha256Hex } from "@/lib/auth/crypto";
import { istPgFehler, PG_UNIQUE_VIOLATION } from "@/lib/db/pg-errors";
import {
  writeEmailChangeRateLimitEvents,
  checkEmailChangeRateLimit,
} from "@/lib/auth/rate-limit";

/** purpose-Wert der Änderungs-Tokens (Login-Tokens tragen 'login'). */
export const EMAIL_CHANGE_PURPOSE = "email_change";

function ttlMin(): number {
  return Number(process.env.MAGIC_LINK_TTL_MIN ?? "15");
}

// ---------------------------------------------------------------------------
// Anfordern
// ---------------------------------------------------------------------------

export type AnfordernErgebnis =
  /** Ziel-Adresse ungültig (Format) — kein Oracle, das ist die eigene Eingabe. */
  | { kind: "invalid" }
  /** Neu == aktuelle Adresse — neutraler Hinweis ohne Mail/Token. */
  | { kind: "same" }
  /** Rate-Limit überschritten — nach außen neutral. */
  | { kind: "rate_limited" }
  /** Demo-Fence: auf dem Demo-Mandanten passiert nichts (fail-closed). */
  | { kind: "demo_blocked" }
  /**
   * Neutralfall: nach außen IMMER identisch. `mailVersendet` ist rein intern
   * (Tests/Audit) — verrät nach außen nichts (die Action mappt beide auf denselben
   * Text). true = Token angelegt + Mail an die neue Adresse; false = Ziel bereits
   * vergeben (oder Konto nicht aktiv), keine Mail.
   */
  | { kind: "neutral"; mailVersendet: boolean };

/**
 * Fordert eine E-Mail-Änderung an. Legt bei freier Ziel-Adresse einen
 * email_change-Token an und ruft `sendBestaetigungsMail` mit dem Roh-Token
 * (die Action baut daraus die Bestätigungs-URL). Bei vergebener Ziel-Adresse:
 * keine Mail, identischer Neutral-Ausgang (kein Adress-Oracle).
 */
export async function emailAenderungAnfordernCore(
  db: Db,
  opts: {
    tenantId: string;
    userId: string;
    neueEmailRaw: string;
    istDemo: boolean;
    ipAddress: string | null;
    /** Versendet die Bestätigungs-Mail an die NEUE Adresse (Roh-Token als Credential). */
    sendBestaetigungsMail: (neueEmail: string, rawToken: string) => Promise<void>;
    now?: Date;
  },
): Promise<AnfordernErgebnis> {
  // (1) Demo-Fence — fail-closed: keine Mails/Kontoänderungen aus ephemeren
  //     Demo-Sessions. Vor allem anderen, damit auch keine Rate-Limit-Events
  //     oder Timing-Spuren entstehen.
  if (opts.istDemo) return { kind: "demo_blocked" };

  // (2) Eingabe validieren (normalisiert VOR der Prüfung).
  const parsed = emailSchema.safeParse(opts.neueEmailRaw);
  if (!parsed.success) return { kind: "invalid" };
  const neueEmail = parsed.data; // kanonisch (trim+lower)

  const now = opts.now ?? new Date();
  const scoped = scopedDb(db, opts.tenantId);

  // Aktuellen User laden. Defense-in-Depth: ein (trotz gültiger Session)
  // gesperrtes/gelöschtes Konto darf keine Änderung auslösen — neutraler
  // Ausgang ohne Mail (kein Status-Oracle).
  const user = await scoped.users.findById(opts.userId);
  if (!user || user.accountStatus !== "active") {
    return { kind: "neutral", mailVersendet: false };
  }

  // (Gleichheits-Check) neu == alt → neutraler Hinweis, keine Mail, kein Token.
  if (normalizeEmail(user.email) === neueEmail) return { kind: "same" };

  // (7) Rate-Limit: Events IMMER vor der Prüfung schreiben (Timing).
  await writeEmailChangeRateLimitEvents(db, {
    tenantId: opts.tenantId,
    userId: opts.userId,
    neueEmail,
    ipAddress: opts.ipAddress,
  });
  const rl = await checkEmailChangeRateLimit(db, {
    tenantId: opts.tenantId,
    userId: opts.userId,
    neueEmail,
    ipAddress: opts.ipAddress,
  });
  if (!rl.allowed) return { kind: "rate_limited" };

  // Token-Bytes IMMER erzeugen (Timing-Angleichung frei vs. vergeben) —
  // im Vergeben-Zweig verworfen.
  const rawToken = generateRawToken();
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(now.getTime() + ttlMin() * 60 * 1000);

  // (3) Verfügbarkeit der Ziel-Adresse — NUR für den Mail-Entscheid, Antwort
  //     bleibt neutral. Vergeben → keine Mail (auch keine Info-Mail an das Ziel:
  //     Spam-/Belästigungsvektor), kein Token.
  const belegt = await scoped.users.findByEmail(neueEmail);
  if (belegt) return { kind: "neutral", mailVersendet: false };

  // Freie Ziel-Adresse: nur EIN offenes Ziel je User — alte offene
  // email_change-Tokens des Users entwerten, dann neu anlegen.
  await scoped.authTokens.invalidateEmailChangeTokensForUser(opts.userId);
  await scoped.authTokens.create({
    email: neueEmail,
    tokenHash,
    expiresAt,
    purpose: EMAIL_CHANGE_PURPOSE,
    userId: opts.userId,
  });

  await opts.sendBestaetigungsMail(neueEmail, rawToken);

  // Audit PII-frei: kein E-Mail-String in metadata.
  await db.insert(auditEvents).values({
    tenantId: opts.tenantId,
    actorType: "user",
    actorRef: opts.userId,
    action: "konto.email_change_requested",
    targetType: "user",
    targetId: opts.userId,
    metadata: {},
  });

  return { kind: "neutral", mailVersendet: true };
}

// ---------------------------------------------------------------------------
// Prüfen (GET — reiner Lesezugriff, KEIN Verbrauch)
// ---------------------------------------------------------------------------

export type PruefErgebnis =
  | { kind: "valid"; neueEmail: string }
  | { kind: "invalid" }
  | { kind: "wrong_account" }
  | { kind: "used" }
  | { kind: "expired" };

/**
 * Prüft einen email_change-Token OHNE ihn zu verbrauchen (für die GET-Seite).
 * Die neue Adresse wird nur bei passendem Session-User zurückgegeben.
 */
export async function emailAenderungPruefenCore(
  db: Db,
  opts: {
    tenantId: string;
    sessionUserId: string;
    tokenRaw: string;
    now?: Date;
  },
): Promise<PruefErgebnis> {
  const now = opts.now ?? new Date();
  const scoped = scopedDb(db, opts.tenantId);
  const tokenHash = sha256Hex(opts.tokenRaw);

  const token = await scoped.authTokens.findByHash(tokenHash);
  if (!token || token.purpose !== EMAIL_CHANGE_PURPOSE) return { kind: "invalid" };
  // Bindung an denselben User (kein Verbrauch, kein Adress-Leak an Fremde).
  if (token.userId !== opts.sessionUserId) return { kind: "wrong_account" };
  if (token.consumedAt !== null) return { kind: "used" };
  if (token.expiresAt <= now) return { kind: "expired" };
  return { kind: "valid", neueEmail: token.email };
}

// ---------------------------------------------------------------------------
// Bestätigen (POST — atomarer Konsum + Wechsel)
// ---------------------------------------------------------------------------

export type BestaetigenErgebnis =
  | { kind: "success"; neueEmail: string }
  | { kind: "invalid" }
  | { kind: "wrong_account" }
  | { kind: "used" }
  | { kind: "expired" }
  /** Ziel-Adresse wurde zwischenzeitlich vergeben (23505) — Token bleibt konsumiert. */
  | { kind: "taken" }
  /** Konto nicht aktiv (gesperrt/gelöscht). */
  | { kind: "locked" }
  | { kind: "demo_blocked" };

/**
 * Konsumiert den Token atomar und wechselt die E-Mail-Adresse (Punkt 5/6).
 */
export async function emailAenderungBestaetigenCore(
  db: Db,
  opts: {
    tenantId: string;
    sessionUserId: string;
    tokenRaw: string;
    istDemo: boolean;
    /** Info-Mail an die ALTE Adresse (best-effort, außerhalb des kritischen Pfads). */
    sendInfoMailAnAlt: (alteEmail: string) => Promise<void>;
    now?: Date;
  },
): Promise<BestaetigenErgebnis> {
  // (1) Demo-Fence — fail-closed.
  if (opts.istDemo) return { kind: "demo_blocked" };

  const now = opts.now ?? new Date();
  const scoped = scopedDb(db, opts.tenantId);
  const tokenHash = sha256Hex(opts.tokenRaw);

  // Laden für Diagnose + User-Bindung (vor dem Verbrauch: fremder User darf
  // den Token NICHT konsumieren, sondern soll sich richtig anmelden).
  const token = await scoped.authTokens.findByHash(tokenHash);
  if (!token || token.purpose !== EMAIL_CHANGE_PURPOSE) return { kind: "invalid" };
  if (token.userId !== opts.sessionUserId) return { kind: "wrong_account" };

  // (5) Atomarer CAS-Konsum (single-use, tenant-scoped).
  const consumed = await scoped.authTokens.consume(tokenHash);
  if (!consumed) {
    if (token.consumedAt !== null) return { kind: "used" };
    if (token.expiresAt <= now) return { kind: "expired" };
    return { kind: "invalid" };
  }

  const neueEmail = normalizeEmail(consumed.email);

  // Konto erneut prüfen (Sperre muss auch hier wirken). Token bereits konsumiert.
  const user = await scoped.users.findById(opts.sessionUserId);
  if (!user) return { kind: "invalid" };
  if (user.accountStatus !== "active") return { kind: "locked" };
  const alteEmail = normalizeEmail(user.email);

  // (5) Kanonischer Wechsel. Der funktionale Unique-Index
  //     (users_tenant_email_lower_unique) ist das Netz gegen die Race, falls die
  //     Ziel-Adresse zwischen Anforderung und Bestätigung vergeben wurde: 23505
  //     → freundlicher Fehler, Token bleibt konsumiert (kein Retry-Oracle).
  //     Pseudonym-Stabilität: voter_ref/creator_ref hashen user.id, NICHT die
  //     E-Mail → Stimmen/Anliegen bleiben unberührt (nur users.email ändert sich).
  try {
    const updated = await db
      .update(users)
      .set({ email: neueEmail })
      .where(and(eq(users.tenantId, opts.tenantId), eq(users.id, opts.sessionUserId)))
      .returning({ id: users.id });
    if (updated.length === 0) return { kind: "invalid" };
  } catch (err) {
    if (istPgFehler(err, PG_UNIQUE_VIOLATION)) return { kind: "taken" };
    throw err;
  }

  // (6b) Offene Login-Links an die ALTE Adresse entwerten (Kontoübergabe) +
  //      weitere email_change-Tokens des Users (andere Ziele) entwerten.
  await scoped.authTokens.invalidateAllOpenTokensForEmail(alteEmail);
  await scoped.authTokens.invalidateEmailChangeTokensForUser(opts.sessionUserId);

  // (6d) Audit PII-frei (KEINE Adressen in metadata).
  await db.insert(auditEvents).values({
    tenantId: opts.tenantId,
    actorType: "user",
    actorRef: opts.sessionUserId,
    action: "konto.email_geaendert",
    targetType: "user",
    targetId: opts.sessionUserId,
    metadata: {},
  });

  // (6a) Info-Mail an die ALTE Adresse — best-effort, Fehler dürfen den bereits
  //      vollzogenen Wechsel nicht zurücknehmen.
  try {
    await opts.sendInfoMailAnAlt(alteEmail);
  } catch {
    // bewusst verschluckt (Versand ist nicht kritisch für den Wechsel).
  }

  return { kind: "success", neueEmail };
}
