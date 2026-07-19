/**
 * oeffnungszeiten-format.ts — reiner, gemeinsam genutzter Helfer, der
 * strukturierte Öffnungszeiten (Verifizierung 2.0 / V1) in einen
 * menschenlesbaren, nach Wochentagen gruppierten String übersetzt.
 *
 * BEWUSST pur (kein DB-/Request-Kontext, kein "use server"): direkt unit-testbar
 * und sowohl von Server-Komponenten (Bürger-Liste V2) als auch von der
 * Admin-Client-Komponente (StandorteVerwaltung) nutzbar — statt die Anzeige zu
 * duplizieren. Ersetzt das frühere, ungruppierte `formatOeffnungKurz` im Admin.
 *
 * Beispiel: [{tag:1,von:"08:00",bis:"16:00"}, … Fr, {tag:6,von:"09:00",bis:"12:00"}]
 *   → „Mo–Fr 08:00–16:00, Sa 09:00–12:00".
 * Mehrere Fenster je Tag werden mit „ / " verbunden („Mo 08:00–12:00 / 14:00–16:00").
 */

import type { OeffnungszeitFenster } from "@/db/schema";

/** Kurzlabel je ISO-Wochentag (Index 1 = Mo … 7 = So; Index 0 ungenutzt). */
const ISO_TAG_KURZ = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

/**
 * Formatiert Öffnungszeiten-Fenster nach Wochentagen gruppiert. Leeres Array /
 * null / undefined → "" (der Aufrufer entscheidet über einen Ersatztext).
 *
 * Vorgehen:
 *  1. Fenster je Tag sammeln, innerhalb des Tages nach Beginn sortiert und mit
 *     „ / " verbunden (Signatur des Tages, z. B. „08:00–12:00 / 14:00–16:00").
 *  2. Tage 1..7 durchlaufen und AUFEINANDERFOLGENDE Tage mit identischer Signatur
 *     zu Läufen zusammenfassen (Mo,Di,…,Fr gleich → „Mo–Fr …").
 *  3. Ein-Tages-Lauf → „Mo …", Mehr-Tages-Lauf → „Mo–Fr …". Läufe mit „, " trennen.
 * Nicht zusammenhängende Tage gleicher Signatur bleiben bewusst getrennte Läufe.
 */
export function formatOeffnungszeiten(
  oeffnungszeiten: OeffnungszeitFenster[] | null | undefined,
): string {
  if (!oeffnungszeiten || oeffnungszeiten.length === 0) return "";

  // Nur gültige ISO-Tage (1..7) berücksichtigen — defensiv gegen Altdaten.
  const proTag = new Map<number, OeffnungszeitFenster[]>();
  for (const f of oeffnungszeiten) {
    if (!Number.isInteger(f.tag) || f.tag < 1 || f.tag > 7) continue;
    const liste = proTag.get(f.tag) ?? [];
    liste.push(f);
    proTag.set(f.tag, liste);
  }
  if (proTag.size === 0) return "";

  // Signatur je Tag: Fenster nach Beginn sortiert, mit „ / " verbunden.
  const signaturProTag = new Map<number, string>();
  for (const [tag, fenster] of proTag) {
    const sig = fenster
      .slice()
      .sort((a, b) => a.von.localeCompare(b.von) || a.bis.localeCompare(b.bis))
      .map((f) => `${f.von}–${f.bis}`)
      .join(" / ");
    signaturProTag.set(tag, sig);
  }

  // Aufeinanderfolgende Tage gleicher Signatur zu Läufen bündeln.
  const teile: string[] = [];
  let laufStart: number | null = null;
  let laufEnde: number | null = null;
  let laufSig: string | null = null;

  const laufSchreiben = () => {
    if (laufStart == null || laufEnde == null || laufSig == null) return;
    const tage =
      laufStart === laufEnde
        ? ISO_TAG_KURZ[laufStart]
        : `${ISO_TAG_KURZ[laufStart]}–${ISO_TAG_KURZ[laufEnde]}`;
    teile.push(`${tage} ${laufSig}`);
  };

  for (let tag = 1; tag <= 7; tag++) {
    const sig = signaturProTag.get(tag);
    if (sig == null) {
      // Lücke beendet einen laufenden Block.
      laufSchreiben();
      laufStart = laufEnde = laufSig = null;
      continue;
    }
    if (laufSig === sig && laufEnde === tag - 1) {
      // Setzt den laufenden Block fort (gleiche Signatur, direkt anschließend).
      laufEnde = tag;
    } else {
      laufSchreiben();
      laufStart = tag;
      laufEnde = tag;
      laufSig = sig;
    }
  }
  laufSchreiben();

  return teile.join(", ");
}
