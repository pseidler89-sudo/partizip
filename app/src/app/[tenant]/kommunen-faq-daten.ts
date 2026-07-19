/**
 * kommunen-faq-daten.ts — kompakte FAQ für Multiplikatoren (Kommune/Kreis/Verein/
 * Verwaltung), genutzt in Stufe 2 des „Mitmachen"-Trichters (/mitmachen, Block N4).
 *
 * Bewusst getrennt von der Bürger-FAQ (faq-daten.ts): andere Zielgruppe, andere
 * Fragen (Kosten, Vorlauf, Datenschutz/Hosting, was gebraucht wird,
 * Überparteilichkeit). Ton „Sie".
 */

export const KOMMUNEN_FAQ: { f: string; a: string }[] = [
  {
    f: "Was kostet Partizip für unsere Kommune?",
    a: "Für Bürgerinnen und Bürger ist die Teilnahme immer kostenlos. Die Konditionen für Kommunen und Vereine besprechen wir im persönlichen Gespräch — im Pilotbetrieb bewusst niedrigschwellig. Es entstehen keine versteckten Kosten und kein Datenhandel: Das Werkzeug ist das Produkt, nicht Ihre Daten.",
  },
  {
    f: "Wie lange dauert es, bis wir startklar sind?",
    a: "In der Regel wenige Tage. Wir richten Ihren Mandanten ein, hinterlegen Ihre Ortsteile und eine Kontaktperson — danach können Sie die erste Frage stellen. Es ist keine eigene IT-Infrastruktur nötig.",
  },
  {
    f: "Was brauchen Sie von uns?",
    a: "Sehr wenig: eine Ansprechperson bei Ihnen sowie die Liste Ihrer Ortsteile bzw. Postleitzahlen. Mehr ist für den Start nicht erforderlich — kein Melderegister-Zugriff, keine Bürgerdaten.",
  },
  {
    f: "Wie steht es um Datenschutz und Hosting?",
    a: "Die Plattform ist DSGVO-konform und wird ausschließlich in Deutschland gehostet (Hetzner, Auftragsverarbeitung nach Art. 28 DSGVO). Wir erheben so wenige Daten wie möglich, setzen kein Tracking ein und geben keine Daten zu kommerziellen Zwecken weiter. Wo möglich, speichern wir Pseudonyme statt Klardaten.",
  },
  {
    f: "Ist die Plattform barrierefrei?",
    a: "Ja. Wir orientieren uns an WCAG 2.1 AA: Bedienung per Tastatur, ausreichende Kontraste, verständliche Sprache. Alles läuft im Browser — ohne App, am Handy, Tablet oder Computer.",
  },
  {
    f: "Was passiert mit den Daten am Ende?",
    a: "Bürgerkonten führen keinen Klarnamen; Stimmen werden pseudonym und getrennt von der Person gezählt (geheime Wahl). Nutzerinnen und Nutzer können ihr Konto jederzeit selbst löschen. Beenden Sie die Zusammenarbeit, wird Ihr Mandant nach Absprache exportiert und gelöscht.",
  },
  {
    f: "Ist Partizip an eine Partei gebunden?",
    a: "Nein. Partizip ist ausdrücklich überparteilich: keine Partei ist Kundin, Trägerin oder bevorzugte Partnerin, keine Parteilogos, kein Zugang für Parteien zu Nutzerdaten. Deshalb kann auch eine Verwaltung die Plattform nutzen, ohne sich ein Parteiwerkzeug ins Haus zu holen.",
  },
];
