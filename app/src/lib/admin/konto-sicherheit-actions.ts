/**
 * konto-sicherheit-actions.ts — Server Actions der Konto-Sicherheit (Block K2):
 * Sitzungen beenden, Konto sperren/entsperren, Offboarding, Sperren per E-Mail.
 *
 * Dünne "use server"-Wrapper (Muster lib/admin/actions.ts): lösen den
 * Auth-Kontext über das ZENTRALE Gate auf (@/lib/auth/action-context),
 * validieren per zod und delegieren in die testbare Kern-Logik
 * (konto-sicherheit-core.ts).
 *
 * KEIN EIGENER SESSION-RESOLVER (Gate-B 2026-08-06, BLOCKER): Die frühere lokale
 * Kopie des Session-Lookups kam an der Zwei-Faktor-Pflicht (#59) vorbei —
 * ausgerechnet bei `offboarding`/`kontoSperren`, mit denen sich der legitime
 * Admin entrechten lässt. Wächter:
 * lib/auth/__tests__/kein-eigener-session-resolver.test.ts.
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Admin-Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth;
 * die UI-Filterung ist nur Komfort).
 *
 * SIDE-EFFECT-FENCE (Muster Block I): auf dem Demo-Mandanten sind alle
 * Konto-Mutationen gesperrt — der ephemere Demo-Admin darf keine persistenten
 * Konten sperren/offboarden oder deren Sitzungen beenden. Fail-closed.
 */

"use server";

import { z } from "zod";
import {
  requireAdminCtx,
  requireAdminStepUpCtx,
} from "@/lib/auth/action-context";
import { isDemoTenant } from "@/lib/demo/config";
import {
  sessionsBeendenCore,
  kontoSperrenCore,
  kontoEntsperrenCore,
  offboardingCore,
  kontoSperrenPerEmailCore,
  type KontoSicherheitResult,
} from "@/lib/admin/konto-sicherheit-core";

/**
 * SIDE-EFFECT-FENCE (analog DEMO_ROLLEN_GESPERRT in actions.ts): Konto-
 * Mutationen sind auf dem Demo-Mandanten gesperrt — der ephemere Demo-Admin
 * dürfte sonst PERSISTENTE Konten sperren oder deren Sitzungen beenden.
 * Fail-closed.
 */
const DEMO_KONTO_GESPERRT = "Im Demo-Mandanten werden Konten nicht verändert.";

const targetSchema = z.object({ targetUserId: z.string().uuid("Ungültige Konto-ID.") });

export type KontoSicherheitInput = { targetUserId: string };

/** Server Action: alle aktiven Sitzungen eines Kontos beenden (auditiert). */
export async function sessionsBeenden(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  // KEIN Step-up: Sitzungen beenden entzieht keine Rechte, sondern verlangt eine
  // neue Anmeldung — die betroffene Person kommt mit ihrem Magic-Link sofort
  // wieder herein. Umkehrbar, deshalb reicht das Basis-Gate.
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return sessionsBeendenCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/** Server Action: Konto sperren + alle Sitzungen beenden (auditiert, umkehrbar). */
export async function kontoSperren(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  // STEP-UP (#59): Sperren nimmt einem Konto SOFORT alle Rollen-Wirkung
  // (getUserRoleTypes filtert auf account_status='active') — ein übernommenes
  // Konto könnte damit den legitimen Admin entrechten und allein zurückbleiben.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return kontoSperrenCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/** Server Action: gesperrtes Konto entsperren (auditiert). */
export async function kontoEntsperren(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  // KEIN Step-up: Entsperren ist die WIEDERHERSTELLENDE Richtung — es gibt einem
  // Konto seine Rechte zurück, statt sie zu nehmen. Eine zusätzliche Hürde hier
  // erschwerte ausgerechnet die Korrektur eines Fehlgriffs.
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return kontoEntsperrenCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/** Server Action: Offboarding — alle Rollen + Sitzungen entfernen, Konto bleibt aktiv. */
export async function offboarding(
  rawInput: KontoSicherheitInput,
): Promise<KontoSicherheitResult> {
  // STEP-UP (#59): Offboarding ENTZIEHT alle Rollen — die Kehrseite von
  // assignRole, nur in einem Zug. Damit ließe sich der legitime Admin
  // entrechten; gleiche Schwelle wie revokeRole.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = targetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return offboardingCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data.targetUserId,
  );
}

/**
 * Server Action: Konto per E-Mail sperren (IR-Notfall — Bürger:in ohne Rolle,
 * die nicht in der Rollen-Liste steht). E-Mail-Auflösung tenant-scoped und
 * normalisiert im Core; nicht gefunden ⇒ generisch „Konto nicht gefunden.".
 */
export async function kontoSperrenPerEmail(
  targetEmail: string,
): Promise<KontoSicherheitResult> {
  // STEP-UP (#59): Dieselbe Wirkung wie kontoSperren, nur über die E-Mail als
  // Adressierung — sie darf nicht die niedrigere Hürde sein, sonst wäre das
  // Step-up von kontoSperren über diesen Weg umgehbar.
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_KONTO_GESPERRT };

  const parsed = z.string().trim().min(1, "Bitte eine E-Mail-Adresse angeben.").max(320)
    .safeParse(targetEmail);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return kontoSperrenPerEmailCore(
    ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, parsed.data,
  );
}
