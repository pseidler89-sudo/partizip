/**
 * demo/perspektive-client.ts — Client-Helfer des Demo-Perspektiv-Umschalters.
 *
 * NUR im Browser nutzbar (document.cookie): Start-Button (/demo-verwaltung)
 * und DemoGuide-Umschalter teilen sich hier das Setzen/Löschen des reinen
 * UI-Präferenz-Cookies, damit Attribute (Path/SameSite/Secure/Max-Age) nie
 * auseinanderlaufen. Am Cookie hängt kein Recht (siehe demo/constants.ts).
 */

import {
  DEMO_PERSPEKTIVE_COOKIE,
  DEMO_PERSPEKTIVE_MAX_AGE,
  DEMO_PERSPEKTIVE_VERWALTUNG,
  DEMO_VERWALTUNG_SCHRITT_KEY,
} from "@/lib/demo/constants";

// Mini-Store fürs useSyncExternalStore-Muster: Cookie/sessionStorage sind
// externe Systeme — der Guide liest sie als Snapshot (hydration-sicher, SSR
// liefert den Bürger-Default) und wird über emit() benachrichtigt, wenn UNSERE
// Setter sie ändern (mehr Änderungsquellen gibt es nicht).
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe für useSyncExternalStore (Perspektive UND Schrittzähler). */
export function subscribeDemoPerspektive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Secure in Prod (https), lokal via http weglassen — Muster SpaeterKnopf. */
function secureFlag(): string {
  return window.location.protocol === "https:" ? "; Secure" : "";
}

/** Merkt die Verwaltungs-Perspektive für 12 h (passend zur Session-TTL). */
export function setzePerspektiveVerwaltung(): void {
  document.cookie =
    `${DEMO_PERSPEKTIVE_COOKIE}=${DEMO_PERSPEKTIVE_VERWALTUNG}; Path=/; ` +
    `Max-Age=${DEMO_PERSPEKTIVE_MAX_AGE}; SameSite=Lax${secureFlag()}`;
  emit();
}

/** Zurück zur Bürger-Perspektive: Cookie sofort löschen (Max-Age=0). */
export function loeschePerspektive(): void {
  document.cookie = `${DEMO_PERSPEKTIVE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secureFlag()}`;
  emit();
}

/** Liest die aktive Perspektive aus document.cookie (Snapshot, Client). */
export function istVerwaltungsPerspektive(): boolean {
  return document.cookie
    .split(";")
    .some(
      (c) => c.trim() === `${DEMO_PERSPEKTIVE_COOKIE}=${DEMO_PERSPEKTIVE_VERWALTUNG}`,
    );
}

/** Obergrenze des Schrittzählers (Anzahl Verwaltungs-Schritte im Guide). */
export const DEMO_VERWALTUNG_SCHRITTE_MAX = 6;

/** sessionStorage lesen — fehlertolerant (Privacy-Modi), auf 1–6 geklemmt. */
export function gespeicherterSchritt(): number {
  try {
    const raw = window.sessionStorage.getItem(DEMO_VERWALTUNG_SCHRITT_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 1;
    return Number.isInteger(n) && n >= 1 && n <= DEMO_VERWALTUNG_SCHRITTE_MAX ? n : 1;
  } catch {
    return 1;
  }
}

/** Schrittzähler setzen (geklemmt); sessionStorage endet mit dem Tab. */
export function speichereSchritt(n: number): number {
  const geklemmt = Math.min(Math.max(n, 1), DEMO_VERWALTUNG_SCHRITTE_MAX);
  try {
    window.sessionStorage.setItem(DEMO_VERWALTUNG_SCHRITT_KEY, String(geklemmt));
  } catch {
    // sessionStorage gesperrt → der Snapshot bleibt beim Default; der CTA-Link
    // je Schritt funktioniert trotzdem.
  }
  emit();
  return geklemmt;
}
