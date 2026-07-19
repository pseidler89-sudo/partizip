/**
 * perspektive/constants.ts — Konstanten des Rollenträger-Perspektiv-Umschalters.
 *
 * Bewusst ohne Server-/DB-/env-Abhängigkeiten (Muster demo/constants.ts), damit
 * Client-Komponenten sie importieren können, ohne Server-Code ins Bundle zu
 * ziehen. Am Cookie hängt KEIN Recht — die echten Fähigkeiten (canVerify/
 * canRedaktion/isAdmin/canBeobachten) kommen ausschließlich aus den Rollen
 * (serverseitig, account_status-gefiltert). Das Cookie merkt sich NUR die
 * zuletzt gewählte Ansicht (Bürger ⇄ Aufgaben) als reine UI-Präferenz.
 */

/** UI-Präferenz-Cookie der Rollenträger-Perspektive. KEIN httpOnly (Client liest/schreibt). */
export const PERSPEKTIVE_COOKIE = "pz_perspektive";

/** Cookie-Wert der Aufgaben-Perspektive (einziger gesetzter Wert; „buerger" = gelöscht). */
export const PERSPEKTIVE_AUFGABEN = "aufgaben";

/** Laufzeit 30 Tage — reine Anzeige-Präferenz, kein Personenbezug. */
export const PERSPEKTIVE_MAX_AGE = 60 * 60 * 24 * 30;
