/**
 * brand.ts — Plattform-Marke vs. Region-Kontext.
 *
 * Im Single-Domain-Pilot (ADR-015) ist die App durchgängig „Partizip"; die
 * Kommune ist nur Kontext (welche Abstimmungen man sieht), NICHT die Marke im
 * Kopf der Seite. So bleibt der Einstieg neutral „Partizip", und die Kommune
 * erscheint erst, nachdem man seine PLZ eingegeben hat (Region-Banner).
 */

/** Plattform-Marke (Kopfzeile, Hero-Badge). */
export const PLATFORM_NAME = "Partizip";

/**
 * Civic-Teal als Hex — Single Source of Truth für Kontexte OHNE CSS-Variablen
 * (E-Mail-Templates: Inline-Styles, keine `var(--pz-brand)`-Auflösung im Client).
 * Muss mit `--pz-brand` / `--pz-brand-strong` in globals.css übereinstimmen
 * (Variante A — Civic-Salbei). `BRAND_COLOR` auf Weiß ≈ 5.5:1 (AA für Buttons/Text).
 */
export const BRAND_COLOR = "#0d6a70";
export const BRAND_COLOR_STRONG = "#0a565b";

/**
 * Anzeige-Name einer Kommune/Region — entfernt interne Suffixe wie „(Staging)",
 * „(Demo)" oder „(Test)", die Bürger nie sehen sollen.
 */
export function regionDisplayName(name: string): string {
  return name.replace(/\s*\((?:Staging|Demo|Test)\)\s*$/i, "").trim();
}
