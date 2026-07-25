/**
 * lib/kontakt.ts — zentrale Kontaktwege (SSOT).
 *
 * Terminbuchung (Tymeslot) ist der primäre Kontaktweg für Demo-Anfragen:
 * eine Buchung erzeugt über den Tymeslot-Webhook automatisch einen Lead.
 * E-Mail bleibt als Fallback erreichbar — nicht jeder will buchen.
 * Beide Werte existieren bewusst nur hier (keine zweiten Hardcodes in Seiten).
 */

/** Terminbuchung (Tymeslot, live). Immer machbar, keine Config nötig. */
export const TERMIN_URL = "https://termine.partizip.online/seidler";

/** Zentrale Kontakt-Adresse (E-Mail-Fallback zur Terminbuchung). */
export const KONTAKT_EMAIL = "kontakt@partizip.online";
