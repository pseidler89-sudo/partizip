/**
 * zwei-faktor.ts — Richtlinie für die Zwei-Faktor-Pflicht bei Admin-Rollen (#59).
 *
 * Bewusst eine REINE Funktion ohne DB- oder Request-Zugriff: Die Entscheidung
 * „darf dieser Admin gerade weiterarbeiten" ist die sicherheitskritischste Stelle
 * des Blocks und muss ohne Datenbank vollständig testbar sein. Wer sie ändert,
 * ändert sie hier — und die Tests in __tests__/zwei-faktor.test.ts sagen, was
 * dabei kaputtgeht.
 *
 * ENTSCHEIDUNG SANFTE ERZWINGUNG (Owner, 2026-08-05): Bestehende Admins werden
 * nicht sofort ausgesperrt. Beim ersten Admin-Zugriff nach dem Rollout beginnt
 * eine Kulanzfrist; bis zu deren Ablauf sind die Admin-Flächen offen, aber die
 * Einrichtung wird angeboten. Danach ist sie zwingend. Grund: Es gibt genau einen
 * Admin (den Betreiber), und ein Fehler in der Einrichtung hätte ihn aus seiner
 * eigenen Plattform ausgesperrt.
 */

/** Länge der Kulanzfrist ab dem ersten Admin-Zugriff nach dem Rollout. */
export const TOTP_KULANZ_TAGE = 14;

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
  /** Keine Admin-Rolle — die Pflicht greift nicht. */
  | { status: "nicht_noetig" }
  /** TOTP aktiv und in dieser Session bereits geprüft. */
  | { status: "erfuellt"; geprueftAm: Date }
  /** TOTP aktiv, aber in dieser Session noch kein Code — Code verlangen. */
  | { status: "code_faellig" }
  /** Kein TOTP, Frist läuft noch — Zugang offen, Einrichtung anbieten. */
  | { status: "einrichtung_offen"; frist: Date }
  /** Kein TOTP und Frist abgelaufen — Zugang zu, bis eingerichtet ist. */
  | { status: "einrichtung_erzwungen"; frist: Date }
  /** Kein TOTP und noch keine Frist gesetzt — Aufrufer muss sie setzen. */
  | { status: "frist_setzen"; vorschlag: Date };

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
  jetzt?: Date;
}): ZweiFaktorLage {
  const jetzt = params.jetzt ?? new Date();
  if (!params.istAdmin) return { status: "nicht_noetig" };

  if (totpAktiv(params.user)) {
    const geprueft = params.session.totpVerifiedAt;
    return geprueft ? { status: "erfuellt", geprueftAm: geprueft } : { status: "code_faellig" };
  }

  // Ab hier: Admin ohne aktives TOTP.
  const frist = params.user.totpGraceUntil;
  if (!frist) {
    return {
      status: "frist_setzen",
      vorschlag: new Date(jetzt.getTime() + TOTP_KULANZ_TAGE * 24 * 60 * 60 * 1000),
    };
  }
  return jetzt < frist
    ? { status: "einrichtung_offen", frist }
    : { status: "einrichtung_erzwungen", frist };
}

/** Darf mit dieser Lage auf Admin-Flächen zugegriffen werden? */
export function zugangErlaubt(lage: ZweiFaktorLage): boolean {
  return (
    lage.status === "nicht_noetig" ||
    lage.status === "erfuellt" ||
    lage.status === "einrichtung_offen" ||
    // Die Frist wird beim Zugriff gesetzt; sie darf ihn nicht selbst verhindern.
    lage.status === "frist_setzen"
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
  jetzt?: Date;
}): boolean {
  const jetzt = params.jetzt ?? new Date();

  if (!totpAktiv(params.user)) {
    // Frist noch nicht gesetzt (erster Admin-Zugriff): offen — der Aufrufer setzt
    // sie im selben Durchlauf.
    if (!params.user.totpGraceUntil) return true;
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
