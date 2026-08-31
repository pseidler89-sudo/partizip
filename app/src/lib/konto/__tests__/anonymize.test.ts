/**
 * anonymize.test.ts — Unit-Tests für das Anonymisierungs-Payload (H3 DSGVO).
 *
 * Schützt die Vollständigkeit der Anonymisierung: jedes PII-Feld muss geleert
 * werden, der Tombstone muss UNIQUE(tenant,email)-tauglich + nicht zustellbar
 * sein, account_status='deleted' + deletedAt gesetzt.
 */

import { describe, it, expect } from "vitest";
import { buildAnonymizePayload, buildTombstoneEmail } from "@/lib/konto/anonymize";

describe("buildTombstoneEmail", () => {
  it("erzeugt eine deterministische, nicht zustellbare Tombstone-E-Mail", () => {
    const uid = "11111111-2222-3333-4444-555555555555";
    const email = buildTombstoneEmail(uid);
    expect(email).toBe(`geloescht-${uid}@deleted.invalid`);
    // .invalid ist reservierte TLD (RFC 2606) → niemals zustellbar
    expect(email.endsWith("@deleted.invalid")).toBe(true);
    // Eindeutig pro userId → erfüllt UNIQUE(tenant_id, email)
    expect(buildTombstoneEmail("anders")).not.toBe(email);
  });
});

describe("buildAnonymizePayload", () => {
  const uid = "abcdef01-0000-0000-0000-000000000000";

  it("leert alle PII-Felder", () => {
    const now = new Date("2026-06-13T10:00:00Z");
    const p = buildAnonymizePayload(uid, now);

    expect(p.birthYear).toBeNull();
    expect(p.birthMonth).toBeNull();
    expect(p.ortsteilId).toBeNull();
    // Block J1: öffentliche Rollenträger-Identität (PII) muss geleert werden.
    expect(p.displayName).toBeNull();
    expect(p.funktion).toBeNull();
    // ADR-024: Gebiets-Zuordnungen (Standort-PII) müssen ebenfalls geleert werden.
    expect(p.homeRegionId).toBeNull();
    expect(p.residencyRegionId).toBeNull();
    expect(p.verificationMethod).toBeNull();
    expect(p.residencyVerifiedAt).toBeNull();
    expect(p.minAgeConfirmedAt).toBeNull();
  });

  it("setzt Tombstone-E-Mail, status='deleted', verificationStatus='pending', deletedAt", () => {
    const now = new Date("2026-06-13T10:00:00Z");
    const p = buildAnonymizePayload(uid, now);

    expect(p.email).toBe(`geloescht-${uid}@deleted.invalid`);
    expect(p.accountStatus).toBe("deleted");
    expect(p.verificationStatus).toBe("pending");
    expect(p.deletedAt).toBe(now);
    // Benachrichtigungs-Motor: gelöschte Konten dürfen keine Mails mehr erhalten.
    expect(p.notifyNewPolls).toBe(false);
  });

  it("enthält kein PII mehr (keine Original-E-Mail/Geburtsdaten)", () => {
    const p = buildAnonymizePayload(uid);
    const serialized = JSON.stringify(p);
    // Keine echte Domain, kein @-Adressformat außer dem Tombstone
    expect(serialized).not.toContain("@gmail");
    expect(serialized).not.toContain("@googlemail");
    // Es darf KEIN Geburtsjahr/-monat als Zahl auftauchen
    expect(p.birthYear).toBeNull();
    expect(p.birthMonth).toBeNull();
  });

  it("nutzt new Date() als Default für deletedAt", () => {
    const before = Date.now();
    const p = buildAnonymizePayload(uid);
    const after = Date.now();
    expect(p.deletedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(p.deletedAt.getTime()).toBeLessThanOrEqual(after);
  });
});

/**
 * Wächter gegen genau den Fehler, der beim Zwei-Faktor-Block (#59) passiert ist:
 * Eine neue Spalte in `users` kam dazu, der Export wurde angefasst — die
 * Anonymisierung nicht. Der bestehende Test blieb grün, weil er nur die Felder
 * prüfte, die er kannte.
 *
 * Dieser Test dreht die Richtung um: Er geht vom SCHEMA aus und verlangt, dass
 * jede Spalte entweder bewusst aufgeführt ist (erhalten oder nicht-PII) oder im
 * Anonymisierungs-Payload vorkommt. Eine neue Spalte bricht ihn, bis jemand
 * entschieden hat, wohin sie gehört.
 */
describe("Vollständigkeit gegen das Schema", () => {
  // Spalten, die eine Löschung bewusst ÜBERLEBEN, je mit Grund.
  const bewusstErhalten: Record<string, string> = {
    id: "Primärschlüssel — die Zeile bleibt als Tombstone bestehen",
    tenantId: "Mandantenzuordnung; ohne sie wäre die Zeile nicht mehr auffindbar",
    createdAt: "Anlagezeitpunkt ohne Personenbezug nach Anonymisierung",
    updatedAt: "technischer Zeitstempel",
    email: "wird durch die Tombstone-Adresse ERSETZT (nicht genullt)",
    verificationStatus: "wird auf 'pending' zurückgesetzt (nicht genullt)",
    accountStatus: "wird auf 'deleted' gesetzt",
    deletedAt: "ist der Nachweis der Löschung",
    notifyAnliegenUpdates: "Opt-out-Flag ohne Personenbezug; Versand ist über notifyNewPolls=false und account_status gesperrt",
    notifyReverify: "wie notifyAnliegenUpdates",
    reverifyReminderSentAt: "Versandmarke ohne Personenbezug",
  };

  it("führt jede users-Spalte entweder im Payload oder in der Ausnahmeliste", async () => {
    const { users } = await import("@/db/schema");
    const payload = buildAnonymizePayload("abcdef01-0000-0000-0000-000000000000");
    const imPayload = new Set(Object.keys(payload));

    const vergessen = Object.keys(users)
      // Drizzle hängt an das Tabellenobjekt interne Symbole/Helfer; nur echte
      // Spalten haben einen `name`.
      .filter((k) => {
        const spalte = (users as unknown as Record<string, { name?: string }>)[k];
        return typeof spalte === "object" && spalte !== null && typeof spalte.name === "string";
      })
      .filter((k) => !imPayload.has(k) && !(k in bewusstErhalten));

    expect(
      vergessen,
      `Neue users-Spalte(n) ohne Entscheidung zur Löschung: ${vergessen.join(", ")}. ` +
        "Entweder ins Anonymisierungs-Payload aufnehmen oder mit Begründung in bewusstErhalten eintragen."
    ).toEqual([]);
  });

  it("leert die Zwei-Faktor-Felder (#59)", () => {
    const p = buildAnonymizePayload("abcdef01-0000-0000-0000-000000000000");
    expect(p.totpSecretEnc).toBeNull();
    expect(p.totpConfirmedAt).toBeNull();
    expect(p.totpLastStep).toBeNull();
    expect(p.totpGraceUntil).toBeNull();
  });
});
