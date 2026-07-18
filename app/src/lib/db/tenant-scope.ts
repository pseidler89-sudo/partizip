/**
 * tenant-scope.ts — Tenant-gebundene DB-Zugriffe
 *
 * ZWECK: Alle fachlichen Queries MÜSSEN tenant_id in der WHERE-Klausel haben.
 * Direkter Zugriff auf das rohe `db`-Objekt in Route-Handlern ist per
 * Konvention verboten. Stattdessen immer scopedDb(tenantId) verwenden.
 *
 * DESIGN-ENTSCHEIDUNG: scopedDb gibt einen Namespace-Typ zurück mit
 * Methoden je Aggregat. Jede Methode injiziert tenant_id automatisch in
 * alle WHERE-Bedingungen. So ist es strukturell unmöglich, tenant_id
 * versehentlich wegzulassen.
 *
 * Hinzufügen neuer Aggregat-Methoden: hier erweitern, NICHT direkt db nutzen.
 */

import { and, eq, gt, isNull, count, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users, authTokens, sessions, anliegen } from "@/db/schema";
import { normalizeEmail } from "@/lib/auth/email";

export type ScopedDb = ReturnType<typeof scopedDb>;

export function scopedDb(db: Db, tenantId: string) {
  return {
    // -------------------------------------------------------------------------
    // users
    // -------------------------------------------------------------------------
    users: {
      findByEmail: async (email: string) => {
        // Defense-in-Depth (J2a): Input kanonisch, auch wenn Aufrufer es schon
        // getan hat — der Bestand ist normalisiert, eq reicht (Index als Netz).
        const rows = await db
          .select()
          .from(users)
          .where(and(eq(users.tenantId, tenantId), eq(users.email, normalizeEmail(email))))
          .limit(1);
        return rows[0] ?? null;
      },

      findById: async (userId: string) => {
        const rows = await db
          .select()
          .from(users)
          .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
          .limit(1);
        return rows[0] ?? null;
      },

      create: async (email: string, minAgeConfirmedAt: Date | null) => {
        const [row] = await db
          .insert(users)
          .values({
            tenantId,
            email: normalizeEmail(email),
            minAgeConfirmedAt,
          })
          .returning();
        return row;
      },
    },

    // -------------------------------------------------------------------------
    // auth_tokens
    // -------------------------------------------------------------------------
    authTokens: {
      /** Zählt Magic-Link-Requests für (tenant, email) in den letzten `windowMin` Minuten */
      countRecent: async (email: string, windowMin: number): Promise<number> => {
        const since = new Date(Date.now() - windowMin * 60 * 1000);
        const rows = await db
          .select({ n: count() })
          .from(authTokens)
          .where(
            and(
              eq(authTokens.tenantId, tenantId),
              eq(authTokens.email, normalizeEmail(email)),
              gt(authTokens.createdAt, since)
            )
          );
        return rows[0]?.n ?? 0;
      },

      create: async (opts: {
        email: string;
        tokenHash: string;
        expiresAt: Date;
        purpose?: string;
      }) => {
        const [row] = await db
          .insert(authTokens)
          .values({
            tenantId,
            email: normalizeEmail(opts.email),
            tokenHash: opts.tokenHash,
            purpose: opts.purpose ?? "login",
            expiresAt: opts.expiresAt,
          })
          .returning();
        return row;
      },

      /**
       * Atomares Einlösen — CAS: UPDATE ... WHERE tenant_id = ? AND consumed_at IS NULL AND expires_at > now().
       * Gibt den Token-Datensatz zurück wenn erfolgreich, sonst null.
       * MIN3: tenantId in WHERE-Klausel aufgenommen (verhindert Cross-Tenant-Consume).
       */
      consume: async (tokenHash: string) => {
        const now = new Date();
        const rows = await db
          .update(authTokens)
          .set({ consumedAt: now })
          .where(
            and(
              eq(authTokens.tenantId, tenantId),
              eq(authTokens.tokenHash, tokenHash),
              isNull(authTokens.consumedAt),
              gt(authTokens.expiresAt, now)
            )
          )
          .returning();
        return rows[0] ?? null;
      },

      /**
       * H3: Markiert alle übrigen unverbrauchten Tokens für (tenant_id, email)
       * als consumed — AUSSER dem gerade eingelösten Token.
       * Wird nach erfolgreichem Verify aufgerufen.
       */
      invalidateOtherTokens: async (email: string, exceptTokenHash: string) => {
        const now = new Date();
        await db
          .update(authTokens)
          .set({ consumedAt: now })
          .where(
            and(
              eq(authTokens.tenantId, tenantId),
              eq(authTokens.email, normalizeEmail(email)),
              isNull(authTokens.consumedAt),
              ne(authTokens.tokenHash, exceptTokenHash)
            )
          );
      },

      /** Lädt einen Token ohne ihn zu konsumieren (für Fehlerdiagnose).
       * MIN3: tenantId in WHERE-Klausel aufgenommen. */
      findByHash: async (tokenHash: string) => {
        const rows = await db
          .select()
          .from(authTokens)
          .where(
            and(
              eq(authTokens.tenantId, tenantId),
              eq(authTokens.tokenHash, tokenHash)
            )
          )
          .limit(1);
        return rows[0] ?? null;
      },
    },

    // -------------------------------------------------------------------------
    // sessions
    // -------------------------------------------------------------------------
    sessions: {
      create: async (opts: {
        userId: string;
        tokenHash: string;
        expiresAt: Date;
      }) => {
        const [row] = await db
          .insert(sessions)
          .values({
            tenantId,
            userId: opts.userId,
            tokenHash: opts.tokenHash,
            expiresAt: opts.expiresAt,
          })
          .returning();
        return row;
      },

      /**
       * Validiert eine Session: muss zum Tenant gehören, darf nicht revoziert
       * und nicht abgelaufen sein.
       */
      findValid: async (tokenHash: string) => {
        const now = new Date();
        const rows = await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.tenantId, tenantId),
              eq(sessions.tokenHash, tokenHash),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, now)
            )
          )
          .limit(1);
        return rows[0] ?? null;
      },

      revoke: async (tokenHash: string) => {
        await db
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.tenantId, tenantId),
              eq(sessions.tokenHash, tokenHash)
            )
          );
      },
    },

    // -------------------------------------------------------------------------
    // anliegen (M8)
    // -------------------------------------------------------------------------
    anliegen: {
      findAll: async () => {
        return db
          .select()
          .from(anliegen)
          .where(eq(anliegen.tenantId, tenantId));
      },

      findByCode: async (trackingCode: string) => {
        const rows = await db
          .select()
          .from(anliegen)
          .where(
            and(
              eq(anliegen.tenantId, tenantId),
              eq(anliegen.trackingCode, trackingCode)
            )
          )
          .limit(1);
        return rows[0] ?? null;
      },

      isCodeUnique: async (trackingCode: string): Promise<boolean> => {
        const rows = await db
          .select({ id: anliegen.id })
          .from(anliegen)
          .where(eq(anliegen.trackingCode, trackingCode))
          .limit(1);
        return rows.length === 0;
      },
    },
  };
}
