/**
 * anleitung-daten.ts — Inhalte der Anleitung als DATEN (eine Quelle).
 *
 * Analog zu faq-daten.ts: Texte stehen hier, nicht in den Komponenten. Wer eine
 * Formulierung ändern will, fasst ausschließlich diese Datei an — die Seiten
 * (page.tsx) rendern nur noch.
 *
 * AUFBAU je Spur (Konzept TUTORIAL_KONZEPT_2026-08.md, Abschnitt d):
 *   erster Satz → „So läuft es ab" (nummerierte Schritte, je Schritt HÖCHSTENS
 *   ein Link in die App) → „Das sollten Sie wissen" → Nachschlag-Fragen.
 *
 * REGELN FÜR DIESE DATEI (bitte beim Ändern einhalten):
 *   1. Jede fachliche Aussage muss am Code belegbar sein. Die Belegstellen
 *      stehen als Kommentar über der jeweiligen Aussage. Ändert sich der Code,
 *      ändert sich der Text mit.
 *   2. KEINE Screens nachbauen, KEINE Knopf-Positionen beschreiben („grüner
 *      Knopf links oben"). Die Anleitung erklärt Bedeutung und Reihenfolge und
 *      verlinkt dann an die echte Stelle — sonst veraltet sie bei jedem
 *      UI-Feinschliff.
 *   3. Sie-Anrede, sachlich, keine Werbesprache. Neutrale Beispiele
 *      (Wochenmarkt, Spielplatz, Radweg) — nie parteipolitisch Belastetes.
 *   4. Keine Doppelpflege: was schon in der FAQ steht, wird verlinkt statt
 *      wiederholt (`weiter`-Links).
 *
 * BEWUSST NICHT ENTHALTEN: eine Spur für die Betreiberrolle (`super_admin`).
 * Betreiber-Wissen (Bootstrap, Break-Glass, Deploy) gehört in die internen
 * Runbooks, nicht in eine öffentliche Anleitung.
 */

/**
 * Ein Link aus der Anleitung heraus.
 *
 * `href` ist per Konvention TENANT-RELATIV und beginnt mit „/" (die Seite setzt
 * `/${slug}` davor). Nur mit `absolut: true` wird der Pfad unverändert benutzt —
 * das braucht ausschließlich das statische Präsentations-Deck unter
 * `/praesentation` (in der Middleware bewusst vom Tenant-Rewrite ausgenommen).
 */
export interface AnleitungLink {
  label: string;
  href: string;
  /** true ⇒ `href` ist ein absoluter Pfad ohne Tenant-Präfix. */
  absolut?: boolean;
}

/** Ein nummerierter Schritt in „So läuft es ab". */
export interface AnleitungSchritt {
  titel: string;
  text: string;
  /** Höchstens EIN Sprung-Link je Schritt (Konzept d). */
  link?: AnleitungLink;
}

/** Ein Punkt aus „Das sollten Sie wissen" — das, wonach niemand von selbst fragt. */
export interface AnleitungHinweis {
  titel: string;
  text: string;
}

/** Eine Nachschlag-Frage (rendert als details/summary, ohne JavaScript bedienbar). */
export interface AnleitungFrage {
  f: string;
  a: string;
}

/** Eine vollständige Spur. */
export interface AnleitungSpur {
  /** Anker-Id (URL-Fragment) — stabil halten, sie wird verlinkt. */
  id: string;
  titel: string;
  /** Eine Zeile für Inhaltsverzeichnis und Rollen-Hinweis auf der Abholseite. */
  kurz: string;
  ersterSatz: string;
  schritte: AnleitungSchritt[];
  wissen: AnleitungHinweis[];
  fragen: AnleitungFrage[];
  /** Weiterführende Ziele (z. B. die bestehende FAQ) — statt Inhalte zu kopieren. */
  weiter: AnleitungLink[];
}

// ---------------------------------------------------------------------------
// Abholseite: drei Karten nach der SITUATION, nicht nach dem Rollennamen.
// Bürger denken nicht in Rollen; `beobachter`/`redakteur` sind interne Begriffe.
// ---------------------------------------------------------------------------

export interface EinstiegKarte {
  key: string;
  titel: string;
  text: string;
  link: AnleitungLink;
}

export const EINSTIEG_KARTEN: EinstiegKarte[] = [
  {
    key: "mitmachen",
    titel: "Ich möchte mitmachen",
    text:
      "Sie wohnen hier und wollen bei Fragen Ihrer Kommune mitreden — vom " +
      "Wochenmarkt bis zum Radweg. Was Sie dafür brauchen und was mit Ihrer " +
      "Stimme passiert.",
    link: { label: "Zur Anleitung fürs Mitmachen", href: "/anleitung/mitmachen" },
  },
  {
    key: "aufgaben",
    titel: "Ich habe eine Aufgabe",
    text:
      "Sie arbeiten in der Kommune oder bei einer beteiligten Stelle: Wohnsitz " +
      "bestätigen, Ratsinfos schreiben, verwalten und freigeben oder mitlesen.",
    link: { label: "Zur Anleitung für Rollenträger", href: "/anleitung/aufgaben" },
  },
  {
    key: "vorstellen",
    titel: "Ich will Partizip vorstellen",
    text:
      "Sie stellen die Plattform in einer Sitzung oder einem Gespräch vor. Die " +
      "Präsentation läuft im Browser, auch ohne Netz, und lässt sich ausdrucken.",
    link: { label: "Zur Präsentation für Kommunen", href: "/praesentation", absolut: true },
  },
];

// ---------------------------------------------------------------------------
// c1 — Spur „Mitmachen" (Bürgerinnen und Bürger)
// ---------------------------------------------------------------------------

export const BUERGER_SPUR: AnleitungSpur = {
  id: "mitmachen",
  titel: "Mitmachen als Bürgerin oder Bürger",
  kurz: "Lesen, mitstimmen, Wohnsitz bestätigen lassen — und was mit Ihrer Stimme passiert.",
  ersterSatz:
    "Sie können sofort mitmachen — ohne App, ohne Passwort. Wie Sie abgestimmt " +
    "haben, erfährt niemand.",

  schritte: [
    {
      // Beleg: lib/eligibility/stufe.ts — ohne Konto gilt Stufe 0 (nur Lesen).
      titel: "Lesen geht ohne Anmeldung",
      text:
        "Laufende Abstimmungen, Ergebnisse und die Zusammenfassungen aus dem Rat " +
        "sind öffentlich. Dafür brauchen Sie kein Konto.",
      link: { label: "Aktuelle Abstimmungen ansehen", href: "/umfragen" },
    },
    {
      // Beleg: lib/auth/mail.ts (Link 15 Minuten, einmal verwendbar),
      // lib/eligibility/stufe.ts (ohne minAgeConfirmedAt bleibt es Stufe 0),
      // datenschutz/page.tsx Ziff. 4 (Session-Cookie höchstens 30 Tage).
      titel: "Mit Ihrer E-Mail-Adresse anmelden",
      text:
        "Sie geben Ihre E-Mail-Adresse an und bekommen einen Anmelde-Link " +
        "zugeschickt. Der Link gilt 15 Minuten und lässt sich nur einmal " +
        "verwenden; ein Passwort gibt es nicht. Einmalig bestätigen Sie, dass Sie " +
        "mindestens 16 Jahre alt sind. Danach bleiben Sie auf diesem Gerät " +
        "angemeldet — die Sitzung läuft nach höchstens 30 Tagen ab.",
      link: { label: "Anmelden", href: "/anmelden" },
    },
    {
      // Beleg: db/schema.ts pollTypeEnum (ja_nein_enthaltung, dot_voting,
      // widerstandsabfrage 0–10, geringster Gesamtwiderstand gewinnt),
      // PollMitmachen.tsx („Ihre Stimme wurde anonym gezählt"), lib/polls/beleg.ts.
      titel: "Abstimmen",
      text:
        "Es gibt drei Formate: Ja / Nein / Enthaltung; Punkte auf mehrere " +
        "Vorschläge verteilen; oder eine Widerstandsabfrage, bei der Sie je " +
        "Vorschlag einen Wert von 0 bis 10 vergeben — dort gewinnt der Vorschlag " +
        "mit dem geringsten Gesamtwiderstand. Nach dem Absenden wird Ihnen " +
        "einmalig ein Beleg-Code angezeigt.",
      link: { label: "Zu den Abstimmungen", href: "/umfragen" },
    },
    {
      // Beleg: verifizieren/StellenListe.tsx (Walk-in-first, Termin nur bei
      // Terminpflicht), verifizieren/MeinKontoQr.tsx (Beleg aus dem eigenen
      // Konto, Klartext-Code als Rückfallweg), lib/verification/proof-core.ts.
      titel: "Wohnsitz bestätigen lassen",
      text:
        "Für verbindliche Abstimmungen muss bestätigt sein, dass Sie hier wohnen. " +
        "Sie wählen eine Stelle in Ihrer Nähe; die meisten sind während der " +
        "Öffnungszeiten ohne Termin erreichbar, einzelne verlangen einen Termin. " +
        "Vor Ort weisen Sie sich aus und zeigen den Beleg aus Ihrem Konto. " +
        "Gespeichert wird nur, dass Ihr Wohnsitz bestätigt wurde — nichts vom Ausweis.",
      link: { label: "Stelle in Ihrer Nähe finden", href: "/verifizieren" },
    },
    {
      // Beleg: konto/page.tsx mit EmailAendernSection, WohnortSection,
      // BenachrichtigungSection, KontoLoeschenSection, konto/export/route.ts.
      titel: "Ihr Konto gehört Ihnen",
      text:
        "E-Mail-Adresse ändern, Ortsteil hinterlegen, Benachrichtigungen bei " +
        "neuen Abstimmungen ein- und ausschalten, alle zu Ihnen gespeicherten " +
        "Daten als Datei herunterladen, Konto löschen — alles selbst, ohne Anfrage " +
        "bei der Verwaltung.",
      link: { label: "Mein Konto öffnen", href: "/konto" },
    },
  ],

  wissen: [
    {
      // Beleg: lib/verification/qr-core.ts QR_VERIFICATION_MONTHS = 24;
      // lib/verification/reverify-reminders.ts DEFAULT_REVERIFY_WINDOW_DAYS = 60;
      // lib/eligibility/stufe.ts (residencyVerifiedUntil abgelaufen ⇒ Stufe 1).
      titel: "Die Wohnsitz-Bestätigung läuft nach 24 Monaten ab",
      text:
        "Rund zwei Monate vorher erinnert Sie eine E-Mail. Läuft die Bestätigung " +
        "ab, fällt Ihr Konto still eine Stufe zurück: mitstimmen weiterhin ja, " +
        "verbindlich abstimmen nein. Das ist kein Fehler, sondern so gewollt — Sie " +
        "lassen den Wohnsitz einfach neu bestätigen.",
    },
    {
      // Beleg: lib/polls/voter-ref.ts (HMAC-Pseudonym statt Konto-Bezug, Salt
      // verlässt den Server nie; im Audit steht ausschließlich der voter_ref).
      titel: "Ihre Wahl steht in keinem Protokoll",
      text:
        "An einer Stimme hängt keine Kennung Ihres Kontos, sondern ein Pseudonym, " +
        "das der Server mit einem geheimen Schlüssel berechnet. Die Verwaltung " +
        "sieht Ergebnisse, nie einzelne Stimmen; in den technischen Protokollen " +
        "steht ausschließlich dieses Pseudonym.",
    },
    {
      // Beleg: lib/polls/ergebnis.ts K_ANONYMITY_SCHWELLE = 5, serverseitige
      // Suppression; ADR-022: Aufschlüsselung erst nach Abstimmungsende.
      titel: "Kleine Gruppen werden nicht ausgewiesen",
      text:
        "Antwortoptionen mit weniger als fünf Stimmen macht schon der Server " +
        "unkenntlich — sonst ließe sich zurückrechnen, wer wie gestimmt hat. " +
        "Deshalb steht an manchen Stellen, dass es für eine Anzeige zu wenige " +
        "Stimmen sind. Solange eine Abstimmung läuft, sehen Sie nur die " +
        "Gesamtzahlen; die Aufschlüsselung nach Antworten gibt es nach dem Ende.",
    },
    {
      // Beleg: lib/polls/ergebnis.ts — zwei Signale (gesamt / verifiziert).
      titel: "Zwei Zahlen, beide echt",
      text:
        "Ergebnisse weisen die Gesamtzahl der Stimmen und die Zahl der " +
        "wohnsitzverifizierten Stimmen getrennt aus. Das erste ist ein " +
        "Stimmungsbild, das zweite ist an den bestätigten Wohnsitz gebunden.",
    },
    {
      // Beleg: faq-daten.ts (kostenlos, kein Passwort); lib/auth/mail.ts.
      titel: "Es kostet nichts und es ruft niemand an",
      text:
        "Die Teilnahme ist für Bürgerinnen und Bürger kostenlos. Es gibt kein " +
        "Passwort, das Sie vergessen könnten, und keine telefonische Nachfrage.",
    },
  ],

  fragen: [
    {
      // Beleg: lib/polls/beleg.ts (Beleg beweist DASS, nie WIE);
      // umfrage/[id]/belege/page.tsx (öffentliche Liste nach Ende);
      // PollMitmachen.tsx (Anzeige nur bei frischer Stimme, nie nachladbar).
      f: "Wozu ist der Beleg-Code nach dem Abstimmen gut?",
      a:
        "Er belegt, dass Ihre Stimme mitgezählt wurde — nicht, wie Sie gestimmt " +
        "haben. Nach dem Ende der Abstimmung finden Sie ihn in der öffentlichen " +
        "Liste der Belege wieder. Der Code wird genau einmal angezeigt und lässt " +
        "sich später nicht erneut abrufen; notieren Sie ihn, wenn Sie ihn behalten " +
        "möchten.",
    },
    {
      // Beleg: lib/auth/mail.ts (15 Minuten, einmal verwendbar).
      f: "Der Anmelde-Link ist nicht angekommen oder gilt nicht mehr.",
      a:
        "Sehen Sie zuerst im Spam-Ordner nach. Der Link gilt 15 Minuten und lässt " +
        "sich nur einmal verwenden — danach fordern Sie auf der Anmelde-Seite " +
        "einfach einen neuen an.",
    },
    {
      // Beleg: db/schema.ts polls.verbindlich („nur Stufe≥2 dürfen abstimmen").
      f: "Muss ich meinen Wohnsitz bestätigen lassen, um mitzumachen?",
      a:
        "Nein. Lesen geht ohne Konto, Mitstimmen mit E-Mail-Adresse. Die " +
        "Wohnsitz-Bestätigung brauchen Sie nur für Abstimmungen, die als " +
        "verbindlich gekennzeichnet sind.",
    },
    {
      // Beleg: lib/verification/proof-core.ts PROOF_TTL_MIN = 5, Single-Use;
      // MeinKontoQr.tsx (Klartext-Code als Rückfallweg, „neu erzeugen").
      f: "Mein Beleg für die Stelle vor Ort ist abgelaufen.",
      a:
        "Der Beleg ist absichtlich nur wenige Minuten gültig und lässt sich nur " +
        "einmal einlösen. Erzeugen Sie ihn in Ihrem Konto einfach neu. Falls die " +
        "Kamera den QR-Code nicht liest, steht darunter derselbe Code zum Vorlesen " +
        "oder Eintippen.",
    },
    {
      // Beleg: anliegen/page.tsx (öffentlicher Tracker, Stufe 0, Status per Code).
      f: "Wie erfahre ich, was aus einem eingereichten Anliegen geworden ist?",
      a:
        "Über den Tracking-Code, den Sie beim Einreichen erhalten haben. Damit " +
        "rufen Sie den Bearbeitungsstand ab, ohne sich anzumelden.",
    },
  ],

  weiter: [
    { label: "Häufige Fragen (Kurzfassung)", href: "/faq" },
    { label: "Datenschutzerklärung", href: "/datenschutz" },
    { label: "Anliegen mit Code verfolgen", href: "/anliegen" },
  ],
};

// ---------------------------------------------------------------------------
// c2–c5 — Spuren der Rollenträger. Öffentlich lesbar (Owner-Entscheidung):
// die Guards sitzen an den echten Flächen, nicht an der Dokumentation, und
// „jeder kann nachlesen, was eine Stelle darf und was sie nicht speichert" ist
// ein Transparenz-Argument, das zum Produkt passt.
// ---------------------------------------------------------------------------

const VERIFIZIERUNG_SPUR: AnleitungSpur = {
  id: "verifizierung",
  titel: "Wohnsitz bestätigen (Verifizierung)",
  kurz: "Sie bestätigen vor Ort, dass eine Person hier wohnt.",
  ersterSatz:
    "Sie bestätigen, dass eine Person hier wohnt — mehr prüfen Sie nicht, und " +
    "mehr wird auch nicht gespeichert.",

  schritte: [
    {
      // Beleg: lib/admin/invitation-core.ts (Einladung, Standard 14 Tage);
      // Anmeldung über denselben Magic-Link wie für alle (lib/auth/mail.ts).
      titel: "Einladung annehmen und anmelden",
      text:
        "Sie werden per E-Mail eingeladen und melden sich mit demselben " +
        "Anmelde-Link an wie alle anderen. Eine Einladung gilt standardmäßig " +
        "14 Tage; danach lässt sie sich neu versenden.",
      link: { label: "Anmelden", href: "/anmelden" },
    },
    {
      // Beleg: [tenant]/aufgaben/page.tsx + lib/aufgaben/kacheln.ts — angezeigt
      // wird ausschließlich, wofür der Server die Person auch berechtigt.
      titel: "Aufgaben öffnen",
      text:
        "Nach der Anmeldung führt die Ansicht „Aufgaben“ zu Ihren Funktionen. " +
        "Dort steht nur, wofür Sie tatsächlich berechtigt sind.",
      link: { label: "Zu den Aufgaben", href: "/aufgaben" },
    },
    {
      // Beleg: lib/verification/proof-core.ts (umgekehrter Konto-Beleg V3),
      // lib/aufgaben/kacheln.ts Kachel „verifizieren",
      // lib/verification/qr-core.ts QR_VERIFICATION_MONTHS = 24.
      titel: "Vor Ort bestätigen",
      text:
        "Die Person weist sich mit ihrem Ausweis aus und zeigt den Beleg aus " +
        "ihrem eigenen Konto — als QR-Code oder als Code zum Eintippen. Sie " +
        "erfassen ihn und bestätigen. Damit gilt der Wohnsitz für 24 Monate als " +
        "bestätigt.",
      link: { label: "Bestätigung öffnen", href: "/verifizieren/bestaetigen" },
    },
    {
      // Beleg: lib/aufgaben/kacheln.ts Kachel „termine" → /admin/verifizierung.
      titel: "Termine und Aktivität Ihrer Stelle",
      text:
        "Gebuchte Termine bestätigen und nachsehen, was an Ihrer Stelle " +
        "geschehen ist.",
      link: { label: "Verifizierung öffnen", href: "/admin/verifizierung" },
    },
  ],

  wissen: [
    {
      // Beleg: lib/verification/proof-core.ts — gespeichert wird ausschließlich
      // die Bestätigung; es gibt keinen Melderegister-Abgleich (faq-daten.ts).
      titel: "Was Sie ausdrücklich nicht tun",
      text:
        "Ausweisdaten werden nicht abgetippt, nicht kopiert, nicht fotografiert " +
        "und mit keinem Register abgeglichen. Der Ausweis dient allein dem " +
        "Abgleich vor Ort. Gespeichert wird ausschließlich die Bestätigung.",
    },
    {
      // Beleg: lib/verification/proof-core.ts — „Der Verifizierer sieht die
      // Bürger-Identität NIE (die user_id ist nur interner Anker)".
      titel: "Sie sehen die Kontodaten der Person nicht",
      text:
        "Der Beleg enthält keine Angaben zum Konto. Ihre Bestätigung wirkt auf " +
        "das richtige Konto, ohne dass Ihnen dessen Daten angezeigt werden.",
    },
    {
      // Beleg: lib/verification/proof-core.ts ProofGebietError + pfadDecktAb;
      // lib/auth/roles.ts erlaubteScopeEbenenFuerVerifier (UI ist nur Komfort).
      titel: "Gebietsbindung: nur Ihr Zuständigkeitsgebiet",
      text:
        "Sie können ausschließlich für Ihr eigenes Gebiet bestätigen. Das " +
        "erzwingt der Server; die Auswahl in der Oberfläche zeigt Ihnen ohnehin " +
        "nur Erlaubtes.",
    },
    {
      // Beleg: lib/verification/proof-core.ts — „Kein Selbst-Hochstufen",
      // doppelt geprüft (Vorab + auf dem RETURNING-userId).
      titel: "Den eigenen Beleg können Sie nicht bestätigen",
      text:
        "Wer selbst eine Bestätigung braucht, geht wie alle anderen zu einer " +
        "Stelle. Der Server weist die Selbstbestätigung ab.",
    },
    {
      // Beleg: lib/verification/proof-core.ts PROOF_TTL_MIN = 5, Single-Use.
      titel: "Wenn der Beleg nicht mehr gilt",
      text:
        "Ein Beleg ist bewusst nur wenige Minuten gültig und einmal einlösbar. " +
        "Bitten Sie die Person, ihn in ihrem Konto neu zu erzeugen — improvisieren " +
        "Sie nichts und notieren Sie keine Ausweisdaten.",
    },
  ],

  fragen: [
    {
      // Beleg: lib/auth/roles.ts pfadDecktAb / VERIFIER_ROLES.
      f: "Darf ich jemanden aus dem Nachbarort bestätigen?",
      a:
        "Nein. Ihre Rolle hängt an einem Gebietsknoten und deckt nur diesen und " +
        "alles darunter ab. Eine Bestätigung außerhalb weist der Server ab.",
    },
    {
      // Beleg: lib/verification/qr-core.ts QR_VERIFICATION_MONTHS,
      // lib/verification/reverify-reminders.ts (Erinnerung im 60-Tage-Fenster).
      f: "Was passiert nach den 24 Monaten?",
      a:
        "Die Person wird rund zwei Monate vorher per E-Mail erinnert und kommt " +
        "einmal wieder vorbei. Bis dahin kann sie unverändert mitstimmen, nur " +
        "verbindliche Abstimmungen sind dann gesperrt.",
    },
    {
      // Beleg: [tenant]/anleitung/mitmachen — Gegenseite desselben Vorgangs.
      f: "Jemand fragt, wie das aus seiner Sicht abläuft.",
      a:
        "Die Bürger-Anleitung beschreibt genau die Gegenseite: Konto anlegen, " +
        "Stelle wählen, Beleg zeigen. Sie ist öffentlich und lässt sich ausdrucken.",
    },
  ],

  weiter: [
    { label: "Anleitung fürs Mitmachen (die Gegenseite)", href: "/anleitung/mitmachen" },
    { label: "Verifizierungs-Stellen dieser Kommune", href: "/verifizieren" },
  ],
};

const REDAKTION_SPUR: AnleitungSpur = {
  id: "redaktion",
  titel: "Ratsinfos schreiben (Redaktion)",
  kurz: "Sie bereiten Sitzungszusammenfassungen auf und prüfen die Quellen.",
  ersterSatz:
    "Sie machen Ratsarbeit verständlich — jede Aussage mit Quelle, und " +
    "veröffentlicht wird nie ohne ein zweites Paar Augen.",

  schritte: [
    {
      titel: "Einladung annehmen und anmelden",
      text:
        "Auch für Rollen gibt es kein Passwort: Sie melden sich mit dem " +
        "Anmelde-Link aus Ihrer E-Mail an.",
      link: { label: "Anmelden", href: "/anmelden" },
    },
    {
      titel: "Aufgaben öffnen",
      text: "Die Ansicht „Aufgaben“ führt zu Ihren Funktionen.",
      link: { label: "Zu den Aufgaben", href: "/aufgaben" },
    },
    {
      // Beleg: lib/digest/freigabe-core.ts (Aussagen mit geprueft_by /
      // highlighted_by), lib/digest/extractive_v1.ts („Jede Aussage MUSS eine
      // sourceDocumentId haben — keine Aussage ohne Quelle").
      titel: "Entwurf bearbeiten und Quellen prüfen",
      text:
        "Ein Digest besteht aus einzelnen Aussagen, jede mit ihrer Fundstelle. " +
        "Sie bearbeiten den Entwurf, gewichten Aussagen und haken sie ab, wenn Sie " +
        "die Quelle geprüft haben.",
      link: { label: "Ratsinfos öffnen", href: "/admin/digests" },
    },
    {
      // Beleg: lib/auth/roles.ts FREIGABE_ROLES (nur Admin-Rollen).
      titel: "An die Freigabe übergeben",
      text:
        "Ist jede Aussage geprüft, übernimmt eine Person mit Verwaltungsrolle die " +
        "Freigabe. Damit endet Ihr Teil des Vorgangs.",
    },
  ],

  wissen: [
    {
      // Beleg: lib/auth/roles.ts canFreigeben (redakteur ausgeschlossen);
      // lib/digest/freigabe-core.ts (SoD-Sperre atomar im UPDATE, fail-closed).
      titel: "Vier-Augen-Prinzip, serverseitig hart",
      text:
        "Sie dürfen prüfen, gewichten und bearbeiten — freigeben und " +
        "veröffentlichen können ausschließlich Verwaltungsrollen. Und auch dort " +
        "gilt: Wer an einem Digest mitgewirkt hat, kann ihn nicht selbst " +
        "freigeben. Die Sperre steckt in derselben Datenbank-Operation wie der " +
        "Statuswechsel, sie lässt sich nicht umgehen.",
    },
    {
      // Beleg: db/schema.ts digestStatusEnum (entwurf/freigegeben/veroeffentlicht),
      // digests.approvedContentHash (bei Veröffentlichung verglichen).
      titel: "Drei Zustände, und die Freigabe versiegelt",
      text:
        "Entwurf → freigegeben → veröffentlicht. Mit der Freigabe wird der Inhalt " +
        "über eine Prüfsumme festgeschrieben. Ändert sich danach etwas, muss neu " +
        "freigegeben werden — stillschweigende Korrekturen sind ausgeschlossen.",
    },
    {
      // Beleg: lib/digest/extractive_v1.ts (Neutralitätskodex: nur Tatsachen aus
      // den Dokumenten, keine Bewertungen, keine Parteinennung),
      // lib/digest/llm_v2.ts (keine Wertungen, keine Spekulation, nur Inhalte
      // aus den übergebenen Dokumenten).
      titel: "Neutralitätskodex in drei Zeilen",
      text:
        "Nur Tatsachen, die in den Sitzungsunterlagen belegt sind. Keine " +
        "Bewertung, keine Spekulation, keine Parteinennung. Trennen Sie Tatsache " +
        "und Einordnung sichtbar — im Zweifel lieber keine Aussage als eine " +
        "möglicherweise falsche.",
    },
    {
      // Beleg: lib/digest/extractive_v1.ts (RIEGEL bei TOP-Dokumenten: lieber
      // keine Aussage als eine möglicherweise falsche Abstimmungszuordnung).
      titel: "Automatisch erzeugte Entwürfe sind Entwürfe",
      text:
        "Entwürfe entstehen aus den Sitzungsunterlagen, teils maschinell. Sie " +
        "sind Rohmaterial: Prüfen Sie jede Aussage gegen ihre Fundstelle, " +
        "insbesondere Zahlen und Abstimmungsergebnisse.",
    },
  ],

  fragen: [
    {
      // Beleg: lib/auth/roles.ts REDAKTION_ROLES vs. FREIGABE_ROLES.
      f: "Warum kann ich nichts veröffentlichen?",
      a:
        "Das ist beabsichtigt und in den Rechten der Rolle festgelegt. Redaktion " +
        "und Freigabe sind getrennt, damit kein Text ohne zweite Prüfung " +
        "öffentlich wird.",
    },
    {
      // Beleg: db/schema.ts digests.approvedContentHash — bei Veröffentlichung
      // gegen den Freigabe-Stand verglichen.
      f: "Ich habe nach der Freigabe einen Fehler entdeckt.",
      a:
        "Melden Sie ihn der freigebenden Person. Der Inhalt lässt sich ändern, " +
        "aber die Änderung braucht zwingend eine neue Freigabe — der " +
        "Veröffentlichungs-Schritt vergleicht den Text mit dem freigegebenen Stand.",
    },
    {
      // Beleg: [tenant]/transparenz/page.tsx (veröffentlichte Digests mit
      // Freigabe- und Veröffentlichungszeitpunkt).
      f: "Wo sehen Außenstehende, was freigegeben wurde?",
      a:
        "Auf der Transparenz-Seite dieser Kommune. Dort stehen die " +
        "veröffentlichten Zusammenfassungen mit ihrem Freigabe-Zeitpunkt.",
    },
  ],

  weiter: [
    { label: "Transparenz: Freigaben und Korrekturen", href: "/transparenz" },
  ],
};

const ADMINISTRATION_SPUR: AnleitungSpur = {
  id: "administration",
  titel: "Verwalten und freigeben (Administration)",
  kurz: "Sie stellen Fragen, geben frei, vergeben Rollen und pflegen die Stellen.",
  ersterSatz:
    "Sie stellen die Fragen Ihrer Kommune — und tragen die Verantwortung für " +
    "alles, was veröffentlicht wird.",

  schritte: [
    {
      // Beleg: admin/page.tsx „Erste Schritte" — Standort ist der erste Baustein;
      // lib/aufgaben/kacheln.ts Kachel „standorte";
      // verifizieren/StellenListe.tsx zeigt genau diese Standorte.
      titel: "Zuerst: Standorte und Sprechzeiten pflegen",
      text:
        "Davon hängt ab, was Bürgerinnen und Bürger unter „Stellen in Ihrer Nähe“ " +
        "sehen. Ohne gepflegten Standort läuft die Wohnsitz-Bestätigung ins Leere.",
      link: { label: "Standorte pflegen", href: "/admin/verifizierung/standorte" },
    },
    {
      // Beleg: lib/aufgaben/kacheln.ts Kachel „umfrage"; db/schema.ts
      // pollStatusEnum (entwurf → aktiv → geschlossen) und polls.verbindlich.
      titel: "Abstimmung erstellen",
      text:
        "Format und Gebiet wählen — das Gebiet entscheidet, wen die Frage " +
        "erreicht. Eine Abstimmung beginnt als Entwurf und geht erst durch einen " +
        "eigenen Schritt live. Nach Ablauf der Frist schließen Sie sie; erst dann " +
        "steht das Ergebnis mit der Aufschlüsselung nach Antworten fest.",
      link: { label: "Abstimmungen verwalten", href: "/admin/abstimmungen" },
    },
    {
      // Beleg: lib/auth/roles.ts FREIGABE_ROLES; lib/digest/freigabe-core.ts.
      titel: "Digests freigeben",
      text:
        "Sie sind das zweite Augenpaar. Prüfen Sie die Quellenlinks, nicht nur " +
        "den Text — mit der Freigabe wird der Inhalt festgeschrieben.",
      link: { label: "Ratsinfos öffnen", href: "/admin/digests" },
    },
    {
      // Beleg: lib/admin/invitation-core.ts (Einladung statt Konto-Anlage).
      titel: "Rollen vergeben",
      text:
        "Sie legen keine Konten an, sondern laden per E-Mail ein. Die Person " +
        "meldet sich selbst an und erhält damit die Rolle.",
      link: { label: "Rollen verwalten", href: "/admin/rollen" },
    },
    {
      // Beleg: admin/page.tsx Karte „Protokoll" („PII-frei, ohne E-Mail");
      // lib/admin/role-actions.ts (Audit-metadata enthält NIEMALS E-Mail).
      titel: "Protokoll einsehen",
      text:
        "Alles Folgenreiche wird protokolliert — ohne personenbezogene Daten. Das " +
        "Protokoll ist Ihr Beleg gegenüber Rat und Öffentlichkeit.",
      link: { label: "Protokoll öffnen", href: "/admin/protokoll" },
    },
  ],

  wissen: [
    {
      // Beleg: lib/auth/roles.ts KOMMUNE_ADMIN_MANAGEABLE_ROLES + canManageRole
      // (niemals super_admin, niemals die Reserve-Rollen).
      titel: "Eskalationsgrenze",
      text:
        "Sie können die Rollen für Bürgerkonten, Verifizierung, Redaktion, " +
        "Beobachtung und Verwaltung vergeben und entziehen — die Betreiberrolle " +
        "niemals. Diese Grenze prüft der Server bei jeder Änderung neu.",
    },
    {
      // Beleg: lib/polls/voter-ref.ts + lib/polls/ergebnis.ts — es gibt keine
      // Fläche, die Person und Wahl verbindet; Ergebnisse sind Aggregate.
      titel: "Was auch Sie nicht sehen",
      text:
        "Wie eine einzelne Person abgestimmt hat, zeigt Ihnen die Anwendung an " +
        "keiner Stelle — nicht in Ergebnissen, nicht in Auswertungen, nicht im " +
        "Protokoll. Das ist der Satz, den Sie Rat, Bürgern und Presse ruhig sagen " +
        "können.",
    },
    {
      // Beleg: lib/digest/freigabe-core.ts (SoD auch für Admins;
      // ALLOW_SELF_APPROVAL nur als auditierte Pilot-Überbrückung,
      // metadata.selfApproval = true).
      titel: "Das Vier-Augen-Prinzip gilt auch für Sie",
      text:
        "Haben Sie an einem Digest selbst Aussagen geprüft oder gewichtet, können " +
        "Sie ihn nicht freigeben. Für den Betrieb mit nur einer Person kann der " +
        "Betreiber diese Sperre ausdrücklich überbrücken; jede solche Freigabe " +
        "wird im Protokoll als Selbstfreigabe vermerkt — sie ist nie unsichtbar.",
    },
    {
      // Beleg: db/schema.ts polls.verbindlich („nur Stufe≥2 dürfen abstimmen").
      titel: "„Verbindlich“ ist eine Entscheidung mit Folgen",
      text:
        "Markieren Sie eine Abstimmung als verbindlich, dürfen nur Personen mit " +
        "bestätigtem Wohnsitz mitstimmen. Ohne diese Markierung ist das Ergebnis " +
        "ein Stimmungsbild — beides ist legitim, aber es sollte bewusst gewählt sein.",
    },
    {
      // Beleg: lib/polls/pruefung-core.ts + lib/ki/neutralitaet-prompt.ts +
      // transparenz/page.tsx (öffentliches Log). Pro Kommune aktivierbar.
      titel: "Wenn der Neutralitäts-Check aktiv ist",
      text:
        "Ist er für Ihre Kommune eingeschaltet, geht eine aktivierte Abstimmung " +
        "zunächst in Prüfung statt sofort live. Die Prüfung kann anhalten, nie " +
        "endgültig ablehnen — im Zweifel wird zugelassen, und die letzte Instanz " +
        "ist ein Mensch. Prüf-Prompt und Ergebnis stehen öffentlich auf der " +
        "Transparenz-Seite.",
    },
    {
      // Beleg: lib/auth/roles.ts getUserRoleTypes — innerer JOIN auf
      // users.account_status='active'; gesperrte Konten erhalten [].
      titel: "Ein gesperrtes Konto verliert sofort alle Rechte",
      text:
        "Auch bei noch laufender Sitzung: Die Rechteprüfung lädt ausschließlich " +
        "Rollen aktiver Konten. Eine Sperre wirkt damit ohne Wartezeit.",
    },
    {
      // TODO(#59): Zwei-Faktor-Pflicht für Admin-Rollen liegt auf dem noch nicht
      // gemergten Branch `feat/59-admin-2fa` (lib/auth/zwei-faktor.ts,
      // [tenant]/konto/zwei-faktor/). Dieser Abschnitt beschreibt daher NUR den
      // heutigen, belegten Stand (kein 2FA im Code) plus die öffentlich
      // dokumentierte Roadmap-Absicht (ROADMAP.md Z. 86; ADR-017 Punkt 4;
      // Deck-Folie 10 „GEPLANT"). BEIM MERGE VON #59 GEGEN DEN DANN REALEN
      // STAND PRÜFEN und ergänzen: Einrichtung unter /konto/zwei-faktor,
      // Wiederherstellungscodes, Step-up-Fristen, Kulanzfrist. Nichts davon
      // hier vorwegnehmen, solange es nicht im Code steht.
      titel: "Anmeldung heute — und was dazukommen soll",
      text:
        "Heute melden Sie sich wie alle anderen mit dem Anmelde-Link aus Ihrer " +
        "E-Mail an; ein Passwort gibt es nicht. Eine Zwei-Faktor-Anmeldung für " +
        "Verwaltungsrollen steht auf der Roadmap. Sie ist ausdrücklich nur für " +
        "Verwaltungsrollen vorgesehen — Verifizierung, Redaktion, Beobachtung und " +
        "Bürgerkonten bleiben davon unberührt.",
    },
  ],

  fragen: [
    {
      // Beleg: lib/auth/roles.ts canManageRole — super_admin nie vergebbar.
      f: "Ich finde die Betreiberrolle nicht in der Auswahl.",
      a:
        "Richtig so. Die Betreiberrolle lässt sich von einer Verwaltungsrolle aus " +
        "weder vergeben noch entziehen. Sie ist die Rolle des Plattform-Betreibers, " +
        "nicht der Kommune.",
    },
    {
      // Beleg: lib/digest/freigabe-core.ts SOD_FEHLER.
      f: "Die Freigabe wird mit Hinweis auf das Vier-Augen-Prinzip abgelehnt.",
      a:
        "Dann haben Sie an diesem Digest selbst mitgewirkt — mindestens eine " +
        "Aussage geprüft oder gewichtet. Die Freigabe muss eine zweite Person " +
        "übernehmen.",
    },
    {
      // Beleg: lib/polls/ergebnis.ts (ADR-022: Aufschlüsselung erst nach Ende).
      f: "Warum sehe ich während einer laufenden Abstimmung keine Aufschlüsselung?",
      a:
        "Weil sich aus wiederholten Zwischenständen kleine Gruppen zurückrechnen " +
        "ließen. Während der Laufzeit gibt es nur Gesamtzahlen; die Aufschlüsselung " +
        "nach Antworten erscheint als ein Stand nach dem Ende.",
    },
    {
      // Beleg: lib/polls/notify.ts — E-Mail an Opt-in-Konten im Gebiet der Umfrage.
      f: "Erfahren die Leute, dass es etwas Neues gibt?",
      a:
        "Wer Benachrichtigungen eingeschaltet hat und im Gebiet der Abstimmung " +
        "wohnt, bekommt beim Live-Schalten eine E-Mail. Das ist ein Opt-in, keine " +
        "automatische Verteilung.",
    },
  ],

  weiter: [
    { label: "Transparenz-Seite dieser Kommune", href: "/transparenz" },
    { label: "Anleitung fürs Mitmachen (was Bürger sehen)", href: "/anleitung/mitmachen" },
  ],
};

const BEOBACHTUNG_SPUR: AnleitungSpur = {
  id: "beobachtung",
  titel: "Nur mitlesen (Beobachtung)",
  kurz: "Sie sehen Ihr Gebiet — ändern können Sie nichts.",
  ersterSatz:
    "Sie sehen, was in Ihrem Gebiet läuft — ändern können Sie nichts, und genau " +
    "das ist der Sinn dieser Rolle.",

  schritte: [
    {
      titel: "Einladung annehmen und anmelden",
      text: "Auch hier ohne Passwort: Anmelde-Link aus der E-Mail.",
      link: { label: "Anmelden", href: "/anmelden" },
    },
    {
      titel: "Aufgaben öffnen",
      text: "Die Ansicht „Aufgaben“ führt zu Ihren beiden Lese-Einstiegen.",
      link: { label: "Zu den Aufgaben", href: "/aufgaben" },
    },
    {
      // Beleg: lib/aufgaben/kacheln.ts Kachel „abstimmungen-lese".
      titel: "Abstimmungen einsehen",
      text:
        "Laufende und beendete Abstimmungen in Ihrem Gebiet, mit Ergebnissen — " +
        "in einer reinen Lese-Ansicht.",
      link: { label: "Abstimmungen einsehen", href: "/admin/abstimmungen" },
    },
    {
      // Beleg: lib/aufgaben/kacheln.ts Kachel „uebersicht"; admin/page.tsx
      // (Beobachter ohne Kennzahlen, Digest-Karte nur bei stadtweitem Gebiet).
      titel: "Übersicht öffnen",
      text:
        "Die zusammenfassende Lese-Sicht. Kennzahlen und Verwaltungsfunktionen " +
        "sehen Sie dort bewusst nicht.",
      link: { label: "Übersicht öffnen", href: "/admin" },
    },
  ],

  wissen: [
    {
      // Beleg: lib/auth/roles.ts — `beobachter` taucht in KEINER Mutations-Achse
      // auf (REDAKTION/FREIGABE/ADMIN/VERIFIER).
      titel: "Keinerlei Schreibrechte, mit Absicht",
      text:
        "Keine Freigaben, keine Rollenvergabe, keine Verifizierung, keine " +
        "Bearbeitung. Die Rolle ist für Multiplikatoren gedacht, die Ergebnisse " +
        "weitertragen — nicht für Mitarbeit.",
    },
    {
      // Beleg: lib/auth/roles.ts beobachterDarfSehen / pfadDecktAb
      // (Vorfahr-oder-Selbst im Gebietsbaum).
      titel: "Ihr Gebiet und alles darunter",
      text:
        "Eine Beobachterrolle auf Kreisebene sieht die Gemeinden darunter. Eine " +
        "Rolle für einen Ortsteil sieht nur diesen Ortsteil — keine Nachbarorte " +
        "und nichts Stadtweites.",
    },
    {
      // Beleg: lib/auth/roles.ts beobachterDarfTenantweitSehen (fail-closed für
      // reine Ortsteil-Knoten); admin/page.tsx zeigeDigestKarte.
      titel: "Stadtweite Entwürfe nur mit stadtweitem Gebiet",
      text:
        "Digest-Entwürfe gelten für die ganze Kommune. Wer nur für einen Ortsteil " +
        "eingetragen ist, sieht sie deshalb nicht — das ist keine Störung.",
    },
    {
      // Beleg: lib/polls/ergebnis.ts — die Suppression wirkt serverseitig für alle.
      titel: "Die Maskierung gilt auch für Sie",
      text:
        "Was zum Schutz kleiner Gruppen unkenntlich gemacht ist, ist für alle " +
        "unkenntlich — es gibt keine Lese-Rolle, die daran vorbeisieht.",
    },
  ],

  fragen: [
    {
      // Beleg: lib/aufgaben/kacheln.ts (Kachel-Sichtbarkeit spiegelt die Guards).
      f: "Mir fehlt eine Funktion, die Kollegen haben.",
      a:
        "Angezeigt wird genau das, wofür der Server Sie berechtigt. Fehlt etwas " +
        "dauerhaft, ist die Rolle gemeint — wenden Sie sich an die Verwaltung " +
        "Ihrer Kommune.",
    },
    {
      // Beleg: lib/auth/roles.ts pfadDecktAb.
      f: "Kann mein Gebiet erweitert werden?",
      a:
        "Ja, über eine zusätzliche oder andere Rollenzuweisung durch die " +
        "Verwaltung. Die Sichtbarkeit folgt immer dem Gebietsknoten Ihrer Rolle.",
    },
  ],

  weiter: [
    { label: "Transparenz-Seite dieser Kommune", href: "/transparenz" },
  ],
};

/**
 * Reihenfolge der Abschnitte auf `/anleitung/aufgaben` — von der häufigsten
 * Aufgabe (Verifizierung, der v1-Fokus) zur reinen Lese-Rolle. Die Ids sind
 * Anker und werden von der Abholseite verlinkt: nicht ohne Grund ändern.
 */
export const AUFGABEN_SPUREN: AnleitungSpur[] = [
  VERIFIZIERUNG_SPUR,
  REDAKTION_SPUR,
  ADMINISTRATION_SPUR,
  BEOBACHTUNG_SPUR,
];

/**
 * Rollentyp → passender Abschnitt, für den persönlichen Hinweis auf der
 * Abholseite („Sie sind als … eingetragen").
 *
 * Deckt exakt die Rollen ab, die im Betrieb sind (roleTypeEnum in schema.ts).
 * BEWUSST NICHT enthalten:
 *   - `user`        — das ist die Bürger-Spur, kein Rollenträger-Abschnitt.
 *   - `super_admin` — Betreiberrolle, keine öffentliche Anleitung (Konzept c6).
 *   - `ortsteil_admin` / `kreis_admin` / `land_admin` — Reserve, nicht in Betrieb.
 * Unbekannte Rollentypen laufen ins Leere (fail-quiet): der Hinweis entfällt,
 * die drei Karten bleiben.
 */
export const ROLLE_ZU_ABSCHNITT: Record<string, { spurId: string; bezeichnung: string }> = {
  verifier: { spurId: "verifizierung", bezeichnung: "Verifizierung" },
  redakteur: { spurId: "redaktion", bezeichnung: "Redaktion" },
  kommune_admin: { spurId: "administration", bezeichnung: "Verwaltung" },
  beobachter: { spurId: "beobachtung", bezeichnung: "Beobachtung" },
};

/**
 * Welche Abschnitte sind für diese Rollen einschlägig? REINE Funktion (ohne DB),
 * stabile Reihenfolge = Reihenfolge von AUFGABEN_SPUREN. Doppelte Rollen und
 * unbekannte Rollentypen fallen heraus.
 */
export function abschnitteFuerRollen(
  roleTypes: string[],
): { spurId: string; bezeichnung: string; titel: string }[] {
  const treffer = new Map<string, { spurId: string; bezeichnung: string; titel: string }>();
  for (const rt of roleTypes) {
    const eintrag = ROLLE_ZU_ABSCHNITT[rt];
    if (!eintrag) continue;
    const spur = AUFGABEN_SPUREN.find((s) => s.id === eintrag.spurId);
    if (!spur) continue;
    treffer.set(eintrag.spurId, { ...eintrag, titel: spur.titel });
  }
  return AUFGABEN_SPUREN.flatMap((s) => {
    const t = treffer.get(s.id);
    return t ? [t] : [];
  });
}
