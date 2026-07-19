/**
 * [tenant]/datenschutz/page.tsx — Datenschutzerklärung (DSGVO) für die Plattform
 *
 * Fasst die Verarbeitungen der Phase 1 (Magic-Link-Konto, Digests,
 * Anliegen-Tracker). Volltext-Entwurf + Anwalts-Anmerkungen in
 * docs/legal/DATENSCHUTZ_PLATTFORM_ENTWURF.md — Änderungen dort nachziehen.
 * Der Anthropic-Absatz erscheint nur, wenn der LLM-Generator aktiv sein kann
 * (ANTHROPIC_API_KEY gesetzt) — vgl. ADR-011.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { ANBIETER, ANGABEN_VOLLSTAENDIG } from "@/lib/legal/anbieter";
import { getTenantFromHost } from "@/lib/tenant";

export const metadata: Metadata = {
  title: "Datenschutzerklärung — Partizip",
  robots: { index: false },
};

function Abschnitt({
  titel,
  children,
}: {
  titel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 space-y-2">
      <h2 className="font-medium" style={{ color: "var(--pz-ink)" }}>{titel}</h2>
      {children}
    </section>
  );
}

export default async function DatenschutzPage() {
  const llmAktivierbar = Boolean(process.env.ANTHROPIC_API_KEY);
  // Block L (ADR-028): Neutralitäts-Check-Absatz nur zeigen, wenn der Check für
  // diese Kommune aktiv ist (analog llmAktivierbar-Muster; Flag je Tenant).
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  const kiCheckAktiv = tenant?.kiNeutralitaetsPflicht === true;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Datenschutzerklärung</h1>

      {!ANGABEN_VOLLSTAENDIG && (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <strong>Entwurfs-/Vorstellungsfassung (Pitch-Stand).</strong> Dieser Text
          ist nach bestem Wissen vorformuliert und dient der Projektvorstellung. Er
          ist noch <strong>nicht rechtsverbindlich</strong>: Die finale,
          anwaltlich geprüfte Fassung wird zur Pilot-Einführung umgesetzt und
          veröffentlicht.
        </p>
      )}

      <Abschnitt titel="1. Verantwortlicher">
        <p>
          {ANBIETER.name}, {ANBIETER.strasse}, {ANBIETER.ort} · E-Mail:{" "}
          {ANBIETER.email}
        </p>
      </Abschnitt>

      <Abschnitt titel="2. Grundprinzipien">
        <p>
          Partizip ist eine überparteiliche Plattform für kommunale
          Beteiligung. Wir verarbeiten so wenige personenbezogene Daten wie
          möglich: keine Werbung, kein Tracking, keine Weitergabe an Dritte zu
          kommerziellen Zwecken, keine Profilbildung. Wo möglich, speichern
          wir Pseudonyme statt Klardaten.
        </p>
      </Abschnitt>

      <Abschnitt titel="3. Hosting und Server-Logdaten">
        <p>
          Die Plattform läuft auf Servern der Hetzner Online GmbH,
          Industriestr. 25, 91710 Gunzenhausen, Deutschland
          (Auftragsverarbeitung nach Art. 28 DSGVO). Beim Aufruf verarbeitet
          der Webserver technisch bedingt IP-Adresse, Zeitpunkt, aufgerufene
          URL, HTTP-Status, Datenmenge, Referrer und User-Agent — zur
          Auslieferung der Seite sowie für Stabilität und Sicherheit.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO. Logdaten werden nach
          spätestens 14 Tagen gelöscht oder anonymisiert.
        </p>
      </Abschnitt>

      <Abschnitt titel="4. Konto und Anmeldung (Magic-Link)">
        <p>
          Für ein Nutzerkonto verarbeiten wir Ihre E-Mail-Adresse. Die
          Anmeldung erfolgt ohne Passwort über einen einmalig verwendbaren
          Link (15 Minuten gültig). Nach der Anmeldung speichert Ihr Browser
          ein technisch erforderliches Session-Cookie (httpOnly, maximal 30
          Tage; kein Tracking-Cookie). Rechtsgrundlage: Art. 6 Abs. 1 lit. b
          DSGVO; für das Cookie § 25 Abs. 2 Nr. 2 TDDDG. Anmelde-Token werden
          spätestens 24 Stunden nach Einlösung/Ablauf gelöscht, abgelaufene
          Sitzungen spätestens 30 Tage nach Ablauf. Ihr Konto bleibt bestehen,
          bis Sie es löschen — die Löschung können Sie jederzeit selbst im
          Bereich „Mein Konto“ auslösen (siehe Ziff. 13).
        </p>
      </Abschnitt>

      <Abschnitt titel="5. Schutz vor Missbrauch (Rate-Limiting)">
        <p>
          Zur Abwehr automatisierter Angriffe zählen wir Anfragen pro
          Absender. Dabei speichern wir keine Klartext-IP-Adressen, sondern
          ausschließlich kryptographische Prüfsummen (HMAC mit geheimem
          Schlüssel). Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO.
          Speicherdauer: 24 Stunden.
        </p>
      </Abschnitt>

      <Abschnitt titel="6. Wohnort-Angaben (Verifikationsstufen)">
        <p>
          Beteiligungsfunktionen sind nach Stufen abgesichert. Wir speichern
          dazu Ihre Ortsteil-Zuordnung, Geburtsmonat und -jahr (kein volles
          Geburtsdatum) und den Zeitpunkt Ihrer Selbsterklärung.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
        </p>
      </Abschnitt>

      <Abschnitt titel="7. Klarname und Funktion von Rollenträgern">
        <p>
          Wer auf der Plattform eine Rolle ausübt (z. B. Verifizierung,
          Redaktion, Verwaltung), kann im Konto freiwillig einen Klarnamen und
          eine Funktions- bzw. Amtsbezeichnung hinterlegen. Diese Angaben werden
          öffentlich sichtbar gemacht, aber ausschließlich im Zusammenhang mit
          der Rollenausübung — etwa als Hinweis „Gestellt von …“ an einer
          Abstimmung oder in der internen Team-Übersicht. Zweckbindung ist die
          transparente Zuordnung von Verantwortung; Rechtsgrundlage: Art. 6
          Abs. 1 lit. e/f DSGVO (Transparenz kommunaler Beteiligung) bzw. bei
          freiwilliger Angabe Art. 6 Abs. 1 lit. a DSGVO. Die Angabe ist
          freiwillig, für die namentliche Rollenanzeige aber erforderlich; ohne
          Klarnamen erscheint nur der Name der Institution. Sie können den
          Klarnamen jederzeit im Konto ändern oder entfernen. Die reine Teilnahme
          als Bürgerin oder Bürger (Abstimmen, Anliegen) bleibt hiervon
          unberührt und pseudonym — Bürgerkonten führen keinen Klarnamen.
        </p>
      </Abschnitt>

      <Abschnitt titel="8. Anliegen-Tracker">
        <p>
          Eingereichte Anliegen speichern wir mit Text, Kategorie/Ortsteil und
          Bearbeitungsstatus. Ihr Anliegen wird pseudonymisiert geführt
          (nicht umkehrbares HMAC-Pseudonym statt Kontoverknüpfung);
          öffentlich sichtbar sind nur Text und Status, niemals Ihre
          Identität. Den Status können Sie über einen zufällig erzeugten
          Tracking-Code abrufen. Optionale E-Mail-Benachrichtigungen bei
          Statusänderungen können Sie jederzeit abbestellen. Rechtsgrundlage:
          Art. 6 Abs. 1 lit. b DSGVO. Bitte nennen Sie im Anliegen-Text keine
          personenbezogenen Daten Dritter.
        </p>
      </Abschnitt>

      <Abschnitt titel="9. E-Mail-Versand">
        <p>
          Anmelde-Links und Benachrichtigungen versenden wir über einen
          eigenen SMTP-Server in Deutschland. E-Mail-Adressen werden nicht zu
          Werbezwecken genutzt.
        </p>
      </Abschnitt>

      <Abschnitt titel="10. Ratsinformationen und Digests">
        <p>
          Die Plattform bereitet öffentliche Dokumente der kommunalen
          Ratsinformationssysteme zu verständlichen Zusammenfassungen auf.
          Diese Dokumente können Namen von Mandatsträgern enthalten; wir
          verarbeiten sie, wie von der Kommune veröffentlicht, und verlinken
          stets die Originalquelle. Jede Zusammenfassung wird vor
          Veröffentlichung durch einen Menschen geprüft und freigegeben.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (Information der
          Öffentlichkeit über öffentliche Ratsarbeit).
        </p>
        {llmAktivierbar && (
          <p>
            Zur Erstellung von Zusammenfassungs-Entwürfen können wir die Texte
            der öffentlichen Ratsdokumente an die Anthropic PBC (USA)
            übermitteln (Claude-API). Dabei werden keine Daten von Nutzerinnen
            und Nutzern übermittelt, sondern ausschließlich öffentliche
            Dokumenttexte. Mit Anthropic besteht eine
            Auftragsverarbeitungsvereinbarung mit EU-Standardvertragsklauseln;
            API-Daten werden nicht zum Training verwendet.
          </p>
        )}
      </Abschnitt>

      <Abschnitt titel="11. Kanäle auf Drittplattformen">
        <p>
          Diese Website ist unser eigentlicher Kanal: Alle Zusammenfassungen
          sind hier und per RSS vollständig verfügbar — ohne Konto, ohne
          Drittplattform, ohne Tracking.
        </p>
        <p className="mt-2">
          Zusätzlich verweisen wir auf unsere Beiträge in offenen sozialen
          Netzwerken: im Fediverse (Mastodon, ActivityPub-Standard) und auf
          Bluesky (AT-Protocol). Dort veröffentlichen wir jeweils nur einen
          kurzen Anreißer und einen Link zurück auf diese Seite. Wenn Sie diesen
          Netzwerken folgen, gelten deren Datenschutzbestimmungen; wir erhalten
          von dort keine personenbezogenen Daten über Abonnenten. Bewusst nicht
          genutzt werden geschlossene Messenger-Kanäle (z. B. WhatsApp,
          Telegram).
        </p>
      </Abschnitt>

      <Abschnitt titel="12. Cookies: nur funktional, kein Tracking">
        <p>
          Wir setzen ausschließlich fünf funktionale, technisch notwendige Cookies
          ein — <strong>keine</strong> Analyse-Dienste, externen Schriftarten/CDNs
          oder Social-Media-Plugins:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>Session-Cookie</strong> (Ziff. 4): httpOnly, max. 30 Tage —
            hält Sie angemeldet.
          </li>
          <li>
            <strong>Regions-Cookie <code>pz_region</code></strong>: httpOnly,
            Laufzeit ca. 1 Jahr — merkt sich Ihre per PLZ/Standort gewählte Region
            bzw. Ihren Ortsteil, damit wir Ihnen die für Sie passenden Abstimmungen
            anzeigen. Es enthält nur die Regions-/Ortsteil-Auswahl, dient nicht der
            Wiedererkennung über Websites hinweg und schaltet keine Rechte frei.
            Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG (von Ihnen ausdrücklich
            angefordert) bzw. Art. 6 Abs. 1 lit. b/f DSGVO.
          </li>
          <li>
            <strong>Hinweis-Cookie <code>pz_einrichtung_spaeter</code></strong>:
            wird nur gesetzt, wenn Sie den Einrichtungs-Hinweis über „Später“
            ausblenden; Laufzeit 30 Tage, fester Inhalt „1“ ohne jeden
            Personenbezug — merkt sich ausschließlich diese Anzeige-Entscheidung.
            Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG (von Ihnen ausdrücklich
            angefordert).
          </li>
          <li>
            <strong>Demo-Perspektiven-Cookie <code>pz_demo_perspektive</code></strong>:
            wird ausschließlich im Demo-Mandanten (fiktive „Musterstadt“) gesetzt,
            wenn Sie dort in die Verwaltungs-Perspektive wechseln; Laufzeit 12
            Stunden, fester Inhalt „verwaltung“ ohne jeden Personenbezug — merkt
            sich nur diese Anzeige-Entscheidung. Der zugehörige Schrittzähler des
            Demo-Rundgangs wird sitzungsgebunden im sessionStorage Ihres Browsers
            gehalten und endet mit dem Schließen des Tabs. Rechtsgrundlage:
            § 25 Abs. 2 Nr. 2 TDDDG (von Ihnen ausdrücklich angefordert).
          </li>
          <li>
            <strong>Ansichts-Cookie <code>pz_perspektive</code></strong>: wird nur
            gesetzt, wenn Sie als Rollenträger:in zwischen „Bürger-Ansicht“ und
            „Aufgaben“ wechseln; Laufzeit 30 Tage, fester Inhalt „aufgaben“ ohne
            jeden Personenbezug — merkt sich ausschließlich diese Anzeige-Auswahl
            und schaltet keinerlei Rechte frei (Ihre Funktionen ergeben sich allein
            aus Ihren Rollen). Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG (von Ihnen
            ausdrücklich angefordert).
          </li>
        </ul>
      </Abschnitt>

      <Abschnitt titel="13. Ihre Rechte">
        <p>
          Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung
          (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18),
          Datenübertragbarkeit (Art. 20) und Widerspruch gegen Verarbeitungen
          nach Art. 6 Abs. 1 lit. f DSGVO (Art. 21) — Kontakt siehe Ziff. 1.
          Beschwerden: Hessischer Beauftragter für Datenschutz und
          Informationsfreiheit (HBDI), Gustav-Stresemann-Ring 1, 65189
          Wiesbaden.
        </p>
        <p>
          Für ein bestehendes Konto bieten wir zwei dieser Rechte als
          Selbstbedienung im Bereich „Mein Konto“ an: Über „Meine Daten
          exportieren“ erhalten Sie die zu Ihrem Konto gespeicherten Daten als
          maschinenlesbare JSON-Datei (Auskunft, Art. 15). Über „Konto löschen“
          können Sie Ihr Konto selbst löschen (Art. 17): Ihre Kontodaten
          (E-Mail, Wohnort- und Altersangaben, Rollen) werden dabei
          anonymisiert bzw. gelöscht und alle Sitzungen beendet. Bereits
          eingereichte Anliegen bleiben als pseudonymer Vorgang erhalten (ohne
          Bezug zu Ihrer Person); ein technisches Protokoll bleibt PII-frei zu
          Nachweiszwecken bestehen. Für alle übrigen Anliegen wenden Sie sich
          bitte an die unter Ziff. 1 genannte Kontaktadresse.
        </p>
      </Abschnitt>

      <Abschnitt titel="14. Keine automatisierte Entscheidungsfindung">
        <p>
          Es findet keine automatisierte Entscheidungsfindung einschließlich
          Profiling im Sinne des Art. 22 DSGVO statt. Veröffentlichungen und
          Beteiligungsrechte werden ausschließlich von Menschen entschieden.
        </p>
        {kiCheckAktiv && (
          <p>
            Für diese Kommune ist ein KI-gestützter Neutralitäts-Check aktiv:
            Eingereichte Umfragen werden vor der Veröffentlichung auf sachliche
            Neutralität geprüft. Bewertet wird dabei ausschließlich der öffentliche
            Umfrage-Text — keine personenbezogenen Daten, keine Weitergabe an Dritte,
            kein zusätzlicher Cookie. Das Prüfergebnis (neutral oder angehalten) ist
            ein Hinweis; über Freigabe oder Anpassung entscheidet ausschließlich ein
            Mensch. Der vollständige Prüf-Maßstab ist öffentlich einsehbar (siehe
            &bdquo;Transparenz&ldquo;).
          </p>
        )}
      </Abschnitt>

      <Abschnitt titel="15. Interessenten-Kontaktformular (Mitmachen)">
        <p>
          Über das „Mitmachen“-Formular für Kommunen, Kreise, Vereine und
          Verwaltungen können Sie uns freiwillig kontaktieren. Wir verarbeiten
          dabei die von Ihnen angegebenen Daten — Name der Ansprechperson und
          E-Mail-Adresse (erforderlich) sowie optional Organisation, Funktion und
          eine Freitext-Nachricht — ausschließlich, um Ihre Anfrage zu bearbeiten
          und mit Ihnen Kontakt aufzunehmen. Dasselbe gilt, wenn Sie über unsere
          Terminbuchung einen Gesprächstermin vereinbaren; dabei werden die von
          Ihnen dort angegebenen Kontaktdaten und der Terminzeitpunkt an uns
          übermittelt. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Anbahnung
          eines Vertrags/einer Zusammenarbeit) bzw. lit. f DSGVO (Bearbeitung
          Ihrer Kontaktanfrage). Es wird hierfür kein Cookie gesetzt. Wir
          speichern diese Angaben nur so lange, wie es für die Bearbeitung
          erforderlich ist, und löschen sie auf Ihre Anfrage jederzeit; Kontakt
          siehe Ziff. 1.
        </p>
      </Abschnitt>

      <Abschnitt titel="16. Änderungen">
        <p>
          Wir passen diese Erklärung an, wenn sich Funktionsumfang oder
          Rechtslage ändern. Es gilt die hier veröffentlichte Fassung.
        </p>
      </Abschnitt>
    </main>
  );
}
