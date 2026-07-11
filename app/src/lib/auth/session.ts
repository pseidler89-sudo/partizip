/**
 * session.ts — Session-Validierung
 *
 * Cookie-Name: partizip_session
 * Cookie-Attribute: HttpOnly, SameSite=Lax, Path=/, Secure (nur HTTPS)
 * KEINE Domain-Angabe → host-only Cookie (gilt nur für die exakte Subdomain)
 *
 * SICHERHEITS-DESIGN (ADR-006):
 *   1. Cookie-Token hashen → SHA-256
 *   2. Session in DB laden (nicht revoziert, nicht abgelaufen)
 *   3. session.tenant_id === host-Tenant.id prüfen
 *      (verhindert Cross-Tenant-Session-Nutzung auch wenn Cookie geleakt)
 *   4. User laden (im selben Tenant)
 */

import type { NextRequest } from "next/server";
import { sha256Hex } from "./crypto";
import { createDb } from "@/db/client";
import { scopedDb } from "@/lib/db/tenant-scope";
import type { TenantRow } from "@/lib/tenant";

export const SESSION_COOKIE_NAME = "partizip_session";

export type SessionContext = {
  userId: string;
  tenantId: string;
  sessionId: string;
};

/**
 * Validiert den Session-Cookie für den gegebenen Tenant.
 * Gibt null zurück wenn kein Cookie, ungültig, abgelaufen, oder Tenant stimmt nicht.
 */
export async function validateSession(
  request: NextRequest,
  tenant: TenantRow
): Promise<SessionContext | null> {
  const rawToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const tokenHash = sha256Hex(rawToken);

  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip";
  const db = createDb(databaseUrl);
  const scoped = scopedDb(db, tenant.id);

  // findValid prüft tenant_id, revokedAt IS NULL, expiresAt > now()
  const session = await scoped.sessions.findValid(tokenHash);
  if (!session) return null;

  return {
    userId: session.userId,
    tenantId: session.tenantId,
    sessionId: session.id,
  };
}

/**
 * Erzeugt den Set-Cookie-Header-Wert für eine neue Session.
 * B2: Secure wird IMMER gesetzt in production (NODE_ENV=production),
 * zusätzlich auch wenn der Request über HTTPS erkannt wird.
 * Kein Domain= → host-only Cookie.
 */
export function buildSessionCookieHeader(
  rawToken: string,
  expiresAt: Date,
  isSecure: boolean
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  // Secure: immer in production, zusätzlich wenn Request HTTPS
  if (process.env.NODE_ENV === "production" || isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Erzeugt den Set-Cookie-Header-Wert um den Session-Cookie zu löschen.
 */
export function buildClearSessionCookieHeader(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
  ];
  // Konsistent zum Session-Cookie (Gate-B-Nebenbefund): Browser verlangen fuer
  // das Ueberschreiben von Secure-Cookies teils ebenfalls Secure.
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}
