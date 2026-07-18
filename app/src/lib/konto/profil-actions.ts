/**
 * profil-actions.ts — Server Action für die öffentliche Identität eines
 * ROLLENTRÄGERS (Klarname + Funktion, Block J1).
 *
 * Muster wie notify-actions.ts: dünne Auth-Auflösung (Tenant aus Host, Session
 * aus Cookie), dann ein doppelt-gescoptes (eigene userId + Tenant) UPDATE. Das
 * Feld darf NUR das eigene Konto verändern — nie ein fremdes.
 *
 * Pseudonymitäts-Riegel (Gate-B Lens 2): Einen NICHT-leeren Klarnamen/eine
 * Funktion darf nur setzen, wer Rollenträger ist (mindestens eine Rolle ≠ `user`).
 * Bürger bleiben pseudonym — ein leeres Feld (Löschen) ist dagegen immer erlaubt,
 * damit ein herabgestufter Rollenträger seinen Namen jederzeit entfernen kann.
 *
 * Audit PII-FREI (bindend): der Klarname/die Funktion landen NIE in den
 * Audit-Metadaten — nur das Ereignis `profile.updated` mit der Liste der
 * geänderten FELDNAMEN.
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "@/db/client";
import { sessions, users, auditEvents } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes } from "@/lib/auth/roles";
import { istRollentraeger } from "@/lib/identity/anzeige";

type AuthContext = {
  tenant: { id: string; slug: string };
  userId: string;
  db: Db;
};

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

  return { tenant: { id: tenant.id, slug: tenant.slug }, userId: session.userId, db };
}

/**
 * Eingabe-Schema (serverseitige Grenzen, ADR-Spec J1):
 *   - displayName: 2..80 Zeichen NACH Trim, oder leer (→ Feld löschen).
 *   - funktion:    ≤ 80 Zeichen NACH Trim, oder leer.
 * Leerstring/Whitespace ⇒ null (Feld leeren). Getrimmt gespeichert.
 */
const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 80;
const FUNKTION_MAX = 80;

const profilSchema = z.object({
  displayName: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length === 0 || s.length >= DISPLAY_NAME_MIN, {
      message: `Der Name muss mindestens ${DISPLAY_NAME_MIN} Zeichen haben.`,
    })
    .refine((s) => s.length <= DISPLAY_NAME_MAX, {
      message: `Der Name darf höchstens ${DISPLAY_NAME_MAX} Zeichen haben.`,
    }),
  funktion: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= FUNKTION_MAX, {
      message: `Die Funktion darf höchstens ${FUNKTION_MAX} Zeichen haben.`,
    }),
});

export type ProfilSpeichernResult = {
  ok: boolean;
  error?: string;
  /** Gespeicherte Werte (getrimmt, null = geleert) — für die UI-Rückmeldung. */
  displayName?: string | null;
  funktion?: string | null;
};

/**
 * Setzt/aktualisiert/leert Klarname + Funktion des eigenen Kontos.
 *
 * @param input.displayName  Roh-Eingabe des Klarnamens (leer = löschen).
 * @param input.funktion     Roh-Eingabe der Funktion (leer = löschen).
 */
export async function profilSpeichern(input: {
  displayName: string;
  funktion: string;
}): Promise<ProfilSpeichernResult> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  const parsed = profilSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Eingabe ungültig.",
    };
  }

  const displayName = parsed.data.displayName.length > 0 ? parsed.data.displayName : null;
  const funktion = parsed.data.funktion.length > 0 ? parsed.data.funktion : null;

  // Pseudonymitäts-Riegel: einen NICHT-leeren Klarnamen/Funktion darf nur ein
  // Rollenträger setzen. Löschen (beide null) ist immer erlaubt. getUserRoleTypes
  // ist account-status-gefiltert → ein gesperrtes Konto erhält [] und kann nichts
  // Öffentliches setzen.
  if (displayName !== null || funktion !== null) {
    const roleTypes = await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId);
    if (!istRollentraeger(roleTypes)) {
      return {
        ok: false,
        error:
          "Ein öffentlicher Name ist nur für Rollenträgerinnen und Rollenträger " +
          "vorgesehen. Ihre Teilnahme als Bürgerin oder Bürger bleibt pseudonym.",
      };
    }
  }

  // Doppelt-gescoptes UPDATE (eigener User + Tenant); RETURNING als Treffer-Beleg.
  const updated = await ctx.db
    .update(users)
    .set({ displayName, funktion })
    .where(and(eq(users.tenantId, ctx.tenant.id), eq(users.id, ctx.userId)))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return { ok: false, error: "Benutzer nicht gefunden." };
  }

  // Audit PII-FREI: nur die Namen der geänderten Felder, NIE deren Werte.
  await ctx.db.insert(auditEvents).values({
    tenantId: ctx.tenant.id,
    actorType: "user",
    actorRef: ctx.userId,
    action: "profile.updated",
    targetType: "user",
    targetId: ctx.userId,
    metadata: { feldGeaendert: ["display_name", "funktion"] },
  });

  return { ok: true, displayName, funktion };
}
