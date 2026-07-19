/**
 * interessenten/admin-actions.ts — Betreiber-Aktionen auf Leads (Block N3).
 *
 * Server Actions = eigenständige Endpoints → jede prüft super_admin serverseitig
 * (requireSuperAdminCtx, NICHT nur isAdmin: die tenant-freie Lead-Tabelle gehört
 * dem Plattform-Betreiber). Alle Schreibvorgänge sind atomar (UPDATE/DELETE ...
 * WHERE id RETURNING) und werden PII-frei auditiert (nur id/Status, NIE
 * Name/E-Mail/Nachricht).
 *
 * Die Leads sind tenant-frei → bewusst OHNE Tenant-Scope in der WHERE-Klausel.
 * Das Audit landet auf dem Betreiber-Tenant-Kontext (audit_events braucht eine
 * tenantId; wir nutzen den host-aufgelösten Tenant des eingeloggten super_admin).
 */

"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { interessenten, auditEvents, interessentStatusEnum } from "@/db/schema";
import { requireSuperAdminCtx } from "@/lib/auth/action-context";

const idSchema = z.string().uuid();
const statusSchema = z.enum(interessentStatusEnum.enumValues);

export interface AdminAktionResult {
  ok: boolean;
  error?: string;
}

/** Setzt den Bearbeitungs-Status eines Leads (super_admin, atomar). */
export async function interessentStatusSetzen(
  id: string,
  status: string
): Promise<AdminAktionResult> {
  const gate = await requireSuperAdminCtx();
  if (!gate.ok) return { ok: false, error: gate.error };
  const { ctx } = gate;

  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, error: "Ungültige ID." };
  const statusParsed = statusSchema.safeParse(status);
  if (!statusParsed.success) return { ok: false, error: "Ungültiger Status." };

  const updated = await ctx.db
    .update(interessenten)
    .set({ status: statusParsed.data })
    .where(eq(interessenten.id, idParsed.data))
    .returning({ id: interessenten.id });

  if (updated.length === 0) return { ok: false, error: "Interessent nicht gefunden." };

  // PII-frei: nur id + neuer Status (kein Name/E-Mail/Nachricht).
  await ctx.db.insert(auditEvents).values({
    tenantId: ctx.tenant.id,
    actorType: "admin",
    actorRef: ctx.userId,
    action: "interessent.status_changed",
    targetType: "interessent",
    targetId: idParsed.data,
    metadata: { newStatus: statusParsed.data },
  });

  return { ok: true };
}

/**
 * Hard-Delete eines Leads (super_admin). Kein Konto, keine pseudonyme
 * Verknüpfung → echtes Löschen ist zulässig (DSGVO-Löschung auf Anfrage).
 */
export async function interessentLoeschen(id: string): Promise<AdminAktionResult> {
  const gate = await requireSuperAdminCtx();
  if (!gate.ok) return { ok: false, error: gate.error };
  const { ctx } = gate;

  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, error: "Ungültige ID." };

  const deleted = await ctx.db
    .delete(interessenten)
    .where(eq(interessenten.id, idParsed.data))
    .returning({ id: interessenten.id });

  if (deleted.length === 0) return { ok: false, error: "Interessent nicht gefunden." };

  // PII-frei: nur die id.
  await ctx.db.insert(auditEvents).values({
    tenantId: ctx.tenant.id,
    actorType: "admin",
    actorRef: ctx.userId,
    action: "interessent.deleted",
    targetType: "interessent",
    targetId: idParsed.data,
    metadata: {},
  });

  return { ok: true };
}
