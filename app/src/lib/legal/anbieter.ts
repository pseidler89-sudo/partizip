/**
 * anbieter.ts — Zentrale Anbieter-/Pflichtangaben für Impressum & Datenschutz
 *
 * EINZIGE Stelle, an der die Pflichtangaben gepflegt werden.
 * Platzhalter (❮…❯) MÜSSEN vor Launch durch echte Angaben ersetzt werden
 * (P0-5, Freigabe der finalen Rechtstexte = Eskalation Patrick + Anwalt).
 * Quelle der Entwürfe: docs/legal/*.md
 */

export const ANBIETER = {
  // § 5 Abs. 1 Nr. 1 DDG — vollständiger Name + ladungsfähige Anschrift
  // (Angaben von Patrick geliefert 2026-07-10)
  name: "Patrick Seidler",
  strasse: "Am Sonnenhang 14",
  ort: "65232 Taunusstein",
  land: "Deutschland",
  // § 5 Abs. 1 Nr. 2 DDG — E-Mail genügt für schnelle elektronische
  // Kontaktaufnahme; Telefon ist nicht verpflichtend und bewusst weggelassen.
  email: "patrick@seidler.ml",
  telefon: "",
  // § 18 Abs. 2 MStV — V.i.S.d.P. (journalistisch-redaktionelle Digests)
  visdp: "Patrick Seidler, Anschrift wie oben",
} as const;

/** true solange Platzhalter enthalten sind — Seiten zeigen dann einen Entwurfs-Hinweis. */
export const ANGABEN_VOLLSTAENDIG = !Object.values(ANBIETER).some((v) =>
  v.includes("❮"),
);
