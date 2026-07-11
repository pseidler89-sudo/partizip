/**
 * demo/config.ts — Kennzeichnung des Demo-Mandanten (Akquise-Spielwiese).
 *
 * EIN Tenant der Installation kann per env `DEMO_TENANT_SLUG` zum Demo-Mandanten
 * erklärt werden (analog `PILOT_TENANT_SLUG`-Muster, bewusst env statt DB-Spalte:
 * kein Schema-Change, je Deployment steuerbar, auf Staging/Prod unabhängig).
 *
 * Auf dem Demo-Mandanten gelten drei bewusste Demo-Abweichungen (alle serverseitig
 * an isDemoTenant gebunden, NIE auf anderen Mandanten wirksam):
 *   1. Die PLZ-Haustür wird übersprungen (Besucher landen direkt in der Sicht).
 *   2. Abstimmen erzeugt bei Bedarf eine EPHEMERE Demo-Session (lib/demo/actions.ts)
 *      statt des Magic-Link-Logins — gedeckelt, nächtlich zurückgesetzt.
 *   3. Ein nicht schließbares Banner kennzeichnet die Seite als Spielwiese.
 */

/**
 * Kennung synthetischer Demo-Konten (RFC-2606 .invalid — nie zustellbar).
 * Liegt hier (nicht in actions.ts), weil "use server"-Dateien nur Actions
 * exportieren dürfen; Reset-Skript und Action teilen sich diese Konstante.
 */
export const DEMO_EMAIL_DOMAIN = "demo.invalid";

/** Slug des Demo-Mandanten (z. B. "demo" → demo.partizip.online) oder null. */
export function demoTenantSlug(): string | null {
  const slug = process.env.DEMO_TENANT_SLUG?.trim().toLowerCase();
  return slug && slug.length > 0 ? slug : null;
}

/** Ist der gegebene Tenant-Slug der Demo-Mandant dieser Installation? */
export function isDemoTenant(slug: string): boolean {
  const demo = demoTenantSlug();
  return demo !== null && slug === demo;
}
