import { describe, it, expect } from "vitest";
import {
  bewerteZweiFaktor,
  zugangErlaubt,
  stepUpErfuellt,
  totpAktiv,
  TOTP_KULANZ_TAGE,
  STEP_UP_MAX_ALTER_MINUTEN,
  type ZweiFaktorUser,
} from "../zwei-faktor";

const JETZT = new Date("2026-08-05T12:00:00Z");
const minuten = (m: number) => new Date(JETZT.getTime() + m * 60_000);
const tage = (d: number) => new Date(JETZT.getTime() + d * 24 * 60 * 60 * 1000);

const ohneTotp: ZweiFaktorUser = { totpSecretEnc: null, totpConfirmedAt: null, totpGraceUntil: null };
const angefangen: ZweiFaktorUser = { totpSecretEnc: "v1.aa.bb.cc", totpConfirmedAt: null, totpGraceUntil: null };
const aktiv: ZweiFaktorUser = {
  totpSecretEnc: "v1.aa.bb.cc",
  totpConfirmedAt: new Date("2026-08-01T00:00:00Z"),
  totpGraceUntil: null,
};

describe("totpAktiv", () => {
  it("zählt ein angefangenes, unbestätigtes Setup NICHT als aktiv", () => {
    // Sonst würde die Einrichtung selbst aussperren: Secret gespeichert, aber der
    // Nutzer hat noch keinen funktionierenden Authenticator.
    expect(totpAktiv(angefangen)).toBe(false);
  });

  it("zählt bestätigtes TOTP als aktiv", () => {
    expect(totpAktiv(aktiv)).toBe(true);
  });

  it("zählt ein bestätigtes Datum ohne Secret nicht als aktiv", () => {
    expect(totpAktiv({ totpSecretEnc: null, totpConfirmedAt: JETZT, totpGraceUntil: null })).toBe(false);
  });
});

describe("bewerteZweiFaktor — Nicht-Admins", () => {
  it("greift für Nicht-Admins gar nicht", () => {
    expect(
      bewerteZweiFaktor({ istAdmin: false, user: ohneTotp, session: { totpVerifiedAt: null }, jetzt: JETZT })
    ).toEqual({ status: "nicht_noetig" });
  });

  it("greift auch dann nicht, wenn der Nicht-Admin TOTP eingerichtet hat", () => {
    expect(
      bewerteZweiFaktor({ istAdmin: false, user: aktiv, session: { totpVerifiedAt: null }, jetzt: JETZT })
    ).toEqual({ status: "nicht_noetig" });
  });
});

describe("bewerteZweiFaktor — Admin mit aktivem TOTP", () => {
  it("verlangt einen Code, solange die Session ungeprüft ist", () => {
    expect(
      bewerteZweiFaktor({ istAdmin: true, user: aktiv, session: { totpVerifiedAt: null }, jetzt: JETZT })
    ).toEqual({ status: "code_faellig" });
  });

  it("ist erfüllt, sobald die Session geprüft wurde", () => {
    const geprueft = minuten(-5);
    expect(
      bewerteZweiFaktor({ istAdmin: true, user: aktiv, session: { totpVerifiedAt: geprueft }, jetzt: JETZT })
    ).toEqual({ status: "erfuellt", geprueftAm: geprueft });
  });

  it("bleibt für den Alltag erfüllt, auch wenn die Prüfung alt ist", () => {
    // Der Alltag hängt an der Session, nur Step-up verlangt Frische.
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: aktiv,
      session: { totpVerifiedAt: minuten(-600) },
      jetzt: JETZT,
    });
    expect(lage.status).toBe("erfuellt");
    expect(zugangErlaubt(lage)).toBe(true);
  });
});

describe("bewerteZweiFaktor — Admin ohne TOTP (Kulanzfrist)", () => {
  // Der Kern des Gate-B-Blockers: Ohne eingetragene Frist gibt es KEINE Kulanz.
  // Vorher setzte die Anwendung hier beim ersten Zugriff eine neue 14-Tage-Frist
  // — damit hätte jedes neu ernannte Admin-Konto zwei Wochen ohne zweiten Faktor
  // bekommen, beliebig oft wiederholbar über weitere Konten.
  it("sperrt ein Admin-Konto ohne eingetragene Frist sofort", () => {
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: ohneTotp,
      session: { totpVerifiedAt: null },
      jetzt: JETZT,
    });
    expect(lage).toEqual({ status: "einrichtung_erzwungen", frist: null });
    expect(zugangErlaubt(lage)).toBe(false);
  });

  it("die Kulanzlänge ist eine reine Migrations-Konstante", () => {
    // Sie wird nur noch von Migration 0040 benutzt; die Richtlinie selbst rechnet
    // keine Frist mehr aus.
    expect(TOTP_KULANZ_TAGE).toBe(14);
  });

  it("lässt den Zugang offen, solange die Frist läuft", () => {
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: { ...ohneTotp, totpGraceUntil: tage(3) },
      session: { totpVerifiedAt: null },
      jetzt: JETZT,
    });
    expect(lage.status).toBe("einrichtung_offen");
    expect(zugangErlaubt(lage)).toBe(true);
  });

  it("sperrt, sobald die Frist abgelaufen ist", () => {
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: { ...ohneTotp, totpGraceUntil: minuten(-1) },
      session: { totpVerifiedAt: null },
      jetzt: JETZT,
    });
    expect(lage.status).toBe("einrichtung_erzwungen");
    expect(zugangErlaubt(lage)).toBe(false);
  });

  it("behandelt den Fristzeitpunkt selbst als abgelaufen", () => {
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: { ...ohneTotp, totpGraceUntil: JETZT },
      session: { totpVerifiedAt: null },
      jetzt: JETZT,
    });
    expect(lage.status).toBe("einrichtung_erzwungen");
  });

  it("hilft ein angefangenes Setup nicht über die Frist hinweg", () => {
    // Sonst könnte man die Pflicht dauerhaft umgehen, indem man die Einrichtung
    // startet und nie bestätigt.
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: { ...angefangen, totpGraceUntil: minuten(-1) },
      session: { totpVerifiedAt: null },
      jetzt: JETZT,
    });
    expect(lage.status).toBe("einrichtung_erzwungen");
    expect(zugangErlaubt(lage)).toBe(false);
  });

  it("eine geprüfte Session ersetzt die Einrichtung nicht", () => {
    // Ein Admin ohne aktives TOTP kann keinen gültigen Code geliefert haben;
    // ein gesetzter Zeitstempel darf die Pflicht trotzdem nicht aushebeln.
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: { ...ohneTotp, totpGraceUntil: minuten(-1) },
      session: { totpVerifiedAt: minuten(-1) },
      jetzt: JETZT,
    });
    expect(lage.status).toBe("einrichtung_erzwungen");
  });
});

describe("stepUpErfuellt", () => {
  it("ist erfüllt bei frischer Prüfung", () => {
    expect(
      stepUpErfuellt({ user: aktiv, session: { totpVerifiedAt: minuten(-1) }, jetzt: JETZT })
    ).toBe(true);
  });

  it("ist an der Altersgrenze noch erfüllt", () => {
    expect(
      stepUpErfuellt({
        user: aktiv,
        session: { totpVerifiedAt: minuten(-STEP_UP_MAX_ALTER_MINUTEN) },
        jetzt: JETZT,
      })
    ).toBe(true);
  });

  it("ist eine Minute darüber nicht mehr erfüllt", () => {
    expect(
      stepUpErfuellt({
        user: aktiv,
        session: { totpVerifiedAt: minuten(-STEP_UP_MAX_ALTER_MINUTEN - 1) },
        jetzt: JETZT,
      })
    ).toBe(false);
  });

  it("ist ohne Prüfung nicht erfüllt", () => {
    expect(stepUpErfuellt({ user: aktiv, session: { totpVerifiedAt: null }, jetzt: JETZT })).toBe(false);
  });

  // Owner-Entscheid „sanft mit Frist": Solange die Frist läuft, dürfen auch
  // folgenreiche Aktionen noch ohne zweiten Faktor laufen. Andernfalls wäre die
  // Frist für Veröffentlichen/Freigeben/Rollenvergabe vom ersten Tag an eine
  // harte Sperre gewesen — genau das, was sie verhindern soll.
  it("ist ohne TOTP während der laufenden Kulanzfrist erfüllt", () => {
    expect(
      stepUpErfuellt({
        user: { ...ohneTotp, totpGraceUntil: tage(10) },
        session: { totpVerifiedAt: null },
        jetzt: JETZT,
      })
    ).toBe(true);
  });

  // Gate-B-Blocker, zweite Hälfte: Vorher galt „keine Frist gesetzt" als erfüllt.
  // Ein Admin, der ausschließlich Server Actions aufruft und nie eine
  // /admin-Seite lädt, hätte damit nie eine Frist bekommen — und wäre dauerhaft
  // ohne zweiten Faktor an Rollenvergabe und Veröffentlichung gekommen.
  it("ist ohne TOTP und ohne eingetragene Frist NICHT erfüllt", () => {
    expect(
      stepUpErfuellt({ user: ohneTotp, session: { totpVerifiedAt: null }, jetzt: JETZT })
    ).toBe(false);
  });

  it("hilft auch eine geprüfte Session ohne eingetragene Frist nicht", () => {
    expect(
      stepUpErfuellt({ user: ohneTotp, session: { totpVerifiedAt: minuten(-1) }, jetzt: JETZT })
    ).toBe(false);
  });

  it("ist ohne TOTP nach Fristende nicht mehr erfüllt", () => {
    expect(
      stepUpErfuellt({
        user: { ...ohneTotp, totpGraceUntil: minuten(-1) },
        session: { totpVerifiedAt: minuten(-1) },
        jetzt: JETZT,
      })
    ).toBe(false);
  });

  it("verlangt bei aktivem TOTP einen frischen Code, auch wenn eine Frist gesetzt ist", () => {
    expect(
      stepUpErfuellt({
        user: { ...aktiv, totpGraceUntil: tage(10) },
        session: { totpVerifiedAt: null },
        jetzt: JETZT,
      })
    ).toBe(false);
  });

  it("wertet einen Zeitstempel aus der Zukunft nicht als frisch", () => {
    expect(stepUpErfuellt({ user: aktiv, session: { totpVerifiedAt: minuten(5) }, jetzt: JETZT })).toBe(false);
  });
});

describe("Demo-Mandant (ADR-020)", () => {
  // Die Demo vergibt jedem Besucher auf Knopfdruck ein ephemeres
  // kommune_admin-Konto. Unter die Pflicht gestellt, müsste er eine
  // Authenticator-App einrichten, um sich eine Demo anzusehen — der
  // Verwaltungs-Rundgang wäre tot. Die Ausnahme ist Absicht und wird hier
  // festgehalten, damit sie niemand versehentlich wegoptimiert.
  it("nimmt Admin-Konten des Demo-Mandanten von der Pflicht aus", () => {
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: ohneTotp,
      session: { totpVerifiedAt: null },
      demoMandant: true,
      jetzt: JETZT,
    });
    expect(lage).toEqual({ status: "nicht_noetig" });
    expect(zugangErlaubt(lage)).toBe(true);
  });

  it("erfüllt auf dem Demo-Mandanten auch das Step-up", () => {
    expect(
      stepUpErfuellt({
        user: ohneTotp,
        session: { totpVerifiedAt: null },
        demoMandant: true,
        jetzt: JETZT,
      })
    ).toBe(true);
  });

  it("sperrt dasselbe Konto ohne das Demo-Flag weiterhin", () => {
    // Gegenprobe: Die Ausnahme hängt am Flag, nicht am Kontozustand.
    const lage = bewerteZweiFaktor({
      istAdmin: true,
      user: ohneTotp,
      session: { totpVerifiedAt: null },
      jetzt: JETZT,
    });
    expect(zugangErlaubt(lage)).toBe(false);
    expect(
      stepUpErfuellt({ user: ohneTotp, session: { totpVerifiedAt: null }, jetzt: JETZT })
    ).toBe(false);
  });
});
