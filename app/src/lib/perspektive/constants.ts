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

/** Cookie-Wert der Aufgaben-Perspektive. */
export const PERSPEKTIVE_AUFGABEN = "aufgaben";

/**
 * Cookie-Wert der Bürger-Perspektive. Wird seit WP2 GESETZT (statt das Cookie
 * zu löschen), damit der Login-Flow eine BEWUSSTE Bürger-Wahl von „nie
 * gewechselt" unterscheiden kann (Auto-Perspektive nur ohne Bürger-Wahl).
 * Serverseitig zählt jeder andere Wert als „nicht gesetzt" (defensiv, das
 * Cookie ist Nutzereingabe und verleiht NIE ein Recht).
 */
export const PERSPEKTIVE_BUERGER = "buerger";

/** Laufzeit 30 Tage — reine Anzeige-Präferenz, kein Personenbezug. */
export const PERSPEKTIVE_MAX_AGE = 60 * 60 * 24 * 30;
