/**
 * identity/anzeige.ts — Reine Anzeige-Helfer für die Rollenträger-Identität
 * (Block J1). KEIN "use server", KEIN DB-/IO-Zugriff — damit die Ableitungen
 * (Initialen, Fallbacks, Fragesteller-Badge) isoliert unit-testbar sind.
 *
 * Leitplanken (Pseudonymität, bindend aus der Spec):
 *   - Klarname/Funktion gibt es NUR für Rollenträger. Für reine Bürger sind die
 *     Felder immer NULL (die Konto-UI bietet sie nur Rollenträgern an); diese
 *     Helfer geben Person/Funktion daher ausschließlich frei, wenn ein
 *     display_name vorliegt UND der Betreffende Rollenträger ist.
 *   - Fehlt der Klarname eines Rollenträgers (weiche Durchsetzung), greift der
 *     neutrale Institutions-Fallback — nie ein Roh-Feld, nie eine E-Mail.
 */

/**
 * Bildet die Initialen aus einem Klarnamen (max. 2 Buchstaben, Großschrift).
 *
 * Robust bei: mehreren Leerzeichen, Bindestrich-Namen, Unicode (nutzt
 * code-point-sichere Iteration statt `[0]`), leerer/whitespace-Eingabe → "".
 * Ein einzelnes Wort → dessen erster Buchstabe; zwei+ Wörter → erster Buchstabe
 * des ersten und des LETZTEN Wortes (Vor- + Nachname).
 */
export function initialen(displayName: string | null | undefined): string {
  if (!displayName) return "";
  // An Leerzeichen UND Bindestrichen trennen (Doppelnamen), Leeres verwerfen.
  const worte = displayName
    .trim()
    .split(/[\s-]+/u)
    .filter((w) => w.length > 0);
  if (worte.length === 0) return "";

  const ersterBuchstabe = (wort: string): string => {
    // Code-point-sicher (Array.from splittet an Grenzen, nicht an UTF-16-Einheiten).
    const cp = Array.from(wort)[0] ?? "";
    return cp.toLocaleUpperCase("de-DE");
  };

  if (worte.length === 1) {
    return ersterBuchstabe(worte[0]);
  }
  return ersterBuchstabe(worte[0]) + ersterBuchstabe(worte[worte.length - 1]);
}

/** Anzeige-Sicht eines potenziellen Rollenträgers (VM, PII-arm). */
export interface RollentraegerAnzeige {
  /** Klarname, falls hinterlegt UND Rollenträger — sonst null. */
  name: string | null;
  /** Funktions-/Amtsbezeichnung, falls hinterlegt UND Rollenträger — sonst null. */
  funktion: string | null;
  /** Institution (Tenant-/Kommunen-Anzeigename) — das primäre Vertrauenssignal. */
  institution: string;
  /** Initialen aus dem Klarnamen (leer, wenn kein anzeigbarer Name). */
  initialen: string;
  /** true, wenn der Betreffende mindestens eine Rolle trägt. */
  istRollentraeger: boolean;
}

/** Ist mindestens eine der Rollen KEINE reine Bürgerrolle (`user`)? */
export function istRollentraeger(roleTypes: readonly string[]): boolean {
  return roleTypes.some((rt) => rt !== "user");
}

/**
 * Baut die Anzeige-Sicht für einen (potenziellen) Rollenträger. Bürger (keine
 * Rolle) oder Rollenträger ohne hinterlegten Klarnamen erhalten name/funktion =
 * null; die Institution steht immer. Ein Klarname wird NUR freigegeben, wenn der
 * Betreffende auch wirklich Rollenträger ist (Doppel-Riegel: selbst wenn ein
 * ehemaliger Rollenträger einen display_name behielte, blendet ihn ein
 * leergewordenes roleTypes wieder aus).
 */
export function rollentraegerAnzeige(input: {
  displayName: string | null | undefined;
  funktion: string | null | undefined;
  roleTypes: readonly string[];
  institution: string;
}): RollentraegerAnzeige {
  const rolle = istRollentraeger(input.roleTypes);
  const name = rolle ? normalisiere(input.displayName) : null;
  // Funktion nur zusammen mit einem sichtbaren Namen zeigen (ohne Namen wäre eine
  // freischwebende Amtsbezeichnung sinnlos und potenziell irreführend).
  const funktion = name ? normalisiere(input.funktion) : null;
  return {
    name,
    funktion,
    institution: input.institution,
    initialen: name ? initialen(name) : "",
    istRollentraeger: rolle,
  };
}

/** Fragesteller-Badge einer Umfrage (Institution primär, Person sekundär). */
export interface FragestellerBadge {
  /** Institution/Kommune — immer gesetzt (primäres Vertrauenssignal). */
  institution: string;
  /** Klarname des Erstellers — nur wenn Rollenträger MIT display_name. */
  person?: string;
  /** Funktion des Erstellers — nur zusammen mit person. */
  funktion?: string;
  /** Initialen für den Avatar — nur wenn person gesetzt. */
  initialen?: string;
}

/** Der Ersteller einer Umfrage, soweit für den Badge relevant. */
export interface FragestellerErsteller {
  displayName: string | null | undefined;
  funktion: string | null | undefined;
  /** Ist der Ersteller (noch) Rollenträger? Nur dann wird die Person gezeigt. */
  istRollentraeger: boolean;
}

/**
 * Leitet den Fragesteller-Badge einer Umfrage ab.
 *
 *   - erstellt_von NULL (ersteller = null)               ⇒ nur Institution.
 *   - Ersteller ist kein Rollenträger                    ⇒ nur Institution.
 *   - Ersteller ist Rollenträger OHNE display_name       ⇒ nur Institution.
 *   - Ersteller ist Rollenträger MIT display_name        ⇒ Institution + Person
 *                                                          (+ Funktion, falls da).
 *
 * Die Institution kommt IMMER vom Aufrufer (Tenant-/Kommunen-Anzeigename); dieser
 * Helfer trifft keine Pseudonymitäts-Entscheidung über die Institution, nur über
 * die Person.
 */
export function fragestellerBadge(
  institution: string,
  ersteller: FragestellerErsteller | null,
): FragestellerBadge {
  if (!ersteller || !ersteller.istRollentraeger) {
    return { institution };
  }
  const name = normalisiere(ersteller.displayName);
  if (!name) {
    return { institution };
  }
  const funktion = normalisiere(ersteller.funktion);
  return {
    institution,
    person: name,
    ...(funktion ? { funktion } : {}),
    initialen: initialen(name),
  };
}

/** Trimmt und wandelt leere/whitespace-only Strings zu null. */
function normalisiere(wert: string | null | undefined): string | null {
  if (wert == null) return null;
  const t = wert.trim();
  return t.length > 0 ? t : null;
}
