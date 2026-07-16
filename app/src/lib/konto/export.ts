/**
 * export.ts — Daten-Export für das Auskunftsrecht (Art. 15 DSGVO, H3).
 *
 * Trennt die DB-Sammlung (collectExportData, im Route-Handler genutzt) von der
 * reinen Struktur-Bildung (buildExportDocument), damit Letztere ohne DB
 * unit-getestet werden kann.
 *
 * Tenant-Isolation: ALLE Queries sind tenant-scoped. Anliegen werden über das
 * Pseudonym `creator_ref = computeCreatorRef(userId)` gefunden (kein User-FK).
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  users,
  roles,
  anliegen,
  anliegenEvents,
  anliegenFollowers,
  verificationBookings,
  qrRedemptions,
} from "@/db/schema";
import { computeCreatorRef } from "@/lib/anliegen/creator-ref";

const EXPORT_HINWEIS =
  "Dies sind die zu Ihrem Konto gespeicherten personenbezogenen Daten gemäß " +
  "Art. 15 DSGVO (Auskunftsrecht). Ihre Anliegen werden pseudonym geführt " +
  "(HMAC-Pseudonym statt Kontoverknüpfung) und sind hier nur enthalten, weil " +
  "sie sich über Ihr Konto demselben Pseudonym zuordnen lassen.";

export type ExportKonto = {
  id: string;
  email: string;
  verificationStatus: string;
  verificationMethod: string | null;
  residencyVerifiedAt: string | null;
  residencyVerifiedUntil: string | null;
  accountStatus: string;
  birthYear: number | null;
  birthMonth: number | null;
  ortsteilId: string | null;
  homeRegionId: string | null;
  residencyRegionId: string | null;
  minAgeConfirmedAt: string | null;
  // Benachrichtigungs-Motor: Opt-in für E-Mails bei neuen Abstimmungen.
  notifyNewPolls: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ExportRolle = {
  roleType: string;
  // ADR-024 contract: Gebietsknoten der Rolle (region_id) statt scope_level/scope_code
  // — konsistent mit home_region_id/residency_region_id in ExportKonto.
  regionId: string;
  createdAt: string | null;
};

export type ExportFollow = {
  anliegenId: string;
  createdAt: string | null;
};

export type ExportAnliegenEvent = {
  status: string;
  quelle: string | null;
  notiz: string | null;
  createdAt: string | null;
};

export type ExportAnliegen = {
  trackingCode: string;
  titel: string;
  beschreibung: string | null;
  status: string;
  createdAt: string | null;
  events: ExportAnliegenEvent[];
};

export type ExportTermin = {
  code: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ExportQrEinloesung = {
  redeemedAt: string | null;
};

export type ExportDocument = {
  hinweis: string;
  exportiertAm: string;
  tenant: { slug: string; name: string };
  konto: ExportKonto;
  rollen: ExportRolle[];
  gefolgteAnliegen: ExportFollow[];
  meineAnliegen: ExportAnliegen[];
  // Verifizierungs-Spuren (Audit m3): vom Projekt selbst als PII eingestuft
  // (delete.ts löscht sie), gehören daher in die Art.-15-Auskunft.
  verifizierungsTermine: ExportTermin[];
  qrEinloesungen: ExportQrEinloesung[];
};

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Reine Struktur-Bildung aus bereits geladenen Rohdaten (kein DB-Zugriff).
 * Unit-testbar: prüft die Verschachtelung + Vollständigkeit der Sammelstruktur.
 */
export function buildExportDocument(input: {
  tenant: { slug: string; name: string };
  user: typeof users.$inferSelect;
  rollen: (typeof roles.$inferSelect)[];
  follows: (typeof anliegenFollowers.$inferSelect)[];
  anliegen: (typeof anliegen.$inferSelect)[];
  events: (typeof anliegenEvents.$inferSelect)[];
  termine: (typeof verificationBookings.$inferSelect)[];
  qrEinloesungen: (typeof qrRedemptions.$inferSelect)[];
  exportiertAm?: Date;
}): ExportDocument {
  const eventsByAnliegen = new Map<string, ExportAnliegenEvent[]>();
  for (const ev of input.events) {
    const list = eventsByAnliegen.get(ev.anliegenId) ?? [];
    list.push({
      status: ev.status,
      quelle: ev.quelle ?? null,
      notiz: ev.notiz ?? null,
      createdAt: iso(ev.createdAt),
    });
    eventsByAnliegen.set(ev.anliegenId, list);
  }

  return {
    hinweis: EXPORT_HINWEIS,
    exportiertAm: (input.exportiertAm ?? new Date()).toISOString(),
    tenant: { slug: input.tenant.slug, name: input.tenant.name },
    konto: {
      id: input.user.id,
      email: input.user.email,
      verificationStatus: input.user.verificationStatus,
      verificationMethod: input.user.verificationMethod ?? null,
      residencyVerifiedAt: iso(input.user.residencyVerifiedAt),
      residencyVerifiedUntil: iso(input.user.residencyVerifiedUntil),
      accountStatus: input.user.accountStatus,
      birthYear: input.user.birthYear ?? null,
      birthMonth: input.user.birthMonth ?? null,
      ortsteilId: input.user.ortsteilId ?? null,
      // ADR-024: Gebiets-Zuordnungen gehören zur Art.-15-Auskunft (Standortdaten).
      homeRegionId: input.user.homeRegionId ?? null,
      residencyRegionId: input.user.residencyRegionId ?? null,
      minAgeConfirmedAt: iso(input.user.minAgeConfirmedAt),
      notifyNewPolls: input.user.notifyNewPolls,
      createdAt: iso(input.user.createdAt),
      updatedAt: iso(input.user.updatedAt),
    },
    rollen: input.rollen.map((r) => ({
      roleType: r.roleType,
      regionId: r.regionId,
      createdAt: iso(r.createdAt),
    })),
    gefolgteAnliegen: input.follows.map((f) => ({
      anliegenId: f.anliegenId,
      createdAt: iso(f.createdAt),
    })),
    meineAnliegen: input.anliegen.map((a) => ({
      trackingCode: a.trackingCode,
      titel: a.titel,
      beschreibung: a.beschreibung ?? null,
      status: a.status,
      createdAt: iso(a.createdAt),
      events: eventsByAnliegen.get(a.id) ?? [],
    })),
    verifizierungsTermine: input.termine.map((t) => ({
      code: t.code,
      status: t.status,
      createdAt: iso(t.createdAt),
      updatedAt: iso(t.updatedAt),
    })),
    qrEinloesungen: input.qrEinloesungen.map((q) => ({
      redeemedAt: iso(q.redeemedAt),
    })),
  };
}

/**
 * Sammelt alle eigenen Daten des Users tenant-scoped aus der DB und baut das
 * Export-Dokument. Wird vom Route-Handler genutzt.
 */
export async function collectExportData(
  db: Db,
  tenant: { id: string; slug: string; name: string },
  userId: string,
): Promise<ExportDocument | null> {
  // users-Zeile (tenant-scoped)
  const userRows = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.id, userId)))
    .limit(1);
  const user = userRows[0];
  if (!user) return null;

  // roles (tenant-scoped + user-scoped)
  const rollen = await db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, tenant.id), eq(roles.userId, userId)));

  // anliegen_followers (user-scoped) — join auf anliegen für Tenant-Isolation
  const followRows = await db
    .select({
      id: anliegenFollowers.id,
      anliegenId: anliegenFollowers.anliegenId,
      userId: anliegenFollowers.userId,
      createdAt: anliegenFollowers.createdAt,
    })
    .from(anliegenFollowers)
    .innerJoin(anliegen, eq(anliegenFollowers.anliegenId, anliegen.id))
    .where(
      and(
        eq(anliegenFollowers.userId, userId),
        eq(anliegen.tenantId, tenant.id),
      ),
    );

  // eigene Anliegen über Pseudonym + Tenant
  const creatorRef = computeCreatorRef(userId);
  const meineAnliegen = await db
    .select()
    .from(anliegen)
    .where(
      and(
        eq(anliegen.tenantId, tenant.id),
        eq(anliegen.creatorRef, creatorRef),
      ),
    );

  // zugehörige Events (nur für die gefundenen Anliegen-IDs)
  const anliegenIds = meineAnliegen.map((a: { id: string }) => a.id);
  const events =
    anliegenIds.length > 0
      ? await db
          .select()
          .from(anliegenEvents)
          .where(inArray(anliegenEvents.anliegenId, anliegenIds))
      : [];

  // Verifizierungs-Termine (tenant + user scoped) — Audit m3.
  const termine = await db
    .select()
    .from(verificationBookings)
    .where(
      and(
        eq(verificationBookings.tenantId, tenant.id),
        eq(verificationBookings.userId, userId),
      ),
    );

  // QR-Einlösungen (tenant + user scoped) — Audit m3.
  const qrEinloesungen = await db
    .select()
    .from(qrRedemptions)
    .where(
      and(
        eq(qrRedemptions.tenantId, tenant.id),
        eq(qrRedemptions.userId, userId),
      ),
    );

  return buildExportDocument({
    tenant: { slug: tenant.slug, name: tenant.name },
    user,
    rollen,
    follows: followRows,
    anliegen: meineAnliegen,
    events,
    termine,
    qrEinloesungen,
  });
}
