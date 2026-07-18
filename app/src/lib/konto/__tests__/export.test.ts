/**
 * export.test.ts — Unit-Tests für die Export-Sammelstruktur (H3 DSGVO, Art. 15).
 *
 * Prüft die reine Struktur-Bildung (buildExportDocument) ohne DB: korrekte
 * Verschachtelung von Konto, Rollen, gefolgten + eigenen Anliegen samt Events,
 * sowie das Vorhandensein des Art.-15-Hinweises.
 */

import { describe, it, expect } from "vitest";
import { buildExportDocument } from "@/lib/konto/export";
import type { users, roles, anliegen, anliegenEvents, anliegenFollowers } from "@/db/schema";

type UserRow = typeof users.$inferSelect;
type RoleRow = typeof roles.$inferSelect;
type AnliegenRow = typeof anliegen.$inferSelect;
type EventRow = typeof anliegenEvents.$inferSelect;
type FollowRow = typeof anliegenFollowers.$inferSelect;

const T0 = new Date("2026-01-01T00:00:00Z");

const user: UserRow = {
  id: "user-1",
  tenantId: "tenant-1",
  email: "max@example.org",
  displayName: "Max Mustermann",
  funktion: "Ortsvorsteher",
  birthYear: 1990,
  birthMonth: 5,
  ortsteilId: "ortsteil-1",
  homeRegionId: null,
  residencyRegionId: null,
  verificationStatus: "verified",
  verificationMethod: "in_person",
  residencyVerifiedAt: T0,
  residencyVerifiedUntil: null,
  reverifyReminderSentAt: null,
  accountStatus: "active",
  createdAt: T0,
  minAgeConfirmedAt: T0,
  deletedAt: null,
  notifyNewPolls: true,
  updatedAt: T0,
};

const rolle: RoleRow = {
  id: "role-1",
  tenantId: "tenant-1",
  userId: "user-1",
  roleType: "user",
  regionId: "region-1",
  createdAt: T0,
  updatedAt: T0,
};

const eigenesAnliegen: AnliegenRow = {
  id: "anliegen-1",
  tenantId: "tenant-1",
  trackingCode: "ABC-123",
  creatorRef: "pseudonym-hash",
  titel: "Mehr Bänke im Park",
  beschreibung: "Bitte mehr Sitzgelegenheiten.",
  status: "eingegangen",
  verborgenAt: null,
  verborgenGrund: null,
  ortsteilId: "ortsteil-1",
  createdAt: T0,
  updatedAt: T0,
};

const event: EventRow = {
  id: "event-1",
  anliegenId: "anliegen-1",
  status: "eingegangen",
  quelle: null,
  notiz: null,
  createdAt: T0,
};

const follow: FollowRow = {
  id: "follow-1",
  anliegenId: "anliegen-1",
  userId: "user-1",
  createdAt: T0,
};

describe("buildExportDocument", () => {
  it("enthält den Art.-15-Hinweis und Tenant-Angaben", () => {
    const doc = buildExportDocument({
      tenant: { slug: "taunusstein", name: "Taunusstein" },
      user,
      rollen: [rolle],
      follows: [follow],
      anliegen: [eigenesAnliegen],
      events: [event],
      termine: [],
      qrEinloesungen: [],
    });

    expect(doc.hinweis).toContain("Art. 15 DSGVO");
    expect(doc.tenant).toEqual({ slug: "taunusstein", name: "Taunusstein" });
    expect(typeof doc.exportiertAm).toBe("string");
  });

  it("nimmt die eigene E-Mail in den Konto-Block (es ist der eigene Datenexport)", () => {
    const doc = buildExportDocument({
      tenant: { slug: "t", name: "T" },
      user,
      rollen: [],
      follows: [],
      anliegen: [],
      events: [],
      termine: [],
      qrEinloesungen: [],
    });
    expect(doc.konto.email).toBe("max@example.org");
    expect(doc.konto.birthYear).toBe(1990);
    expect(doc.konto.id).toBe("user-1");
    // Block J1: Rollenträger-Identität (Klarname + Funktion) muss im Art.-15-
    // Export enthalten sein.
    expect(doc.konto.displayName).toBe("Max Mustermann");
    expect(doc.konto.funktion).toBe("Ortsvorsteher");
    // Benachrichtigungs-Motor: Opt-in-Status muss im Datenexport enthalten sein.
    expect(doc.konto.notifyNewPolls).toBe(true);
  });

  it("verschachtelt Events unter dem jeweiligen Anliegen", () => {
    const doc = buildExportDocument({
      tenant: { slug: "t", name: "T" },
      user,
      rollen: [rolle],
      follows: [follow],
      anliegen: [eigenesAnliegen],
      events: [event],
      termine: [],
      qrEinloesungen: [],
    });

    expect(doc.meineAnliegen).toHaveLength(1);
    expect(doc.meineAnliegen[0].trackingCode).toBe("ABC-123");
    expect(doc.meineAnliegen[0].events).toHaveLength(1);
    expect(doc.meineAnliegen[0].events[0].status).toBe("eingegangen");
  });

  it("bildet Rollen und gefolgte Anliegen ab", () => {
    const doc = buildExportDocument({
      tenant: { slug: "t", name: "T" },
      user,
      rollen: [rolle],
      follows: [follow],
      anliegen: [],
      events: [],
      termine: [],
      qrEinloesungen: [],
    });
    expect(doc.rollen).toEqual([
      { roleType: "user", regionId: "region-1", createdAt: T0.toISOString() },
    ]);
    expect(doc.gefolgteAnliegen).toEqual([
      { anliegenId: "anliegen-1", createdAt: T0.toISOString() },
    ]);
  });

  it("serialisiert Daten als ISO-Strings (kein rohes Date-Objekt)", () => {
    const doc = buildExportDocument({
      tenant: { slug: "t", name: "T" },
      user,
      rollen: [],
      follows: [],
      anliegen: [eigenesAnliegen],
      events: [],
      termine: [],
      qrEinloesungen: [],
    });
    expect(doc.konto.createdAt).toBe(T0.toISOString());
    expect(doc.meineAnliegen[0].createdAt).toBe(T0.toISOString());
  });

  it("liefert leere Listen, wenn keine Daten vorhanden sind", () => {
    const doc = buildExportDocument({
      tenant: { slug: "t", name: "T" },
      user,
      rollen: [],
      follows: [],
      anliegen: [],
      events: [],
      termine: [],
      qrEinloesungen: [],
    });
    expect(doc.rollen).toEqual([]);
    expect(doc.gefolgteAnliegen).toEqual([]);
    expect(doc.meineAnliegen).toEqual([]);
    expect(doc.verifizierungsTermine).toEqual([]);
    expect(doc.qrEinloesungen).toEqual([]);
  });

  it("nimmt Verifizierungs-Termine und QR-Einlösungen in die Auskunft auf (Audit m3)", () => {
    const doc = buildExportDocument({
      tenant: { slug: "t", name: "T" },
      user,
      rollen: [],
      follows: [],
      anliegen: [],
      events: [],
      termine: [
        {
          id: "b-1",
          tenantId: "t-1",
          slotId: "s-1",
          userId: "user-1",
          code: "TERMIN-AAAA-BBBB",
          status: "gebucht",
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      qrEinloesungen: [
        {
          id: "r-1",
          qrCodeId: "qr-1",
          userId: "user-1",
          tenantId: "t-1",
          redeemedAt: T0,
        },
      ],
    });
    expect(doc.verifizierungsTermine).toEqual([
      { code: "TERMIN-AAAA-BBBB", status: "gebucht", createdAt: T0.toISOString(), updatedAt: T0.toISOString() },
    ]);
    expect(doc.qrEinloesungen).toEqual([{ redeemedAt: T0.toISOString() }]);
  });
});
