/**
 * appointment-actions.ts — Server Actions der Vier-Augen-Verifier-Ernennung
 * (Block K3): vorschlagen, entscheiden (bestätigen/ablehnen), zurückziehen.
 *
 * Dünne "use server"-Wrapper (Muster lib/admin/actions.ts / konto-sicherheit-
 * actions.ts): lösen den Auth-Kontext über das ZENTRALE Gate auf
 * (@/lib/auth/action-context), validieren per zod und delegieren in die testbare
 * Kern-Logik (appointment-core.ts).
 *
 * KEIN EIGENER SESSION-RESOLVER (Gate-B 2026-08-06, BLOCKER): Die frühere lokale
 * Kopie des Session-Lookups kam an der Zwei-Faktor-Pflicht (#59) vorbei. Wächter:
 * lib/auth/__tests__/kein-eigener-session-resolver.test.ts.
 *
 * Gate-B: Jede Server Action ist ein eigenständiger Endpoint → prüft Auth +
 * Admin-Rolle + Tenant-Isolierung + Eskalationsgrenze ERNEUT (Defense in Depth;
 * die UI-Filterung ist nur Komfort).
 *
 * SoD: `allowSelfApproval` wird AUSSCHLIESSLICH serverseitig über
 * isSelfApprovalAllowed() (lib/digest/freigabe-core.ts, ALLOW_SELF_APPROVAL)
 * bestimmt — NIE vom Client entgegengenommen (fail-closed Vier-Augen-Pflicht).
 *
 * SIDE-EFFECT-FENCE (Muster Block I): auf dem Demo-Mandanten sind Rollen-
 * Mutationen gesperrt — gleicher Wortlaut wie actions.ts. Fail-closed.
 *
 * ZWEI-FAKTOR-SIGNAL (Review #59, Befund 2): Alle drei Actions reichen das Feld
 * `zweiFaktor` des Gates UNVERÄNDERT weiter, statt nur `error` zu übernehmen —
 * sonst endet die Bestätigung eines Vorschlags in einem Satz ohne Weg zurück.
 * Die Weitergabe ändert nichts an der Sicherheitslogik; das Signal entsteht in
 * den Gates, hier wird es nur nicht mehr weggeworfen.
 */

"use server";

import { z } from "zod";
import {
  requireAdminCtx,
  requireAdminStepUpCtx,
} from "@/lib/auth/action-context";
import { isDemoTenant } from "@/lib/demo/config";
import { SCOPE_INPUT_LEVELS } from "@/lib/region/ebenen";
import { isSelfApprovalAllowed } from "@/lib/digest/freigabe-core";
import {
  verifierErnennungVorschlagenCore,
  verifierErnennungEntscheidenCore,
  verifierErnennungZurueckziehenCore,
  type ErnennungResult,
} from "@/lib/admin/appointment-core";

/** SIDE-EFFECT-FENCE — gleicher Wortlaut wie die Rollen-Actions (actions.ts). */
const DEMO_ROLLEN_GESPERRT = "Im Demo-Mandanten werden Rollen nicht verändert.";

const vorschlagenSchema = z.object({
  targetEmail: z.string().email("Bitte eine gültige E-Mail-Adresse angeben."),
  scopeLevel: z.enum(SCOPE_INPUT_LEVELS).optional(),
  scopeCode: z.string().trim().max(100).optional().nullable(),
});

const entscheidenSchema = z.object({
  appointmentId: z.string().uuid("Ungültige Vorschlags-ID."),
  entscheidung: z.enum(["bestaetigen", "ablehnen"]),
});

const zurueckziehenSchema = z.object({
  appointmentId: z.string().uuid("Ungültige Vorschlags-ID."),
});

export type ErnennungVorschlagenActionInput = z.input<typeof vorschlagenSchema>;
export type ErnennungEntscheidenActionInput = z.input<typeof entscheidenSchema>;

/** Server Action: Verifier-Ernennung vorschlagen (Schritt 1, auditiert). */
export async function verifierErnennungVorschlagen(
  rawInput: ErnennungVorschlagenActionInput,
): Promise<ErnennungResult> {
  // KEIN Step-up: Der Vorschlag vergibt noch NICHTS — er legt einen Antrag an,
  // den nach dem Vier-Augen-Prinzip eine zweite Person entscheiden muss. Die
  // Rolle entsteht erst dort, und dort sitzt auch das Step-up.
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  const parsed = vorschlagenSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return verifierErnennungVorschlagenCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, {
    targetEmail: parsed.data.targetEmail,
    scopeLevel: parsed.data.scopeLevel,
    scopeCode: parsed.data.scopeCode ?? null,
  });
}

/**
 * Server Action: Vorschlag bestätigen ODER ablehnen (Schritt 2, auditiert).
 * `allowSelfApproval` kommt NUR aus isSelfApprovalAllowed() — nie vom Client.
 */
export async function verifierErnennungEntscheiden(
  rawInput: ErnennungEntscheidenActionInput,
): Promise<ErnennungResult> {
  // STEP-UP (#59): Die Bestätigung VERGIBT die verifier-Rolle — und damit die
  // Befugnis, Wohnsitze zu bestätigen, also Stufe-2-Stimmrecht zu erzeugen.
  // Gleiche Schwelle wie assignRole; das Vier-Augen-Prinzip ersetzt sie nicht
  // (ALLOW_SELF_APPROVAL kann es im Pilot überbrücken).
  const auth = await requireAdminStepUpCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  const parsed = entscheidenSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return verifierErnennungEntscheidenCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, {
    appointmentId: parsed.data.appointmentId,
    entscheidung: parsed.data.entscheidung,
    allowSelfApproval: isSelfApprovalAllowed(),
  });
}

/** Server Action: offenen Vorschlag zurückziehen (auditiert). */
export async function verifierErnennungZurueckziehen(
  rawInput: { appointmentId: string },
): Promise<ErnennungResult> {
  // KEIN Step-up: Zurückziehen beendet einen OFFENEN Vorschlag, bevor eine Rolle
  // entstanden ist — es vergibt und entzieht nichts. Die Wirkung ist, dass alles
  // beim Alten bleibt.
  const auth = await requireAdminCtx();
  if (!auth.ok) return { ok: false, error: auth.error, zweiFaktor: auth.zweiFaktor };
  const { ctx } = auth;

  if (isDemoTenant(ctx.tenant.slug)) return { ok: false, error: DEMO_ROLLEN_GESPERRT };

  const parsed = zurueckziehenSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Ungültige Eingabe." };
  }
  return verifierErnennungZurueckziehenCore(ctx.db, ctx.tenant.id, ctx.roleTypes, ctx.userId, {
    appointmentId: parsed.data.appointmentId,
  });
}
