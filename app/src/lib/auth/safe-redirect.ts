/**
 * safe-redirect.ts — Open-Redirect-Schutz für Auth-Flows
 *
 * Nach der Anmeldung wird auf ein Ziel weitergeleitet, das (optional) aus
 * einem ?next=-Parameter stammt. Dieser Parameter ist Nutzereingabe und darf
 * NIEMALS auf fremde Hosts zeigen (Open-Redirect → Phishing).
 *
 * Erlaubt sind AUSSCHLIESSLICH same-origin-relative Pfade:
 *   - beginnt mit "/" (genau einem — "//host" ist protokoll-relativ und zeigt
 *     auf einen fremden Host)
 *   - kein Backslash (Browser normalisieren "\" zu "/" → "/\evil.tld" würde
 *     zu "//evil.tld")
 *   - keine Steuerzeichen (Header-/Log-Injection)
 *   - URL-Parse-Gegenprobe: relativ zu einer Dummy-Base geparst darf sich
 *     weder Origin noch Protokoll ändern
 *
 * Alles andere → Fallback (Default: /konto).
 */

/** Standard-Ziel nach erfolgreicher Anmeldung. */
export const DEFAULT_LOGIN_REDIRECT = "/konto";

/**
 * Validiert ein Redirect-Ziel. Gibt den Pfad nur zurück, wenn er ein
 * same-origin-relativer Pfad ist — sonst den Fallback.
 */
export function safeRedirectPath(
  input: unknown,
  fallback: string = DEFAULT_LOGIN_REDIRECT
): string {
  if (typeof input !== "string" || input.length === 0) return fallback;

  // Muss ein absoluter Pfad auf DIESEM Origin sein.
  if (!input.startsWith("/")) return fallback;

  // "//host" ist eine protokoll-relative URL → fremder Host.
  if (input.startsWith("//")) return fallback;

  // Backslashes und Steuerzeichen: "/\evil.tld" wird von Browsern zu
  // "//evil.tld" normalisiert; \r\n ermöglicht Header-Injection.
  if (/[\\\u0000-\u001F\u007F]/.test(input)) return fallback;

  // Gegenprobe über den URL-Parser: relativ zu einer Dummy-Base geparst
  // muss der Origin unverändert bleiben (fängt Parser-Eigenheiten ab,
  // die die String-Checks oben nicht abdecken).
  try {
    const base = "https://internal.invalid";
    const parsed = new URL(input, base);
    if (parsed.origin !== base) return fallback;
  } catch {
    return fallback;
  }

  return input;
}
