/**
 * zeitzone.ts — Ortszeit Europe/Berlin in einen Zeitpunkt umrechnen.
 *
 * Ratsinformationssysteme geben Sitzungstermine als deutsche ORTSZEIT aus, ohne
 * Zeitzonenangabe. Ein fest verdrahtetes "+01:00" liegt deshalb im gesamten
 * Sommerhalbjahr eine Stunde daneben — eine Sitzung um 19:30 erschien als 18:30.
 *
 * Die Umrechnung geht über Intl statt über eine Tabelle: Die Regeln für die
 * Zeitumstellung stehen damit dort, wo sie gepflegt werden (in der ICU-Datenbank
 * der Laufzeit), und nicht in unserem Code.
 *
 * HINWEIS ZUR DOPPLUNG: `allris.ts` enthält dieselbe Rechnung noch einmal. Diese
 * Datei zieht sie NICHT dort heraus, weil der ALLRIS-Parser bis nach dem Pitch
 * unter Fix-Freeze steht (zwei Härtungsrunden haben dort je eine schwerere Lücke
 * erzeugt, als sie geschlossen haben). Der geplante ALLRIS-Rewrite schwenkt auf
 * dieses Modul um; bis dahin ist die Dopplung bewusst und dokumentiert.
 */

const BERLIN_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wie weit liegt Berliner Ortszeit zu diesem Zeitpunkt vor UTC (in ms)? */
function berlinOffsetMs(timestamp: number): number {
  const parts = BERLIN_FORMATTER.formatToParts(new Date(timestamp));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    // 24 statt 0 kommt bei hour12:false für Mitternacht vor.
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asUtc - timestamp;
}

/**
 * Berliner Ortszeit → Date. Gibt null zurück, wenn die Angaben keinen gültigen
 * Zeitpunkt ergeben.
 *
 * Zwei Durchläufe: Der erste Offset stammt aus einer noch ungenauen Instanz, der
 * zweite korrigiert die Grenzfälle an den Umstellungsnächten. Ohne den zweiten
 * Durchlauf läge eine Sitzung am Umstellungstag um eine Stunde daneben.
 */
export function berlinZeitZuDate(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number
): Date | null {
  const naive = Date.UTC(y, m - 1, d, h, min);
  if (!Number.isFinite(naive)) return null;
  let ts = naive - berlinOffsetMs(naive);
  ts = naive - berlinOffsetMs(ts);
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}
