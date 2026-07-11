/**
 * isAdult — konservative Volljährigkeitsprüfung (ADR-005)
 *
 * Volljährig ist eine Person erst, wenn der Monat des 18. Geburtstags
 * VOLLSTÄNDIG abgelaufen ist:
 *   volljährig wenn: (nowYear > birthYear + 18)
 *              ODER: (nowYear === birthYear + 18 AND nowMonth > birthMonth)
 *
 * Bei NULL-Werten: false (konservativ — im Zweifel kein Zugang).
 *
 * Zeitzone: Monats- und Jahresermittlung erfolgt explizit in Europe/Berlin
 * (Intl.DateTimeFormat). Begründung: konservative Volljährigkeits-Ableitung,
 * Konzept Kap. 6 — ein UTC-Datumswechsel um Mitternacht entspricht nicht dem
 * deutschen Kalendertag (z. B. UTC 31.12. 23:30 = Berlin 01.01.).
 *
 * N5: birthMonth außerhalb 1..12 oder birthYear außerhalb 1900..aktuelles Jahr → false.
 *
 * @param birthYear  Geburtsjahr (z. B. 2000). Null/undefined → false. Außerhalb 1900..jetzt → false.
 * @param birthMonth Geburtsmonat 1–12. Null/undefined → false. 0 oder 13 → false.
 * @param now        Referenzdatum (default: Date.now()).
 */
export function isAdult(
  birthYear: number | null | undefined,
  birthMonth: number | null | undefined,
  now: Date = new Date()
): boolean {
  if (birthYear == null || birthMonth == null) return false;

  // N5: Plausibilitätsprüfung für birthMonth (1–12)
  if (birthMonth < 1 || birthMonth > 12) return false;

  // N5: Plausibilitätsprüfung für birthYear (1900..aktuelles Jahr)
  // Aktuelles Jahr für die Grenze: via Berlin-TZ ermitteln
  const berlinFormatter = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "numeric",
  });
  const parts = berlinFormatter.formatToParts(now);
  const nowYear = Number(parts.find((p) => p.type === "year")?.value ?? 0);
  const nowMonth = Number(parts.find((p) => p.type === "month")?.value ?? 0);

  if (birthYear < 1900 || birthYear > nowYear) return false;

  const eighteenthYear = birthYear + 18;

  if (nowYear > eighteenthYear) return true;
  if (nowYear === eighteenthYear && nowMonth > birthMonth) return true;
  return false;
}
