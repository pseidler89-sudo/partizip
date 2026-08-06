/**
 * zwei-faktor.ts — Richtlinie für die Zwei-Faktor-Pflicht bei Admin-Rollen (#59).
 *
 * Bewusst eine REINE Funktion ohne DB- oder Request-Zugriff: Die Entscheidung
 * „darf dieser Admin gerade weiterarbeiten" ist die sicherheitskritischste Stelle
 * des Blocks und muss ohne Datenbank vollständig testbar sein. Wer sie ändert,
 * ändert sie hier — und die Tests in __tests__/zwei-faktor.test.ts sagen, was
 * dabei kaputtgeht.
 *
 * ENTSCHEIDUNG SANFTE ERZWINGUNG (Owner, 2026-08-05): Admins, die es beim Rollout
 * schon gab, werden nicht sofort ausgesperrt. Für sie setzt Migration 0040 eine
 * Kulanzfrist; bis zu deren Ablauf sind die Admin-Flächen offen, die Einrichtung
 * wird aber angeboten. Danach ist sie zwingend. Grund: Es gibt genau einen Admin
 * (den Betreiber), und ein Fehler in der Einrichtung hätte ihn aus seiner eigenen
 * Plattform ausgesperrt.
 *
 * DIE FRIST IST EIN MIGRATIONSZUSTAND, KEINE KONTO-EIGENSCHAFT.
 * Gate-B 2026-08-05, BLOCKER: Zuerst war sie so gebaut, dass sie beim ersten
 * Admin-Zugriff gesetzt wird. Folge wäre gewesen, dass JEDES neu ernannte
 * Admin-Konto vierzehn Tage ohne zweiten Faktor bekommt — und dass ein Admin sich
 * diese Frist über ein neues Konto beliebig oft verlängern kann. Aus der
 * Zwei-Faktor-Pflicht wäre eine Zwei-Faktor-Pflicht-in-zwei-Wochen geworden.
 *
 * Jetzt gilt: `totp_grace_until = NULL` heißt KEINE Frist. Wer nach dem Rollout
 * Admin wird, richtet den zweiten Faktor vor dem ersten Admin-Zugriff ein; die
 * Einrichtungsseite liegt außerhalb von /admin und ist dafür jederzeit erreichbar.
 */

/**
 * Höchstalter einer TOTP-Prüfung für besonders folgenreiche Aktionen (Step-up).
 * 15 Minuten ist der übliche Kompromiss: lang genug, um mehrere Freigaben am
 * Stück zu erledigen, kurz genug, dass ein unbeaufsichtigter Rechner nicht
 * stundenlang scharf bleibt.
 */
export const STEP_UP_MAX_ALTER_MINUTEN = 15;

/** Nur die Felder, die für die Entscheidung gebraucht werden (kein Vollmodell). */
export interface ZweiFaktorUser {
  totpSecretEnc: string | null;
  totpConfirmedAt: Date | null;
  totpGraceUntil: Date | null;
}

export interface ZweiFaktorSession {
  totpVerifiedAt: Date | null;
}

export type ZweiFaktorLage =
  /** Keine Admin-Rolle (oder Demo-Mandant) — die Pflicht greift nicht. */
  | { status: "nicht_noetig" }
  /** TOTP aktiv und in dieser Session bereits geprüft. */
  | { status: "erfuellt"; geprueftAm: Date }
  /** TOTP aktiv, aber in dieser Session noch kein Code — Code verlangen. */
  | { status: "code_faellig" }
  /** Kein TOTP, Frist läuft noch — Zugang offen, Einrichtung anbieten. */
  | { status: "einrichtung_offen"; frist: Date }
  /** Kein TOTP und keine (oder abgelaufene) Frist — Zugang zu, bis eingerichtet ist. */
  | { status: "einrichtung_erzwungen"; frist: Date | null };

/** TOTP gilt erst als aktiv, wenn ein Code bestätigt wurde. */
export function totpAktiv(user: ZweiFaktorUser): boolean {
  return user.totpSecretEnc !== null && user.totpConfirmedAt !== null;
}

/**
 * Kernentscheidung. `istAdmin` kommt aus den serverseitig geladenen Rollen —
 * niemals aus Client-Daten.
 */
export function bewerteZweiFaktor(params: {
  istAdmin: boolean;
  user: ZweiFaktorUser;
  session: ZweiFaktorSession;
  /**
   * Demo-Mandant (ADR-020). Dort vergibt die Anwendung an JEDEN Besucher auf
   * Knopfdruck ein ephemeres kommune_admin-Konto, damit er die Verwaltung
   * anschauen kann — ohne Magic-Link, ohne echte Daten, mit Seiteneffekt-Fence.
   *
   * Diese Konten unter die Zwei-Faktor-Pflicht zu stellen, hieße: Der Besucher
   * müsste eine Authenticator-App einrichten, um sich eine Demo anzusehen. Damit
   * wäre der Verwaltungs-Rundgang — das Kernstück der Akquise-Spielwiese — tot.
   * Die Ausnahme ist deshalb Absicht und steht hier, damit sie sichtbar ist statt
   * irgendwo als Sonderfall zu verschwinden.
   *
   * WARNUNG: DEMO_TENANT_SLUG darf niemals auf einen echten Mandanten zeigen —
   * das schaltete dort die Zwei-Faktor-Pflicht ab. Dieselbe Bedingung schützt
   * schon heute den Mailversand und die Rollen-Mutationen (lib/demo/config.ts).
   */
  demoMandant?: boolean;
  jetzt?: Date;
}): ZweiFaktorLage {
  const jetzt = params.jetzt ?? new Date();
  if (!params.istAdmin || params.demoMandant) return { status: "nicht_noetig" };

  if (totpAktiv(params.user)) {
    const geprueft = params.session.totpVerifiedAt;
    return geprueft ? { status: "erfuellt", geprueftAm: geprueft } : { status: "code_faellig" };
  }

  // Ab hier: Admin ohne aktives TOTP. Keine Frist = keine Kulanz (s. Kopf).
  const frist = params.user.totpGraceUntil;
  if (!frist) return { status: "einrichtung_erzwungen", frist: null };
  return jetzt < frist
    ? { status: "einrichtung_offen", frist }
    : { status: "einrichtung_erzwungen", frist };
}

/** Darf mit dieser Lage auf Admin-Flächen zugegriffen werden? */
export function zugangErlaubt(lage: ZweiFaktorLage): boolean {
  return (
    lage.status === "nicht_noetig" ||
    lage.status === "erfuellt" ||
    lage.status === "einrichtung_offen"
  );
}

/**
 * Ist diese Session gut genug für eine besonders folgenreiche Aktion (Step-up)?
 *
 * Zwei Fälle, und die Unterscheidung ist der Kern der Owner-Entscheidung:
 *
 *   1. TOTP ist aktiv → es muss eine FRISCHE Prüfung vorliegen. Das ist der
 *      eigentliche Zweck von Step-up.
 *   2. TOTP ist nicht aktiv → es zählt die Kulanzfrist. Solange sie läuft, bleibt
 *      die Aktion offen; danach ist sie zu.
 *
 * Fall 2 ist bewusst so und war zuerst anders gebaut: Hätte Step-up ohne
 * eingerichtetes TOTP immer gesperrt, wäre die „sanfte Frist" für die wichtigsten
 * Aktionen — Veröffentlichen, Freigeben, Rollenvergabe — vom ersten Tag an eine
 * harte Sperre gewesen. Genau das sollte die Frist verhindern. Der Nachdruck
 * kommt über den Nudge und das Fristende, nicht über eine stille Teilsperre.
 */
export function stepUpErfuellt(params: {
  user: ZweiFaktorUser;
  session: ZweiFaktorSession;
  /** Demo-Mandant: keine Pflicht, gleiche Begründung wie in bewerteZweiFaktor. */
  demoMandant?: boolean;
  jetzt?: Date;
}): boolean {
  const jetzt = params.jetzt ?? new Date();
  if (params.demoMandant) return true;

  if (!totpAktiv(params.user)) {
    // Keine Frist = keine Kulanz. Vorher stand hier `return true` für den Fall
    // „Frist noch nicht gesetzt" — das war die zweite Hälfte des Gate-B-Blockers:
    // Ein Admin, der nur Server Actions aufruft und nie eine /admin-Seite lädt,
    // hätte nie eine Frist bekommen und wäre damit DAUERHAFT ohne zweiten Faktor
    // an Rollenvergabe und Veröffentlichung gekommen.
    if (!params.user.totpGraceUntil) return false;
    return jetzt < params.user.totpGraceUntil;
  }

  const geprueft = params.session.totpVerifiedAt;
  if (!geprueft) return false;
  const alterMinuten = (jetzt.getTime() - geprueft.getTime()) / 60_000;
  // Ein Zeitstempel aus der Zukunft (Uhrensprung, manipulierte Zeile) zählt nicht
  // als frisch, sondern als ungültig.
  if (alterMinuten < 0) return false;
  return alterMinuten <= STEP_UP_MAX_ALTER_MINUTEN;
}
