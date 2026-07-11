/**
 * region/actions.ts — Server Actions für den PLZ-/Standort-Einstieg (ADR-015).
 *
 * Setzen/Löschen des Region-Cookies `pz_region`. Der Tenant ergibt sich aus dem
 * Host (ADR-015 Single-Domain), nicht aus Client-Eingaben. Das Cookie ist reine
 * Personalisierung (welche Ortsteil-Polls ein Anonymer sieht) — kein Recht wird
 * dadurch freigeschaltet (Mitstimmen bleibt Stufe-1-pflichtig, nutzt user.ortsteilId).
 */

"use server";

import { cookies, headers } from "next/headers";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import {
  REGION_COOKIE_NAME,
  REGION_COOKIE_MAX_AGE,
  serializeRegionCookie,
  isValidPlz,
  coercePlz,
} from "@/lib/region/core";
import {
  resolveRegionByPlz,
  resolveRegionByCoords,
  ortsteilCodeGehoertZuTenant,
} from "@/lib/region/queries";

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export interface RegionResult {
  ok: boolean;
  /** PLZ/Standort gehört zu einer anderen (im Pilot nicht aktiven) Kommune. */
  andereKommune?: boolean;
  /** PLZ/Standort keiner teilnehmenden Region zugeordnet. */
  nichtGefunden?: boolean;
  error?: string;
}

async function currentTenantId(): Promise<string | null> {
  const h = await headers();
  const host = h.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  return tenant?.id ?? null;
}

async function setRegionCookie(ortsteilCode: string | null): Promise<void> {
  const c = await cookies();
  c.set(REGION_COOKIE_NAME, serializeRegionCookie(ortsteilCode), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: REGION_COOKIE_MAX_AGE,
  });
}

/** Region per PLZ-Eingabe bestätigen. */
export async function regionAusPlz(plzInput: string): Promise<RegionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  // Fehlertoleranz (P2 §Empf. 7): Leerzeichen/Tippzeichen entfernen, 4-stellige PLZ
  // mit führender 0 ergänzen — DANN erst auf Gültigkeit prüfen.
  const plz = typeof plzInput === "string" ? coercePlz(plzInput) : "";
  if (!isValidPlz(plz)) {
    return { ok: false, error: "Bitte eine gültige 5-stellige Postleitzahl eingeben." };
  }

  const db = createDb(databaseUrl());
  const treffer = await resolveRegionByPlz(db, plz);

  if (!treffer) {
    // PLZ keiner Region zugeordnet — Cookie NICHT setzen, die Haustür zeigt einen
    // freundlichen Hinweis + die Möglichkeit, sich trotzdem umzusehen.
    return { ok: false, nichtGefunden: true };
  }
  if (treffer.tenantId !== tenantId) {
    return { ok: false, andereKommune: true, error: "Diese PLZ gehört zu einer anderen Kommune." };
  }

  await setRegionCookie(treffer.ortsteilCode);
  return { ok: true };
}

/** Region per Standort-Freigabe (Browser-Koordinaten) bestätigen. */
export async function regionAusKoordinaten(
  lat: number,
  lon: number
): Promise<RegionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return { ok: false, error: "Standort konnte nicht ausgewertet werden." };
  }

  const db = createDb(databaseUrl());
  const treffer = await resolveRegionByCoords(db, lat, lon);

  if (!treffer) return { ok: false, nichtGefunden: true };
  if (treffer.tenantId !== tenantId) {
    return { ok: false, andereKommune: true, error: "Ihr Standort liegt in einer anderen Kommune." };
  }

  await setRegionCookie(treffer.ortsteilCode);
  return { ok: true };
}

/**
 * Region ohne PLZ-Treffer bestätigen („Trotzdem ansehen") — Stadt-Ebene,
 * kein Ortsteil. Setzt nur das Cookie für den aktuellen Host-Tenant.
 */
export async function regionUebernehmen(): Promise<RegionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, error: "Diese Seite ist nicht erreichbar." };
  await setRegionCookie(null);
  return { ok: true };
}

/** Ortsteil innerhalb der bestätigten Region wählen (null = ganze Kommune). */
export async function ortsteilSetzen(code: string | null): Promise<RegionResult> {
  const tenantId = await currentTenantId();
  if (!tenantId) return { ok: false, error: "Diese Seite ist nicht erreichbar." };

  if (code == null || code === "") {
    await setRegionCookie(null);
    return { ok: true };
  }

  const db = createDb(databaseUrl());
  const gehoert = await ortsteilCodeGehoertZuTenant(db, tenantId, code);
  if (!gehoert) return { ok: false, error: "Unbekannter Ortsteil." };

  await setRegionCookie(code);
  return { ok: true };
}

/** Region vergessen („Region ändern") — zeigt wieder die Haustür. */
export async function regionZuruecksetzen(): Promise<RegionResult> {
  const c = await cookies();
  c.delete(REGION_COOKIE_NAME);
  return { ok: true };
}
