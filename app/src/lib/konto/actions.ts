/**
 * actions.ts — Server Action für die Konto-Löschung (Recht auf Löschung,
 * Art. 17 DSGVO, H3).
 *
 * Dünner "use server"-Wrapper: Auth + Bestätigung prüfen, dann in die testbare
 * Kern-Logik (deleteKontoCore in delete.ts) hineinrufen. Kern-Logik + Konstante
 * leben bewusst in delete.ts (kein "use server"), damit sie direkt unit-/
 * integration-testbar sind und nicht-async-Exporte erlaubt sind.
 */

"use server";

import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { getTenantFromHost } from "@/lib/tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { deleteKontoCore, KONTO_LOESCHEN_BESTAETIGUNG } from "@/lib/konto/delete";

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

  const tokenHash = sha256Hex(rawToken);
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);

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
 * Server Action: Konto löschen.
 *
 * @param bestaetigung  Muss exakt "LÖSCHEN" sein (gegen versehentliche Löschung).
 * @returns { ok, error?, redirectTo? } — Client leitet bei Erfolg auf redirectTo.
 */
export async function kontoLoeschen(
  bestaetigung: string,
): Promise<{ ok: boolean; error?: string; redirectTo?: string }> {
  const ctx = await getAuthContext();
  if (!ctx) return { ok: false, error: "Nicht authentifiziert." };

  if (bestaetigung !== KONTO_LOESCHEN_BESTAETIGUNG) {
    return {
      ok: false,
      error: `Bitte geben Sie zur Bestätigung „${KONTO_LOESCHEN_BESTAETIGUNG}" ein.`,
    };
  }

  const result = await deleteKontoCore(ctx.db, ctx.tenant.id, ctx.userId);
  if (!result.ok) return result;

  // Session-Cookie löschen (Cookie-Store-API der Server Action).
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });

  return { ok: true, redirectTo: `/${ctx.tenant.slug}` };
}
