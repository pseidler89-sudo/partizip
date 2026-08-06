/**
 * kein-eigener-session-resolver.test.ts — Wächter gegen das Wiederaufreißen des
 * Gate-B-BLOCKERs vom 2026-08-06.
 *
 * WAS SCHIEFGING: Die Zwei-Faktor-Pflicht für Admins (#59) sitzt in den zentralen
 * Gates in `lib/auth/action-context.ts` (requireAdminCtx & Co.). Mehrere
 * "use server"-Dateien lösten ihren Auth-Kontext aber mit einer EIGENEN KOPIE des
 * Session-Lookups auf (Cookie → tokenHash → sessions-Zeile → Rollen). Diese Kopien
 * sahen aus wie Autorisierung, kannten die Pflicht aber nicht — rund zwanzig
 * mutierende Admin-Actions liefen ohne zweiten Faktor, darunter `einladen`
 * (vergibt eine kommune_admin-Rolle) und `offboarding`/`kontoSperren` (entrechtet
 * den legitimen Admin).
 *
 * WARUM EIN TEST UND KEIN KOMMENTAR: Der Fehler ist nicht auffällig. Eine neue
 * Action-Datei entsteht durch Kopieren einer alten, und mit ihr wandert der
 * Resolver mit. Ein Kommentar in action-context.ts erreicht denjenigen nicht, der
 * die Kopie anlegt — dieser Test schon: Er scheitert in dem Moment, in dem eine
 * neue "use server"-Datei unter src/lib wieder selbst in `sessions` greift.
 *
 * ERKENNUNG (bewusst grob, lieber ein Fehlalarm als eine Lücke):
 *   Eine Datei gilt als eigener Session-Resolver, wenn sie das Session-Cookie
 *   kennt (SESSION_COOKIE_NAME) oder aus der Tabelle `sessions` selektiert.
 *
 * DIE AUSNAHMEN STEHEN NAMENTLICH UNTEN — mit Begründung, nicht als stiller
 * Filter. Wer eine hinzufügt, muss sie begründen; das ist der Punkt der Liste.
 * Der Import von action-context zählt AUSDRÜCKLICH NICHT als Freibrief: Sonst
 * genügte ein beliebiger Import, um wieder einen eigenen Lookup zu bauen.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
/** src/lib — der gesamte Server-Code, aus dem Server Actions kommen. */
const LIB_ROOT = path.resolve(__dirname_, "../..");

/**
 * Dateien, die einen eigenen Session-Zugriff haben DÜRFEN. Jede Zeile ist eine
 * bewusste Entscheidung, keine Ausrede.
 */
const ERLAUBTE_AUSNAHMEN: Record<string, string> = {
  "demo/actions.ts":
    "Legt die ephemere Demo-Session SELBST an (Login-Pfad, kein Autorisierungs-Gate) " +
    "und muss dafür in sessions schreiben. Ein Gate, das eine Session voraussetzt, " +
    "kann die Session nicht erzeugen.",
  "region/actions.ts":
    "Reine Selbstbedienung: setzt/löscht den weichen Wohnort (users.home_region_id) " +
    "des EIGENEN Kontos und das pz_region-Cookie. Keine Admin-Fläche, keine " +
    "Rechtevergabe — die Zwei-Faktor-Pflicht greift hier nicht.",
  "konto/actions.ts":
    "Selbstbedienung im eigenen Konto (Löschung/Abmeldung). Betrifft nur den " +
    "Aufrufer selbst; keine privilegierte Aktion gegen Dritte.",
  "konto/notify-actions.ts":
    "Selbstbedienung: Benachrichtigungs-Einstellungen des eigenen Kontos.",
  "konto/profil-actions.ts":
    "Selbstbedienung: eigenes Profil. Die Rollen werden nur GELESEN (Anzeige-Pflicht " +
    "für Rollenträger), nicht geprüft, um Rechte zu gewähren.",
  "konto/email-change-actions.ts":
    "Selbstbedienung: E-Mail-Wechsel des eigenen Kontos, per Token bestätigt.",
};

/** Zeile, die NUR aus der Direktive besteht — nicht die Erwähnung im Kommentar. */
const USE_SERVER = /^\s*(["'])use server\1;?\s*$/m;

/** Eigener Session-Zugriff: Cookie-Name bekannt ODER Select aus `sessions`. */
const EIGENER_SESSION_ZUGRIFF = /SESSION_COOKIE_NAME|from\(\s*sessions\s*\)/;

function alleDateien(dir: string): string[] {
  const treffer: string[] = [];
  for (const eintrag of fs.readdirSync(dir, { withFileTypes: true })) {
    const voll = path.join(dir, eintrag.name);
    if (eintrag.isDirectory()) treffer.push(...alleDateien(voll));
    else if (/\.tsx?$/.test(eintrag.name)) treffer.push(voll);
  }
  return treffer;
}

interface UseServerDatei {
  /** Pfad relativ zu src/lib, z. B. "admin/actions.ts". */
  rel: string;
  inhalt: string;
}

function useServerDateien(): UseServerDatei[] {
  return alleDateien(LIB_ROOT)
    .map((voll) => ({
      rel: path.relative(LIB_ROOT, voll).split(path.sep).join("/"),
      inhalt: fs.readFileSync(voll, "utf8"),
    }))
    .filter((d) => USE_SERVER.test(d.inhalt));
}

describe("Wächter: keine eigenen Session-Resolver in Server Actions", () => {
  it("findet überhaupt \"use server\"-Dateien (der Wächter darf nicht ins Leere laufen)", () => {
    // Ohne diese Prüfung wäre ein kaputter Scan (falscher Pfad, geänderte
    // Direktiven-Schreibweise) ein still bestandener Test — die gefährlichste
    // Sorte von grünem Haken.
    expect(useServerDateien().length).toBeGreaterThan(10);
  });

  it("keine \"use server\"-Datei unter src/lib greift selbst auf sessions zu", () => {
    const verstoesse = useServerDateien()
      .filter((d) => EIGENER_SESSION_ZUGRIFF.test(d.inhalt))
      .map((d) => d.rel)
      .filter((rel) => !(rel in ERLAUBTE_AUSNAHMEN));

    expect(
      verstoesse,
      [
        "Diese \"use server\"-Datei(en) lösen die Session selbst auf und umgehen damit",
        "die zentralen Gates in lib/auth/action-context.ts — inklusive der",
        "Zwei-Faktor-Pflicht für Admins (#59):",
        ...verstoesse.map((v) => `  - ${v}`),
        "",
        "Richtig ist: requireAdminCtx() / requireAdminStepUpCtx() / requireVerifierCtx()",
        "/ requireSuperAdminCtx() / requireStufe1Ctx() / getOptionalAuthContext() aus",
        "@/lib/auth/action-context verwenden. Wenn die Datei WIRKLICH einen eigenen",
        "Zugriff braucht (z. B. weil sie eine Session erst anlegt), gehört sie mit",
        "Begründung in ERLAUBTE_AUSNAHMEN in dieser Datei — nicht stillschweigend",
        "an der Prüfung vorbei.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("die Ausnahmeliste enthält keine Karteileichen", () => {
    // Eine Ausnahme, deren Datei es nicht mehr gibt oder die den Zugriff gar nicht
    // mehr hat, ist eine offene Tür, die niemand mehr bewacht: Sie deckt beim
    // nächsten Mal eine Datei ab, die zufällig denselben Namen bekommt.
    const dateien = new Map(useServerDateien().map((d) => [d.rel, d.inhalt]));
    const unnoetig = Object.keys(ERLAUBTE_AUSNAHMEN).filter((rel) => {
      const inhalt = dateien.get(rel);
      return inhalt === undefined || !EIGENER_SESSION_ZUGRIFF.test(inhalt);
    });
    expect(unnoetig, `Ausnahme(n) ohne Grund — bitte aus der Liste entfernen: ${unnoetig.join(", ")}`)
      .toEqual([]);
  });

  it("jede Ausnahme trägt eine Begründung", () => {
    const ohneGrund = Object.entries(ERLAUBTE_AUSNAHMEN)
      .filter(([, grund]) => grund.trim().length < 40)
      .map(([rel]) => rel);
    expect(ohneGrund).toEqual([]);
  });

  it("die betroffenen Admin-Action-Dateien holen ihren Kontext aus action-context", () => {
    // Gegenprobe zum Negativ-Test: Die im Gate-B-Befund genannten Dateien sollen
    // nicht nur KEINEN eigenen Resolver haben, sondern nachweislich den zentralen
    // benutzen. Sonst könnte ein Umbau die Prüfung „bestehen", indem er die Auth
    // ganz weglässt.
    const pflicht = [
      "admin/actions.ts",
      "admin/invitation-actions.ts",
      "admin/appointment-actions.ts",
      "admin/konto-sicherheit-actions.ts",
      "anliegen/actions.ts",
      "digest/actions.ts",
    ];
    const dateien = new Map(useServerDateien().map((d) => [d.rel, d.inhalt]));
    for (const rel of pflicht) {
      const inhalt = dateien.get(rel);
      expect(inhalt, `${rel} ist keine "use server"-Datei mehr?`).toBeDefined();
      expect(inhalt!, `${rel} importiert action-context nicht`).toContain(
        "@/lib/auth/action-context",
      );
    }
  });
});
