/**
 * interessenten/actions.ts — Server Action für den öffentlichen „Mitmachen"-Lead
 * (Block N1). Server Actions sind eigenständige, öffentlich erreichbare Endpoints
 * → dieselbe Härtung wie ein Route-Handler:
 *
 *   - Origin-Check (Defense-in-Depth) am Anfang (istSameOrigin aus J2b).
 *   - Honeypot: verstecktes Feld `website` — ausgefüllt ⇒ still { ok:true }
 *     (Bot-Falle: kein Insert, keine Mail, kein Oracle).
 *   - zod-Validierung + E-Mail-Normalisierung (interessentFormularSchema).
 *   - Tenant aus dem Host (Pflicht) — der Lead selbst ist tenant-frei, aber
 *     Rate-Limit/Audit laufen über den host-aufgelösten (Pilot-)Tenant-Kontext.
 *   - Delegation an verarbeiteFormularLead (Rate-Limit/Insert/Mail/Audit/Demo-Fence).
 *
 * BEWUSST anonym (kein Session-Zwang): Multiplikatoren haben vor dem Kontakt kein
 * Konto. Nach außen IMMER neutral { ok:true } bei gültiger Eingabe.
 */

"use server";

import { headers } from "next/headers";
import { createDb } from "@/db/client";
import { databaseUrl } from "@/lib/auth/action-context";
import { getTenantFromHost } from "@/lib/tenant";
import { istSameOrigin } from "@/lib/auth/origin";
import { clientIpFromForwardedFor } from "@/lib/client-ip";
import { interessentFormularSchema } from "./core";
import { verarbeiteFormularLead } from "./formular";

export interface InteresseResult {
  ok: boolean;
  error?: string;
}

export async function interesseHinterlassen(
  formData: FormData
): Promise<InteresseResult> {
  // --- Origin-Check (Defense-in-Depth) ---
  const headerStore = await headers();
  const host = headerStore.get("host");
  if (!istSameOrigin(headerStore.get("origin"), host)) {
    return { ok: false, error: "Cross-Origin-Request abgelehnt." };
  }

  // --- Honeypot: verstecktes Feld. Ausgefüllt ⇒ Bot → still Erfolg. ---
  const honeypot = formData.get("website");
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    return { ok: true };
  }

  // --- Validierung (+ E-Mail-Normalisierung) ---
  const parsed = interessentFormularSchema.safeParse({
    ansprechpartner: formData.get("ansprechpartner"),
    email: formData.get("email"),
    kommune: formData.get("kommune"),
    rolle: formData.get("rolle"),
    groesse: formData.get("groesse"),
    nachricht: formData.get("nachricht"),
  });
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Ungültige Eingabe.";
    return { ok: false, error: msg };
  }

  // --- Tenant aus dem Host (Pflicht für Rate-Limit/Audit-Kontext) ---
  const tenant = await getTenantFromHost(host ?? "localhost");
  if (!tenant) {
    return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  }

  const ipAddress = clientIpFromForwardedFor(headerStore.get("x-forwarded-for"));
  const db = createDb(databaseUrl());

  const result = await verarbeiteFormularLead(db, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    data: parsed.data,
    ipAddress,
  });

  return { ok: result.ok };
}
