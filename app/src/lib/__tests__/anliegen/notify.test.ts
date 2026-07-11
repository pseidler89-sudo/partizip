/**
 * notify.test.ts — Tests für Anliegen-Benachrichtigung (M8)
 *
 * Transport injizierbar (Spy) — keine Live-HTTP-Requests.
 */

import { describe, it, expect, vi } from "vitest";
import { notifyFollowersStatusChanged } from "@/lib/anliegen/notify";
import type { NotifyTransport } from "@/lib/anliegen/notify";

function createSpyTransport(): { transport: NotifyTransport; sendMailSpy: ReturnType<typeof vi.fn> } {
  const sendMailSpy = vi.fn().mockResolvedValue({ messageId: "test" });
  const transport: NotifyTransport = { sendMail: sendMailSpy };
  return { transport, sendMailSpy };
}

describe("notifyFollowersStatusChanged", () => {
  it("sendet Mail an alle Follower", async () => {
    const { transport, sendMailSpy } = createSpyTransport();
    const result = await notifyFollowersStatusChanged({
      trackingCode: "TS-ABCD-1234",
      tenantSlug: "taunusstein",
      previousStatus: "eingegangen",
      newStatus: "in_pruefung",
      quelleUrl: null,
      followerEmails: ["a@test.de", "b@test.de", "c@test.de"],
      transport,
    });

    expect(sendMailSpy).toHaveBeenCalledTimes(3);
    expect(result.sent).toBe(3);
    expect(result.errors).toBe(0);
  });

  it("Betreff enthält Tracking-Code und 'neuer Status'", async () => {
    const { transport, sendMailSpy } = createSpyTransport();
    await notifyFollowersStatusChanged({
      trackingCode: "TS-ABCD-1234",
      tenantSlug: "taunusstein",
      previousStatus: "eingegangen",
      newStatus: "in_pruefung",
      quelleUrl: null,
      followerEmails: ["a@test.de"],
      transport,
    });

    const call = sendMailSpy.mock.calls[0][0];
    expect(call.subject).toContain("TS-ABCD-1234");
    expect(call.subject).toContain("neuer Status");
  });

  it("enthält alten und neuen Status im Body", async () => {
    const { transport, sendMailSpy } = createSpyTransport();
    await notifyFollowersStatusChanged({
      trackingCode: "TS-ABCD-1234",
      tenantSlug: "taunusstein",
      previousStatus: "eingegangen",
      newStatus: "im_gremium",
      quelleUrl: null,
      followerEmails: ["a@test.de"],
      transport,
    });

    const call = sendMailSpy.mock.calls[0][0];
    expect(call.text).toContain("Eingegangen"); // vorheriger Status
    expect(call.text).toContain("Im Gremium"); // neuer Status
  });

  it("enthält quelleUrl wenn vorhanden", async () => {
    const { transport, sendMailSpy } = createSpyTransport();
    await notifyFollowersStatusChanged({
      trackingCode: "TS-ABCD-1234",
      tenantSlug: "taunusstein",
      previousStatus: "in_pruefung",
      newStatus: "im_gremium",
      quelleUrl: "https://example.com/dokument",
      followerEmails: ["a@test.de"],
      transport,
    });

    const call = sendMailSpy.mock.calls[0][0];
    expect(call.text).toContain("https://example.com/dokument");
  });

  it("gibt leeres Ergebnis bei 0 Followern", async () => {
    const { transport, sendMailSpy } = createSpyTransport();
    const result = await notifyFollowersStatusChanged({
      trackingCode: "TS-ABCD-1234",
      tenantSlug: "taunusstein",
      previousStatus: "eingegangen",
      newStatus: "in_pruefung",
      quelleUrl: null,
      followerEmails: [],
      transport,
    });

    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("zählt Fehler ohne Unterbrechung (partial failure)", async () => {
    const sendMailSpy = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "ok" })
      .mockRejectedValueOnce(new Error("SMTP-Fehler"))
      .mockResolvedValueOnce({ messageId: "ok" });

    const transport: NotifyTransport = { sendMail: sendMailSpy };

    const result = await notifyFollowersStatusChanged({
      trackingCode: "TS-ABCD-1234",
      tenantSlug: "taunusstein",
      previousStatus: "eingegangen",
      newStatus: "in_pruefung",
      quelleUrl: null,
      followerEmails: ["a@test.de", "b@test.de", "c@test.de"],
      transport,
    });

    // Alle 3 versucht, 1 Fehler
    expect(result.sent).toBe(2);
    expect(result.errors).toBe(1);
  });

  it("Mail enthält keinen rohen User-Identifier (PII-Minimierung)", async () => {
    const { transport, sendMailSpy } = createSpyTransport();
    await notifyFollowersStatusChanged({
      trackingCode: "TS-ABCD-1234",
      tenantSlug: "taunusstein",
      previousStatus: "eingegangen",
      newStatus: "in_pruefung",
      quelleUrl: null,
      followerEmails: ["empfaenger@test.de"],
      transport,
    });

    const call = sendMailSpy.mock.calls[0][0];
    // Body enthält nicht die E-Mail-Adresse des Empfängers (PII)
    expect(call.text).not.toContain("empfaenger@test.de");
  });
});
