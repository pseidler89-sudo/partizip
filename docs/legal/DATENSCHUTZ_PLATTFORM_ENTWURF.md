# Datenschutzerklärung Plattform — Entwurf zur anwaltlichen Prüfung

**Stand:** 2026-06-11 · **Status: ENTWURF / PITCH-STAND — nach bestem Wissen
vorformuliert, nicht rechtsverbindlich. Nicht veröffentlichen, bevor Platzhalter
gefüllt und anwaltlich geprüft; verbindliche Umsetzung zur Pilot-Einführung.**
Geltungsbereich: Beteiligungsplattform Partizip auf `*.partizip.online`
(Pilot: `taunusstein.partizip.online`). Beschreibt den Funktionsumfang
**Phase 1** (Anmeldung per Magic-Link, Ratsinfo-Digests, Anliegen-Tracker).
Vor Aktivierung weiterer Funktionen (Abstimmungen, Vor-Ort-/Brief-
Verifikation) ist diese Erklärung zu erweitern — siehe Anmerkungen.

> Platzhalter `❮…❯` = von Patrick zu liefern/zu bestätigen.

---

## Datenschutzerklärung

### 1. Verantwortlicher

❮Patrick Seidler, Straße Hausnummer, PLZ Ort❯
E-Mail: ❮kontakt@partizip.online❯

### 2. Grundprinzipien

Partizip ist eine überparteiliche Plattform für kommunale Beteiligung. Wir
verarbeiten so wenige personenbezogene Daten wie möglich
(Datensparsamkeit): keine Werbung, kein Tracking, keine Weitergabe an
Dritte zu kommerziellen Zwecken, keine Profilbildung. Wo technisch möglich,
speichern wir Pseudonyme statt Klardaten.

### 3. Hosting und Server-Logdaten

Die Plattform läuft auf Servern der Hetzner Online GmbH, Industriestr. 25,
91710 Gunzenhausen, Deutschland (Serverstandort Deutschland;
Auftragsverarbeitungsvertrag nach Art. 28 DSGVO ❮TODO: AVV abschließen❯).
Beim Aufruf verarbeitet der Webserver technisch bedingt: IP-Adresse,
Zeitpunkt, aufgerufene URL, HTTP-Status, Datenmenge, Referrer, User-Agent —
zur Auslieferung der Seite und zur Gewährleistung von Stabilität und
Sicherheit. **Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO.
**Speicherdauer:** Löschung/Anonymisierung nach spätestens ❮14❯ Tagen
❮TODO: Log-Rotation technisch fixieren, Wert eintragen❯.

### 4. Konto und Anmeldung (Magic-Link)

Für ein Nutzerkonto verarbeiten wir Ihre **E-Mail-Adresse**. Die Anmeldung
erfolgt ohne Passwort über einen einmalig verwendbaren Anmelde-Link, der
15 Minuten gültig ist. Nach der Anmeldung speichert Ihr Browser ein
technisch erforderliches Session-Cookie (httpOnly; kein Tracking-Cookie;
Sitzungsdauer maximal 30 Tage).

- **Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (Bereitstellung des
  Dienstes); für das Session-Cookie § 25 Abs. 2 Nr. 2 TDDDG (unbedingt
  erforderlich, keine Einwilligung nötig).
- **Speicherdauer:** Anmelde-Token werden spätestens 24 Stunden nach
  Einlösung/Ablauf gelöscht; abgelaufene Sitzungen spätestens 30 Tage nach
  Ablauf. Ihr Konto bleibt bestehen, bis Sie es löschen — die Löschung können
  Sie jederzeit selbst im Bereich „Mein Konto" auslösen (siehe Ziff. 13).

### 5. Schutz vor Missbrauch (Rate-Limiting)

Zur Abwehr automatisierter Angriffe (z. B. massenhafte Anmeldeversuche)
zählen wir Anfragen pro Absender. Dazu speichern wir **keine Klartext-
IP-Adressen**, sondern ausschließlich kryptographisch verschlüsselte
Prüfsummen (HMAC mit geheimem Schlüssel), die ohne den Schlüssel nicht auf
Sie zurückführbar sind. **Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO.
**Speicherdauer:** 24 Stunden.

### 6. Wohnort-Bestätigung (Verifikationsstufen)

Beteiligungsfunktionen sind nach Stufen abgesichert. In Phase 1 gilt:
Stufe 0 (nur Lesen, kein Konto) und Stufe 1 (Konto mit bestätigter
E-Mail-Adresse, Selbsterklärung zu Wohnort/Ortsteil und Mindestalter).
Dazu speichern wir: Ortsteil-Zuordnung, Geburtsmonat und -jahr (kein
volles Geburtsdatum) und den Zeitpunkt Ihrer Selbsterklärung.
**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO.

### 7. Anliegen-Tracker

Wenn Sie ein Anliegen einreichen, speichern wir den Anliegen-Text, die
gewählte Kategorie/Ortsteil-Zuordnung und den Bearbeitungsstatus. Ihr
Anliegen wird **pseudonymisiert** geführt: Statt Ihres Kontos wird ein
nicht umkehrbares Pseudonym (HMAC) gespeichert; öffentlich sichtbar sind
nur Anliegen-Text und Status, niemals Ihre Identität. Den Bearbeitungsstand
können Sie (und Personen, denen Sie den Code geben) über einen zufällig
erzeugten Tracking-Code abrufen. Optional benachrichtigen wir Sie per
E-Mail über Statusänderungen; dafür speichern wir die Verknüpfung zwischen
Anliegen und Ihrer E-Mail-Adresse, bis Sie die Benachrichtigung abbestellen.
**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO.
**Hinweis:** Schreiben Sie keine personenbezogenen Daten Dritter in den
Anliegen-Text; veröffentlichte Texte werden redaktionell geprüft.

### 8. E-Mail-Versand

Anmelde-Links und Benachrichtigungen versenden wir über einen eigenen
SMTP-Server (❮Serverstandort/Betreiber bestätigen: eigener Mailserver,
Deutschland❯). Es findet kein Versand über US-Dienste statt; E-Mail-Adressen
werden nicht zu Werbezwecken genutzt.

### 9. Ratsinformationen und Digests

Die Plattform bereitet **öffentliche** Dokumente der kommunalen
Ratsinformationssysteme (Einladungen, Vorlagen, Protokolle) zu verständlichen
Zusammenfassungen („Digests") auf. Diese Dokumente können Namen von
Mandatsträgern und Verwaltungsmitarbeitern enthalten; wir verarbeiten sie,
wie sie von der Kommune veröffentlicht wurden, und verlinken stets auf die
Originalquelle. **Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO
(berechtigtes Interesse an der Information der Öffentlichkeit über
öffentliche Ratsarbeit). Jede Zusammenfassung wird vor Veröffentlichung
durch einen Menschen geprüft und freigegeben.

❮NUR AUFNEHMEN, WENN KI-GENERATOR AKTIVIERT WIRD:❯ Zur Erstellung von
Zusammenfassungs-Entwürfen können wir die Texte der öffentlichen
Ratsdokumente an die Anthropic PBC (USA) übermitteln (Claude-API). Dabei
werden **keine Daten von Nutzerinnen und Nutzern** übermittelt, sondern
ausschließlich die öffentlichen Dokumenttexte. Mit Anthropic besteht ein
Auftragsverarbeitungsvertrag mit EU-Standardvertragsklauseln; Anthropic
verwendet API-Daten nicht zum Training. ❮TODO Anwalt: Drittlandtransfer
Art. 44 ff. DSGVO bewerten; Anthropic DPA referenzieren❯

### 10. Kanäle auf Drittplattformen (Telegram, WhatsApp)

Unsere Digests verbreiten wir zusätzlich über einen Telegram-Kanal
(„Taunusstein – Ratsnachrichten") und ggf. einen WhatsApp-Kanal. Wenn Sie
diese Kanäle abonnieren, gelten die Datenschutzbestimmungen von Telegram
(Telegram FZ-LLC/Telegram Messenger Inc.) bzw. WhatsApp (Meta Platforms
Ireland Ltd.); wir erhalten von dort keine personenbezogenen Daten über
Abonnenten. Die Nutzung ist freiwillig — alle Inhalte sind auch ohne
Drittplattform auf dieser Website und per RSS verfügbar.

### 11. Keine Cookies außer Session, kein Tracking

Außer dem Session-Cookie (Ziff. 4) setzen wir keine Cookies ein. Wir nutzen
keine Analyse-/Statistik-Dienste Dritter, keine externen Schriftarten oder
CDNs und keine Social-Media-Plugins.

### 12. Empfänger und Auftragsverarbeiter

Hetzner Online GmbH (Hosting, Deutschland); ❮Mailserver-Betreiber, falls
nicht selbst betrieben❯; ❮ggf. Anthropic PBC, nur bei aktiviertem
KI-Generator, nur öffentliche Dokumenttexte❯. Eine Übermittlung an sonstige
Dritte findet nicht statt, außer wir sind gesetzlich dazu verpflichtet.

### 13. Ihre Rechte

Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16),
Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20)
und Widerspruch gegen Verarbeitungen nach Art. 6 Abs. 1 lit. f DSGVO
(Art. 21). Kontakt: siehe Ziff. 1. Beschwerderecht: Hessischer Beauftragter
für Datenschutz und Informationsfreiheit (HBDI), Gustav-Stresemann-Ring 1,
65189 Wiesbaden.

Für ein bestehendes Konto stehen zwei dieser Rechte als Selbstbedienung im
Bereich „Mein Konto" bereit: „Meine Daten exportieren" liefert die zu Ihrem
Konto gespeicherten Daten als maschinenlesbare JSON-Datei (Auskunft,
Art. 15). „Konto löschen" löscht Ihr Konto selbst (Art. 17): Kontodaten
(E-Mail, Wohnort-/Altersangaben, Rollen) werden anonymisiert bzw. gelöscht und
alle Sitzungen beendet. Bereits eingereichte Anliegen bleiben als pseudonymer
Vorgang erhalten (ohne Personenbezug); ein technisches Protokoll bleibt
PII-frei zu Nachweiszwecken bestehen. Für alle übrigen Anliegen wenden Sie
sich an die unter Ziff. 1 genannte Kontaktadresse.

### 14. Keine automatisierte Entscheidungsfindung

Es findet keine automatisierte Entscheidungsfindung einschließlich
Profiling im Sinne des Art. 22 DSGVO statt. Insbesondere entscheidet keine
KI über Veröffentlichungen oder über Ihre Beteiligungsrechte — Freigaben
erfolgen ausschließlich durch Menschen.

### 15. Änderungen

Wir passen diese Erklärung an, wenn sich Funktionsumfang oder Rechtslage
ändern. Es gilt die jeweils hier veröffentlichte Fassung.

---

## Anmerkungen für die anwaltliche Prüfung (nicht veröffentlichen)

1. **Phase 2 erfordert Erweiterung:** Abstimmungen (pseudonyme voter_refs,
   k-Anonymität bei Ergebnissen), Vor-Ort-Verifikation (Terminslots) und
   Brief-Code-Verifikation (`address_challenges`: Adresse wird nach Versand
   gelöscht) sind implementiert/geplant, aber in Phase 1 nicht aktiv.
2. **Verarbeitungsverzeichnis** (Art. 30) ist als Backlog-Posten erfasst und
   wird parallel erstellt; Zweckbindung je Datenbankfeld ist im Konzept
   dokumentiert.
3. **Mandatsträger-Daten in RIS-Dokumenten** (Ziff. 9): Stützung auf
   Art. 6 Abs. 1 lit. f; ggf. zusätzlich Medienprivileg (Art. 85 DSGVO,
   § 3 HDSIG-Umsetzungsspielraum) prüfen, da journalistisch-redaktionelle
   Aufbereitung.
4. **TDDDG-Zitat** (Ziff. 4): Gesetz heißt seit 14.05.2024 TDDDG (vorher
   TTDSG) — bitte Zitierweise bestätigen.
5. **Auskunfts-/Löschprozess:** Auskunft (Art. 15) und Löschung (Art. 17) sind
   als Self-Service im Konto-Bereich umgesetzt (Export als JSON; Löschung mit
   Bestätigung). Die Löschung anonymisiert die Konto-Zeile (E-Mail→Tombstone,
   PII genullt, `account_status='deleted'`) statt sie physisch zu entfernen,
   damit pseudonyme Anliegen und das PII-freie Audit-Protokoll erhalten
   bleiben — bitte prüfen, ob diese Anonymisierung als „Löschung" i. S. v.
   Art. 17 hinreichend ist (aus unserer Sicht ja, da der Personenbezug
   entfällt). Übrige Betroffenenrechte weiterhin manuell per E-Mail.
6. **HMAC-Pseudonyme** (Ziff. 5/7): Aus unserer Sicht Pseudonymisierung
   (Art. 4 Nr. 5), nicht Anonymisierung — daher als personenbezogene
   Verarbeitung mit kurzer Frist dargestellt. Bitte Formulierung prüfen.
