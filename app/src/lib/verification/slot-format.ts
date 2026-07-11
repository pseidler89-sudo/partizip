/**
 * slot-format.ts — Server-seitige Datums-/Zeit-Formatierung für Termine (D6).
 *
 * Bewusst mit fixer Zeitzone Europe/Berlin + de-DE, damit die Anzeige unabhängig
 * von Server-Locale/TZ stabil ist (keine Hydration-Abweichung — wir formatieren
 * auf dem Server und reichen fertige Strings an Client-Komponenten weiter).
 */

const TZ = "Europe/Berlin";

// Mit Wochentag (für Termin-Slots): „Mi, 24. Juni 2026".
const weekdayFmt = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: TZ,
});

// Ohne Wochentag (für reine Datumsangaben wie „Gültig bis …"): „24. Juni 2026".
const dayFmt = new Intl.DateTimeFormat("de-DE", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: TZ,
});

const timeFmt = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TZ,
});

/** z. B. „Mi, 24. Juni 2026, 09:00–09:30 Uhr". */
export function formatSlotLabel(startsAt: Date, endsAt: Date): string {
  return `${weekdayFmt.format(startsAt)}, ${timeFmt.format(startsAt)}–${timeFmt.format(endsAt)} Uhr`;
}

/** z. B. „24. Juni 2026" (ohne Wochentag). */
export function formatDay(d: Date): string {
  return dayFmt.format(d);
}
