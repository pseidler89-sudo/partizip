/**
 * constants.ts — Geteilte Konstanten des Konto-Bereichs.
 *
 * Bewusst ohne Server-/DB-Abhängigkeiten, damit sowohl Client-Komponenten
 * als auch die Server-Logik dieselben Werte nutzen (kein Schema im Client-Bundle).
 */

/** Bestätigungswort gegen versehentliche Löschung (H3 DSGVO). */
export const KONTO_LOESCHEN_BESTAETIGUNG = "LÖSCHEN";

/**
 * Cookie, mit dem der Ein-Schritt-Einrichtungs-Hinweis (Fläche B) per „Später"
 * ausgeblendet wird. Reine UI-Präferenz — bewusst OHNE httpOnly, der Client
 * setzt es selbst via document.cookie; der Server liest es nur, um die Zeile
 * gar nicht erst zu rendern. Kein Recht hängt daran.
 */
export const EINRICHTUNG_SPAETER_COOKIE = "pz_einrichtung_spaeter";

/** Ausblende-Dauer des „Später"-Cookies: 30 Tage (danach leiser neuer Hinweis). */
export const EINRICHTUNG_SPAETER_MAX_AGE = 60 * 60 * 24 * 30;
