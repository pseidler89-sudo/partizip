/**
 * zuletzt-aktiv.ts — relative „Zuletzt aktiv"-Formatierung (Block K4, Teil A).
 *
 * REINE Funktionen (kein DB-/Request-Kontext), damit die Kalendertag-Logik
 * zeitstabil unit-testbar ist (Gate-B K4 MINOR): eine naive Millisekunden-
 * Division machte den „heute"-Zweig unerreichbar (heutiger Login ⇒ floor(-0,25)
 * = -1 ⇒ „gestern"; 25 h ⇒ „vor 2 Tagen"). Korrekt ist die KALENDERTAG-
 * Differenz: beide Zeitpunkte werden auf ihren Kalendertag in Europe/Berlin
 * normalisiert (konsistent zur übrigen Datums-Formatierung der App), erst dann
 * wird die Tagesdifferenz gebildet und an Intl.RelativeTimeFormat gegeben.
 */

/** Kalendertag "YYYY-MM-DD" eines Zeitpunkts in Europe/Berlin. */
function berlinKalendertag(d: Date): string {
  // en-CA liefert das ISO-Format YYYY-MM-DD direkt.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Differenz in KALENDERTAGEN (Europe/Berlin) zwischen `then` und `jetzt`
 * (negativ = Vergangenheit). Ein Login gestern 23:59 ist „vor 1 Tag", egal ob
 * seither 2 Minuten oder 23 Stunden vergangen sind; ein Login heute 00:01
 * bleibt „heute". DST-sicher: die Tagesbeginn-Normalisierung läuft über die
 * formatierten Kalenderdaten (UTC-Mitternacht der Wandtage), nicht über
 * 24-h-Arithmetik auf den Roh-Zeitstempeln.
 */
export function kalendertagDiffBerlin(then: Date, jetzt: Date): number {
  const [tThen, tJetzt] = [berlinKalendertag(then), berlinKalendertag(jetzt)];
  // "YYYY-MM-DD" + T00:00Z ⇒ UTC-Mitternacht beider Kalendertage; die Differenz
  // ist dadurch immer ein ganzzahliges Vielfaches von 24 h (kein DST-Rest).
  const diffMs = Date.parse(`${tThen}T00:00:00Z`) - Date.parse(`${tJetzt}T00:00:00Z`);
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Relative „Zuletzt aktiv"-Angabe aus dem ISO-Login-Zeitstempel (deutsch,
 * Intl.RelativeTimeFormat mit numeric:"auto" ⇒ „gestern"/„vor N Tagen");
 * heutiger Kalendertag ⇒ „heute". `jetzt` ist injizierbar für zeitstabile Tests.
 */
export function zuletztAktivLabel(iso: string | null, jetzt: Date = new Date()): string {
  if (!iso) return "Noch nie angemeldet";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "Noch nie angemeldet";
  const tageDiff = kalendertagDiffBerlin(then, jetzt);
  if (tageDiff === 0) return "Zuletzt aktiv: heute";
  const rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
  return `Zuletzt aktiv: ${rtf.format(tageDiff, "day")}`;
}
