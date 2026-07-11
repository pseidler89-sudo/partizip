/**
 * host.ts — Host-Normalisierung (MIN4)
 *
 * Gemeinsame Funktion für middleware.ts und tenant.ts, um Duplikat-Logik
 * zu vermeiden und konsistente Host-Verarbeitung zu garantieren.
 *
 * Normalisierungsregeln:
 *   - Lowercase (HTTP-Header-Werte sind case-insensitiv per RFC 7230)
 *   - Trailing Dot entfernen (FQDN-Notation: "host." → "host")
 */

/**
 * Normalisiert einen Host-Header-Wert.
 * Gilt für den kompletten Host-String inkl. optionalem Port.
 */
export function normalizeHost(host: string): string {
  // Lowercase
  let h = host.toLowerCase();
  // Trailing dot vor optionalem Port entfernen: "host.:port" oder "host."
  // Format: [hostname][.][:[port]]
  // Einfacher: hostname-Teil (vor ":") trailing-dot strippen
  const colonIdx = h.indexOf(":");
  if (colonIdx === -1) {
    // Kein Port
    h = h.replace(/\.$/, "");
  } else {
    const hostname = h.slice(0, colonIdx).replace(/\.$/, "");
    h = hostname + h.slice(colonIdx);
  }
  return h;
}

/**
 * Extrahiert den Tenant-Slug aus einem (bereits normalisierten) Host-Header-Wert.
 *
 * Unterstützte Formate:
 *   <slug>.partizip.online   → Produktion
 *   <slug>.localhost[:port]  → Lokale Entwicklung
 *
 * Haupt-Domains → null.
 */

// Haupt-Domains → keine Tenant-Auflösung (Single-Domain-Einstieg via PILOT_TENANT_SLUG).
// `staging.partizip.online` ist bewusst ein NEUTRALER Single-Domain-Einstieg für den
// Pilot/Pitch (kein Tenant-Slug in der URL) — verhält sich wie die produktive
// Haupt-Domain, nur auf dem Staging-Stack (eigener PILOT_TENANT_SLUG + Basic-Auth).
const MAIN_HOSTNAMES = new Set([
  "partizip.online",
  "www.partizip.online",
  "staging.partizip.online",
  "localhost",
  "127.0.0.1",
]);

export function slugFromNormalizedHost(host: string): string | null {
  // Port entfernen für Vergleiche
  const hostname = host.split(":")[0];

  if (MAIN_HOSTNAMES.has(hostname)) return null;
  if (hostname.startsWith("www.")) return null;

  if (hostname.endsWith(".partizip.online")) {
    const slug = hostname.slice(0, -".partizip.online".length);
    return slug.length > 0 ? slug : null;
  }

  if (hostname.endsWith(".localhost")) {
    const slug = hostname.slice(0, -".localhost".length);
    return slug.length > 0 ? slug : null;
  }

  return null;
}

/**
 * Ist der Host eine bekannte Haupt-Domain (kein Tenant-Subdomain)?
 *
 * Akzeptiert rohe oder normalisierte Hosts (normalisiert intern). Nur die
 * ausdrücklich bekannten Haupt-Domains (partizip.online, www.*, localhost,
 * 127.0.0.1) gelten als Main-Domain — UNbekannte Hosts NICHT (kein
 * versehentliches Pilot-Mapping für Fremd-Hosts; ADR-015 Single-Domain).
 */
export function isMainDomain(host: string): boolean {
  const hostname = normalizeHost(host).split(":")[0];
  return MAIN_HOSTNAMES.has(hostname);
}
