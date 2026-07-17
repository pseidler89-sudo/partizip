/**
 * demo/constants.ts — geteilte Konstanten des Demo-Perspektiv-Umschalters.
 *
 * Bewusst ohne Server-/DB-/env-Abhängigkeiten (Muster lib/konto/constants.ts),
 * damit Client-Komponenten sie importieren können, ohne Server-Code ins Bundle
 * zu ziehen. Am Cookie hängt KEIN Recht — die Verwaltungs-Berechtigung kommt
 * ausschließlich aus der serverseitigen Session + kommune_admin-Rolle
 * (demoVerwaltungStarten); das Cookie steuert nur, welche Rundgang-Schritte
 * der DemoGuide anzeigt.
 */

/**
 * UI-Präferenz-Cookie der Demo-Perspektive (nur auf dem Demo-Mandanten gesetzt).
 * KEIN httpOnly — der Client schreibt und liest es selbst via document.cookie.
 */
export const DEMO_PERSPEKTIVE_COOKIE = "pz_demo_perspektive";

/** Cookie-Wert der Verwaltungs-Perspektive (einziger gesetzter Wert). */
export const DEMO_PERSPEKTIVE_VERWALTUNG = "verwaltung";

/** Laufzeit 12 h — passend zur TTL der ephemeren Demo-Session (actions.ts). */
export const DEMO_PERSPEKTIVE_MAX_AGE = 60 * 60 * 12;

/** sessionStorage-Schlüssel des Schrittzählers im Verwaltungs-Rundgang. */
export const DEMO_VERWALTUNG_SCHRITT_KEY = "pz_demo_verwaltung_schritt";
