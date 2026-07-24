/**
 * login-ziel.ts — Serverseitige Entscheidung des Redirect-Ziels nach Login (WP2).
 *
 * REINE, unit-testbare Funktion (kein DB-/Request-Zugriff): POST /api/auth/verify
 * ruft sie nach erfolgreicher Session-Erzeugung auf und gibt das Ergebnis als
 * `redirectTo` an den Client zurück.
 *
 * Regeln (in dieser Reihenfolge):
 *   1. Explizites ?next= (roh vom Client durchgereicht) SCHLÄGT die
 *      Auto-Perspektive — z. B. künftige Einladungs-Rückkehr. Es wird IMMER
 *      durch safeRedirectPath validiert (Open-Redirect-Schutz; ungültig →
 *      DEFAULT_LOGIN_REDIRECT, KEIN Auto-/aufgaben-Fallback).
 *   2. Sonst: Rollenträger (hatAufgaben, account_status-gefiltert) auf einem
 *      Nicht-Demo-Tenant landen auf /aufgaben — AUSSER sie haben zuletzt
 *      bewusst die Bürger-Ansicht gewählt (Cookie-Wert exakt 'buerger').
 *   3. Alle anderen: DEFAULT_LOGIN_REDIRECT (/umfragen, unverändert).
 *
 * HARTE INVARIANTE: das Cookie pz_perspektive verleiht NIE ein Recht. Es wird
 * hier ausschließlich ausgewertet, wenn hatAufgaben(roleTypes) bereits true ist
 * (Kurzschluss davor) — ein Bürger mit manipuliertem Cookie landet unverändert
 * auf /umfragen; und selbst wer /aufgaben direkt ansteuert, wird vom dortigen
 * serverseitigen Guard weg-redirectet. Der Cookie-Wert ist Nutzereingabe und
 * wird defensiv geparst (Muster parseRegionCookie): NUR die exakten Strings
 * 'aufgaben'/'buerger' zählen, alles andere gilt als „nicht gesetzt".
 *
 * Jeder Rückgabewert läuft durch safeRedirectPath — es verlässt diese Funktion
 * nie ein unvalidierter Pfad.
 */

import { DEFAULT_LOGIN_REDIRECT, safeRedirectPath } from "@/lib/auth/safe-redirect";
import { hatAufgaben } from "@/lib/aufgaben/kacheln";
import {
  PERSPEKTIVE_AUFGABEN,
  PERSPEKTIVE_BUERGER,
} from "@/lib/perspektive/constants";

export interface LoginZielInput {
  /** account_status-gefilterte Rollen des frisch eingeloggten Users. */
  roleTypes: string[];
  /** Roher Wert des pz_perspektive-Cookies (oder null/undefined = nicht gesetzt). */
  cookieWert: string | null | undefined;
  /** Roher ?next=-Parameter der Verify-Seite (oder null, wenn keiner in der URL stand). */
  explicitNext: string | null;
  /** Demo-Mandant? Dort keine Auto-Perspektive (eigener Demo-Track). */
  istDemo: boolean;
}

/**
 * Defensives Parsen der UI-Präferenz: nur die exakten bekannten Werte zählen,
 * jeder andere Inhalt (Müll, Injection-Versuche) gilt als „nicht gesetzt".
 */
function parsePerspektiveCookie(
  raw: string | null | undefined,
): typeof PERSPEKTIVE_AUFGABEN | typeof PERSPEKTIVE_BUERGER | null {
  if (raw === PERSPEKTIVE_AUFGABEN) return PERSPEKTIVE_AUFGABEN;
  if (raw === PERSPEKTIVE_BUERGER) return PERSPEKTIVE_BUERGER;
  return null;
}

/** Entscheidet das Redirect-Ziel nach erfolgreichem Login. Immer safe-validiert. */
export function bestimmeLoginZiel(input: LoginZielInput): string {
  const { roleTypes, cookieWert, explicitNext, istDemo } = input;

  // 1) Explizites next schlägt die Auto-Perspektive. Leerstring = kein next.
  if (typeof explicitNext === "string" && explicitNext.length > 0) {
    return safeRedirectPath(explicitNext);
  }

  // 2) Auto-Perspektive NUR für echte Rollenträger außerhalb der Demo. Das
  //    Cookie wird erst NACH der Rollen-Prüfung angefasst (Invariante oben).
  if (hatAufgaben(roleTypes) && !istDemo) {
    const praeferenz = parsePerspektiveCookie(cookieWert);
    if (praeferenz !== PERSPEKTIVE_BUERGER) {
      // Kein Cookie oder 'aufgaben' → Aufgaben-Einstieg (safe-validiert).
      return safeRedirectPath("/aufgaben");
    }
  }

  // 3) Default bleibt unverändert (/umfragen).
  return safeRedirectPath(DEFAULT_LOGIN_REDIRECT);
}
