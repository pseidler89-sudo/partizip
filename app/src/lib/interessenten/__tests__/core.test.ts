/**
 * core.test.ts — reine Unit-Tests für die Interessenten-Bausteine (Block N,
 * OHNE DB): Validierung, Formular→Insert, Tymeslot-Mapping, Token-Vergleich,
 * Authorisierungs-Prädikat.
 */

import { describe, it, expect } from "vitest";
import {
  interessentFormularSchema,
  formularZuInsert,
  tymeslotZuInsert,
} from "@/lib/interessenten/core";
import { tokenGueltig } from "@/lib/interessenten/webhook";
import { isSuperAdmin } from "@/lib/auth/roles";

describe("interessentFormularSchema", () => {
  it("akzeptiert einen gültigen Lead und normalisiert die E-Mail", () => {
    const r = interessentFormularSchema.safeParse({
      ansprechpartner: "  Erika Muster ",
      email: " Erika@Beispiel.DE ",
      kommune: "Musterstadt",
      rolle: "Bürgermeisterin",
      groesse: "12000",
      nachricht: "Wir hätten Interesse.",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe("erika@beispiel.de");
      expect(r.data.ansprechpartner).toBe("Erika Muster");
    }
  });

  it("lehnt eine ungültige E-Mail ab", () => {
    const r = interessentFormularSchema.safeParse({
      ansprechpartner: "Erika",
      email: "keine-mail",
    });
    expect(r.success).toBe(false);
  });

  it("lehnt einen zu kurzen Namen ab", () => {
    const r = interessentFormularSchema.safeParse({ ansprechpartner: "E", email: "a@b.de" });
    expect(r.success).toBe(false);
  });

  it("wandelt leere optionale Felder zu undefined (→ NULL)", () => {
    const r = interessentFormularSchema.safeParse({
      ansprechpartner: "Erika Muster",
      email: "a@b.de",
      kommune: "",
      rolle: "   ",
      nachricht: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const insert = formularZuInsert(r.data);
      expect(insert.kommune).toBeNull();
      expect(insert.rolle).toBeNull();
      expect(insert.nachricht).toBeNull();
      expect(insert.quelle).toBe("formular");
      expect(insert.tymeslotMeetingUid).toBeNull();
    }
  });

  it("lehnt eine zu lange Nachricht ab (>2000)", () => {
    const r = interessentFormularSchema.safeParse({
      ansprechpartner: "Erika Muster",
      email: "a@b.de",
      nachricht: "x".repeat(2001),
    });
    expect(r.success).toBe(false);
  });
});

describe("tymeslotZuInsert", () => {
  const base = {
    event: "meeting.created",
    data: {
      meeting: {
        uid: "mtg-123",
        start_time: "2026-08-01T10:00:00.000Z",
        attendee: {
          name: "Max Muster",
          email: "Max@Beispiel.de",
          company: "Gemeinde Beispiel",
          message: "Freue mich auf das Gespräch.",
        },
      },
    },
  };

  it("bildet ein vollständiges meeting.created auf einen Insert ab", () => {
    const insert = tymeslotZuInsert(base);
    expect(insert).not.toBeNull();
    expect(insert!.quelle).toBe("tymeslot");
    expect(insert!.tymeslotMeetingUid).toBe("mtg-123");
    expect(insert!.email).toBe("max@beispiel.de"); // normalisiert
    expect(insert!.ansprechpartner).toBe("Max Muster");
    expect(insert!.kommune).toBe("Gemeinde Beispiel");
    expect(insert!.nachricht).toBe("Freue mich auf das Gespräch.");
    expect(insert!.terminAm).toBeInstanceOf(Date);
    expect(insert!.terminAm!.toISOString()).toBe("2026-08-01T10:00:00.000Z");
  });

  it("gibt null zurück, wenn attendee.email fehlt", () => {
    const body = { ...base, data: { meeting: { ...base.data.meeting, attendee: { name: "X" } } } };
    expect(tymeslotZuInsert(body)).toBeNull();
  });

  it("gibt null zurück, wenn die meeting.uid fehlt", () => {
    const body = {
      ...base,
      data: { meeting: { ...base.data.meeting, uid: undefined } },
    };
    expect(tymeslotZuInsert(body)).toBeNull();
  });

  it("gibt null zurück bei ungültiger E-Mail", () => {
    const body = {
      ...base,
      data: { meeting: { ...base.data.meeting, attendee: { email: "kaputt" } } },
    };
    expect(tymeslotZuInsert(body)).toBeNull();
  });

  it("setzt terminAm null bei fehlendem/ungültigem start_time und Name-Fallback", () => {
    const body = {
      ...base,
      data: {
        meeting: {
          uid: "mtg-9",
          start_time: "nonsense",
          attendee: { email: "a@b.de" },
        },
      },
    };
    const insert = tymeslotZuInsert(body);
    expect(insert).not.toBeNull();
    expect(insert!.terminAm).toBeNull();
    expect(insert!.ansprechpartner).toBe("(ohne Namen)");
    expect(insert!.kommune).toBeNull();
  });
});

describe("tokenGueltig", () => {
  it("true nur bei exakter Übereinstimmung", () => {
    expect(tokenGueltig("geheim", "geheim")).toBe(true);
  });
  it("false bei Abweichung", () => {
    expect(tokenGueltig("geheim", "anders")).toBe(false);
  });
  it("false bei unterschiedlicher Länge (kein Wurf)", () => {
    expect(tokenGueltig("kurz", "vielvielaenger")).toBe(false);
  });
  it("false wenn der erwartete Token fehlt/leer ist (fail-closed)", () => {
    expect(tokenGueltig("egal", undefined)).toBe(false);
    expect(tokenGueltig("egal", "")).toBe(false);
  });
  it("false wenn der übergebene Token fehlt", () => {
    expect(tokenGueltig(null, "geheim")).toBe(false);
  });
});

describe("isSuperAdmin", () => {
  it("nur super_admin erhält Zugriff", () => {
    expect(isSuperAdmin(["super_admin"])).toBe(true);
    expect(isSuperAdmin(["kommune_admin"])).toBe(false);
    expect(isSuperAdmin(["user"])).toBe(false);
    expect(isSuperAdmin([])).toBe(false);
    expect(isSuperAdmin(["kommune_admin", "super_admin"])).toBe(true);
  });
});
