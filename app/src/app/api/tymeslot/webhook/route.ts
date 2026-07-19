/**
 * POST /api/tymeslot/webhook — Tymeslot-„meeting.created"-Auto-Lead (Block N2).
 *
 * Auth: statischer Bearer-Token im Header `X-Tymeslot-Token`, konstant-zeitig
 * gegen `process.env.TYMESLOT_WEBHOOK_TOKEN` verglichen (KEIN HMAC — Tymeslot
 * sendet nur diesen Token). Fehlt der Env-Wert ODER stimmt der Token nicht → 401.
 *
 * Bei GÜLTIGEM Token IMMER 2xx (auch bei Duplikat/ignoriertem Event/fehlenden
 * Feldern) — sonst deaktiviert Tymeslot nach 10 Fehlversuchen den Webhook.
 *
 * Kein Tenant-/Session-Kontext (Webhook von außen). Die eigentliche Verarbeitung
 * (Mapping/Idempotenz/Mail/Audit) liegt testbar in lib/interessenten/webhook.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/db/client";
import { databaseUrl } from "@/lib/auth/action-context";
import { tokenGueltig, verarbeiteWebhookEvent } from "@/lib/interessenten/webhook";
import type { TymeslotWebhookBody } from "@/lib/interessenten/core";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- Auth: statischer Token, konstant-zeitig. Fehlt/falsch → 401. ---
  const provided = request.headers.get("x-tymeslot-token");
  if (!tokenGueltig(provided, process.env.TYMESLOT_WEBHOOK_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // --- Body parsen. Ungültiges JSON: 2xx (kein Auto-Disable), kein Insert. ---
  let body: TymeslotWebhookBody;
  try {
    body = (await request.json()) as TymeslotWebhookBody;
  } catch {
    return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }

  const db = createDb(databaseUrl());
  const result = await verarbeiteWebhookEvent(db, body);

  return NextResponse.json({ ok: true, inserted: result.inserted }, { status: 200 });
}
