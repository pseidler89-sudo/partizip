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
