/**
 * constants.ts — Geteilte Konstanten für die Konto-Löschung (H3 DSGVO).
 *
 * Bewusst ohne Server-/DB-Abhängigkeiten, damit sowohl die Client-Komponente
 * (Bestätigungs-Eingabe) als auch die Server-Logik denselben Wert nutzen.
 */

/** Bestätigungswort gegen versehentliche Löschung. */
export const KONTO_LOESCHEN_BESTAETIGUNG = "LÖSCHEN";
