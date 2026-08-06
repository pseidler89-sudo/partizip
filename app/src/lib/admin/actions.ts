/**
 * actions.ts — Server Actions für die Rollen-Verwaltung (Achse B, Gate B).
 *
 * Dünne "use server"-Wrapper: lösen den Auth-Kontext über das ZENTRALE Gate auf
 * (@/lib/auth/action-context) und rufen dann in die testbare Kern-Logik
 * (assignRoleCore / revokeRoleCore in role-actions.ts).
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Admin-Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth;
 * die UI-Filterung ist nur Komfort).
 *
 * KEIN EIGENER SESSION-RESOLVER (Gate-B 2026-08-06, BLOCKER): Diese Datei hatte
 * eine eigene Kopie des Session-Lookups und kam damit an der Zwei-Faktor-Pflicht
 * (#59) vorbei. Der Kontext kommt jetzt ausschließlich aus requireAdmin*Ctx —
 * dort sitzt die Pflicht. Der Wächter-Test
 * lib/auth/__tests__/kein-eigener-session-resolver.test.ts hält das fest.
 */

"use server";

import { requireAdminStepUpCtx } from "@/lib/auth/action-context";
import { isDemoTenant } from "@/lib/demo/config";
import {
  assignRoleCore,
  revokeRoleCore,
  type AssignRoleInput,
  type RevokeRoleInput,
  type RoleActionResult,
} from "@/lib/admin/role-actions";

/**
 * SIDE-EFFECT-FENCE (Block I, Gate-B MAJOR): Rollen-Mutationen sind auf dem
 * Demo-Mandanten gesperrt. Der ephemere Demo-Admin dürfte sonst einem
 * PERSISTENTEN Konto eine kommune_admin-Rolle geben. Doppelt abgesichert:
 * dieser Fence verhindert die Rollen-Mutation, und /api/auth/request legt auf
 * dem Demo-Mandanten gar kein Konto mehr an (ephemere Sessions statt
 * Magic-Link) — beide zusammen halten die „jeden Morgen frisch + rein
 * ephemer"-Invariante. Fail-closed.
 */
const DEMO_ROLLEN_GESPERRT = "Im Demo-Mandanten werden Rollen nicht verändert.";

/** Server Action: Rolle zuweisen (auditiert, eskalationsgeschützt). */
export async function assignRole(input: AssignRoleInput): Promise<RoleActionResult> {
  // STEP-UP (#59): Rollenvergabe ist die Aktion, über die sich ein übernommenes
  // Konto selbst dauerhaft festsetzen könnte. Dafür verlangen wir eine frische
  // Bestätigung mit dem Einmalcode, nicht nur eine gültige Session.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  return assignRoleCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, input);
}

/** Server Action: Rolle entziehen (auditiert, letzter-Admin- + eskalationsgeschützt). */
export async function revokeRole(input: RevokeRoleInput): Promise<RoleActionResult> {
  // STEP-UP (#59): Rollenentzug ist die Kehrseite der Vergabe — wer ihn ohne
  // frische Bestätigung ausführen könnte, könnte den letzten anderen Admin
  // entfernen. Gleiche Schwelle wie assignRole.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  return revokeRoleCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, input);
}
