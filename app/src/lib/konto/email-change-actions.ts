/**
 * email-change-actions.ts — Server Actions „E-Mail-Adresse ändern" (Block J2b).
 *
 * Dünne "use server"-Wrapper um die testbare Kern-Logik (email-change-core.ts):
 *   - Origin-Check als Defense-in-Depth (J2b-MIN3, Muster H1 der Auth-Routen),
 *   - Auth-Kontext (Tenant aus Host, Session aus Cookie),
 *   - Demo-Fence (isDemoTenant → an den Kern durchgereicht, fail-closed),
 *   - konkreter Mailversand (Bestätigungs-Mail an NEU, Info-Mail an ALT) —
 *     via after() NACH der Antwort (Timing-Invariante, s. email-change-core.ts),
 *   - Mapping der Kern-Ergebnisse auf „Sie"-Texte für die UI.
 *
 * "use server"-Datei → exportiert AUSSCHLIESSLICH Server Actions.
 */

"use server";

import { after } from "next/server";
import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { clientIpFromForwardedFor } from "@/lib/client-ip";
import { isDemoTenant } from "@/lib/demo/config";
import { istSameOrigin } from "@/lib/auth/origin";
import { ANBIETER } from "@/lib/legal/anbieter";
import {
  sendEmailChangeConfirmationEmail,
  sendEmailChangedInfoEmail,
} from "@/lib/auth/mail";
import {
  emailAenderungAnfordernCore,
  emailAenderungBestaetigenCore,
} from "@/lib/konto/email-change-core";

/**
 * Neutrale Antwort der Anforderung — für ALLE nicht-Fehler-Ausgänge identisch
 * (Mail versandt, Ziel vergeben, Rate-Limit, Demo-Fence). Kein Adress-Oracle.
 */
const NEUTRALE_ANTWORT =
  "Falls die Änderung möglich ist, haben wir eine Bestätigungs-Mail an die " +
  "neue Adresse geschickt. Bitte prüfen Sie das Postfach der neuen Adresse.";

type AuthContext = {
  tenant: { id: string; slug: string };
  userId: string;
  db: Db;
  host: string;
  proto: string;
  ipAddress: string | null;
};

/**
 * J2b-MIN3: Origin-Check als Defense-in-Depth am Anfang BEIDER Actions (Muster
 * „H1" aus /api/auth/request + /api/auth/verify). Next prüft Server-Action-
 * Origins zwar selbst, wir verlassen uns nicht allein darauf.
 * true = Verstoß (Aufrufer antwortet mit generischem Fehler).
 */
async function originVerletzt(): Promise<boolean> {
  const headerStore = await headers();
  return !istSameOrigin(headerStore.get("origin"), headerStore.get("host"));
}

/**
 * Verlegt den Mail-Versand HINTER die Antwort (Gate-B MAJOR, Timing-Invariante):
 * bevorzugt via Next.js after() (läuft nach dem Senden der Response); außerhalb
 * eines Request-Scopes (z. B. Tests) Fallback auf fire-and-forget. Fehler werden
 * PII-frei geloggt (KEINE Adresse — Fehlermeldungen von SMTP-Bibliotheken können
 * Empfänger enthalten, deshalb nur die Fehlerklasse) und verändern die neutrale
 * Antwort nie.
 */
function versandNachAntwort(task: () => Promise<unknown>): void {
  const sicher = async () => {
    try {
      await task();
    } catch (err) {
      const klasse = err instanceof Error ? err.name : typeof err;
      console.error(`email-change: Mail-Versand fehlgeschlagen (${klasse})`);
    }
  };
  try {
    after(sicher);
  } catch {
    // Kein Request-Scope (z. B. Vitest): best-effort im Hintergrund.
    void sicher();
  }
}

async function getAuthContext(): Promise<AuthContext | null> {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant) return null;

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);

  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) return null;

  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  const ipAddress = clientIpFromForwardedFor(headerStore.get("x-forwarded-for"));

  return {
    tenant: { id: tenant.id, slug: tenant.slug },
    userId: session.userId,
    db,
    host,
    proto,
    ipAddress,
  };
}

export type EmailAenderungAnfordernResult = {
  ok: boolean;
  message?: string;
  error?: string;
};

/**
 * Server Action: E-Mail-Änderung anfordern. Neutrale Antwort in allen
 * nicht-Eingabefehler-Fällen (kein Adress-Oracle).
 */
export async function emailAenderungAnfordern(
  neueEmail: string,
): Promise<EmailAenderungAnfordernResult> {
  // J2b-MIN3: Origin-Check vor allem anderen — generischer Fehler, kein Detail.
  if (await originVerletzt()) {
    return { ok: false, error: "Diese Anfrage konnte nicht verarbeitet werden." };
  }

  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const istDemo = isDemoTenant(ctx.tenant.slug);

  const ergebnis = await emailAenderungAnfordernCore(ctx.db, {
    tenantId: ctx.tenant.id,
    userId: ctx.userId,
    neueEmailRaw: neueEmail,
    istDemo,
    ipAddress: ctx.ipAddress,
    // Gate-B MAJOR (Timing): Callback registriert den Versand nur — der
    // eigentliche SMTP-Versand läuft via after() NACH der Antwort und kann
    // die Antwortzeit (frei vs. vergeben) nicht beeinflussen.
    sendBestaetigungsMail: async (adresse, rawToken) => {
      const url = `${ctx.proto}://${ctx.host}/${ctx.tenant.slug}/konto/email-bestaetigen?token=${rawToken}`;
      versandNachAntwort(() => sendEmailChangeConfirmationEmail(adresse, url));
    },
  });

  switch (ergebnis.kind) {
    case "invalid":
      return { ok: false, error: "Bitte geben Sie eine gültige E-Mail-Adresse ein." };
    case "same":
      return { ok: false, error: "Das ist bereits Ihre aktuelle E-Mail-Adresse." };
    // demo_blocked, rate_limited und neutral (Mail ODER vergeben) sind nach
    // außen IDENTISCH — kein Oracle über Existenz/Fence/Limit.
    case "demo_blocked":
    case "rate_limited":
    case "neutral":
    default:
      return { ok: true, message: NEUTRALE_ANTWORT };
  }
}

export type EmailAenderungBestaetigenResult = {
  ok: boolean;
  code?: string;
  error?: string;
};

/**
 * Server Action: E-Mail-Änderung bestätigen (POST konsumiert). Erfordert die
 * Session DESSELBEN Users; der Kern bindet den Token an dessen user_id.
 */
export async function emailAenderungBestaetigen(
  tokenRaw: string,
): Promise<EmailAenderungBestaetigenResult> {
  // J2b-MIN3: Origin-Check vor allem anderen — generischer Fehler, kein Detail.
  if (await originVerletzt()) {
    return {
      ok: false,
      code: "INVALID",
      error: "Diese Anfrage konnte nicht verarbeitet werden.",
    };
  }

  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, code: "UNAUTHENTICATED", error: "Nicht authentifiziert." };

  const istDemo = isDemoTenant(ctx.tenant.slug);

  const ergebnis = await emailAenderungBestaetigenCore(ctx.db, {
    tenantId: ctx.tenant.id,
    sessionUserId: ctx.userId,
    tokenRaw,
    istDemo,
    // Best-effort (Spec 6a) — ebenfalls via after() hinter die Antwort verlegt
    // (kein Sicherheitsgrund, aber gleicher Mechanismus: SMTP nie im Antwortpfad).
    sendInfoMailAnAlt: async (alteEmail) => {
      versandNachAntwort(() => sendEmailChangedInfoEmail(alteEmail, ANBIETER.email));
    },
  });

  switch (ergebnis.kind) {
    case "success":
      return { ok: true };
    case "wrong_account":
      return {
        ok: false,
        code: "WRONG_ACCOUNT",
        error:
          "Dieser Bestätigungslink gehört zu einem anderen Konto. Bitte melden " +
          "Sie sich mit dem richtigen Konto an und öffnen Sie den Link erneut.",
      };
    case "used":
      return {
        ok: false,
        code: "USED",
        error: "Dieser Link wurde bereits verwendet.",
      };
    case "expired":
      return {
        ok: false,
        code: "EXPIRED",
        error: "Dieser Link ist abgelaufen. Bitte fordern Sie die Änderung erneut an.",
      };
    case "taken":
      return {
        ok: false,
        code: "TAKEN",
        error:
          "Diese E-Mail-Adresse ist inzwischen vergeben. Bitte fordern Sie die " +
          "Änderung mit einer anderen Adresse erneut an.",
      };
    // locked/demo_blocked/invalid → generischer Text (kein Status-Oracle).
    case "locked":
    case "demo_blocked":
    case "invalid":
    default:
      return { ok: false, code: "INVALID", error: "Dieser Link ist ungültig." };
  }
}
