# ADR-017 — Anmelde-/Konto-Konzept für Nutzertypen

**Status:** akzeptiert · **Datum:** 2026-06-15 · **Entscheidung:** Patrick
**Bezug:** ADR-005 (E-Mail/Magic-Link), ADR-006 (DB-Sessions statt JWT),
ADR-007 (Mindestalter), ADR-016 (verifizierbares Abstimmen), ADR-015 (Single-Domain-Pilot),
ADR-018 (eID/EUDI = Verifizierung, **nicht** Login), ADR-019 (Bürger-Wiederkehr-Anmeldung — **hier
eingearbeitet**, siehe Ergänzung unten)

## Kontext
Aus dem Staging-Test (Patrick): der „Anmelden"-Button (Anker `#anmelden`) wirkte
tot, Admin-Funktionen waren nicht auffindbar, und konzeptionell stellte sich die
Frage nach unterschiedlichen Login-Wegen für Normalnutzer vs. Admins, 2FA in
Produktion und der Provisionierung von Admin-Konten. Eine Multi-Agent-Analyse
(Bestandsaufnahme + UX/Admin/Sicherheit + Synthese) wurde durchgeführt — vollständiger
Bericht: interne Auth-Konzept-Analyse (nicht Teil dieses Repos).

## Entscheidung
1. **Ein Auth-Stamm für alle:** passwortloser **Magic-Link** bleibt der Kern
   (TTL 15 min, single-use, Rate-Limit, Origin-Check, Enumeration-Schutz, DB-Sessions
   host-only). Bürger bleiben **bewusst Single-Faktor** — der Schadenshorizont eines
   Bürger-Kontos ist eine Stimme; 2FA wäre Reibung ohne verhältnismäßigen Gewinn.
2. **Einstieg = globales Login-Modal/Sheet** (mobil Bottom-Sheet), von JEDER Seite
   per Nav-Button und per `pz:open-login`-Event (z. B. „Zum Mitstimmen anmelden").
   Kein Seitenwechsel, Kontext bleibt. Die **`/anmelden`-Seite bleibt** als
   Deep-Link-/no-JS-Fallback. Der fragile `#anmelden`-Anker entfällt.
3. **Admin = derselbe Magic-Link + Rollen.** **Keine eigene Admin-Subdomain**
   (bräche das host-only Session-Cookie aus ADR-006 und brächte ohne 2FA keinen
   Sicherheitsgewinn). Stattdessen nur **Sichtbarkeit**: „Verwaltung"-Link in der
   Nav für Admins, Admin-Karte auf `/konto`, Admin-Guards leiten bei fehlender Auth
   auf `/anmelden` statt auf die Startseite. (`patrick@seidler.ml` ist bereits
   `kommune_admin` — es fehlte nur die Affordanz.)
4. **Produktion — 2FA für privilegierte Konten (Richtung festgelegt: TOTP-first):**
   TOTP-Pflicht (RFC 6238, self-hosted, kein externer Dienst) für Konten mit
   Admin-Rolle + **Step-up/Freshness-Check** vor sensiblen Aktionen (Rollenvergabe,
   Poll-Aktivierung, Konto-Löschung). **WebAuthn/Passkeys** als phishing-resistentes
   Upgrade auf der Roadmap (BundID nur ADR-Kandidat für spätere große Kommunen).
   Begleitend: Session-Härtung (Admin-TTL 8–24 h sliding, Rotation bei
   Privilege-Wechsel, Session-Liste/„überall abmelden"), Verify-Versuchs-Cap,
   Boot-Zeit-Fail-closed (Salts/SMTP), Out-of-Band-Mail bei `role.granted/revoked`.
   Optional gegen Handy-Abbrüche: 6-stelliger Code zusätzlich zum Link in derselben Mail.
5. **Provisionierung:** Pilot = gehärtetes `grant-role`-Runbook (Self-Login zuerst).
   Produktion = **idempotenter ENV-Seed-Bootstrap** (`BOOTSTRAP_SUPER_ADMIN_EMAIL`)
   für den ersten `super_admin` (auditiert, `actorType=system`) +
   **Einladungs-Flow** für weitere Kommunen-Admins; CLI bleibt Break-Glass.

## Konsequenzen
- **Jetzt umgesetzt (Pilot, `2026-06-15`):** globales Login-Modal + Nav/CTA;
  Admin-Karte auf `/konto` (via `/api/me isAdmin`); Admin-Guards → `/anmelden`;
  tote `#anmelden`-Links entfernt. `/anmelden`-Seite bleibt als Fallback.
- **Vor Produktiv-Launch (BACKLOG):** TOTP + Step-up, Session-Härtung,
  ENV-Seed-Bootstrap, Verify-Cap/Fail-closed, Out-of-Band-Mail; danach Passkeys
  und Kommunen-Einladungs-Flow.
- Bewusste Abwägung: TOTP ist real-time-phishbar — gehört gezieltes Admin-Phishing
  fest zur Bedrohungsannahme, wird TOTP übersprungen und direkt auf origin-gebundene
  Passkeys gesetzt. Bis dahin ist TOTP der gangbare ~90%-Hebel.

## Begründung
Ein einziger Auth-Stamm minimiert Angriffsfläche und Komplexität; die echte
Trennung privilegierter Konten entsteht durch **2FA**, nicht durch Domain/Pfad.
Das Modal löst Patricks „kein Seitenwechsel" generisch für ALLE Seiten (nicht nur
die Landing, die als einzige ein Inline-Formular hatte). Die Provisionierung wird
vom impliziten CLI-Reihenfolge-Trick zur auditierbaren Deploy-Garantie gehoben.

## Ergänzung 2026-06-18 — Bürger-Wiederkehr-Anmeldung (ADR-019 eingearbeitet)

ADR-019 (Vorschlag externe Analyse-Session) ist hier eingearbeitet; ADR-019 selbst ist als
*„merged into / superseded by ADR-017"* markiert. Kernklarstellung und Bürger-Komfort-Pfad:

6. **Authentifizierung ≠ Verifizierung.** *Auth* („derselbe Account-Inhaber?") passiert bei **jeder**
   Anmeldung (Magic-Link, Session, Passkey). *Verifizierung* („echter, einzigartiger Mensch, der **hier
   wohnt**?") ist **einmalig** (Stufe 2; QR/Vor-Ort heute, eID/EUDI als Roadmap — **ADR-018**). Daraus
   folgt unmissverständlich: **Der Personalausweis (eID) ist KEIN Login-Mechanismus** (NFC+PIN bei jeder
   Anmeldung wäre mehr Reibung als Magic-Link; ein Passkey beweist nichts über Person/Wohnort). eID/EUDI
   wird im Code/UX **nie** als „Anmelden" angeboten — nur als „Verifizieren".
7. **Lange, gleitende Bürger-Session** (Ziel ~60–90 Tage, sliding; httpOnly, host-only wie ADR-006) →
   **keine E-Mail bei jeder Anmeldung**, nur bei neuem Gerät / nach Ablauf. Das ist der billigste Fix für
   den Alltags-Schmerz. Bewusst **getrennt** von der kurzen **Admin-TTL (8–24 h)** aus Punkt 4. Gegengewicht
   bleibt die Session-Liste / „überall abmelden"; Rotation bei Stufe-2-/Rollen-Wechsel.
8. **Passkeys (WebAuthn) als primärer Wiederkehr-Login für Bürger** — nach dem ersten Login optional
   registrierbar, danach Face-ID/Fingerprint/Geräte-PIN: sofort, ohne Mail, phishing-resistent,
   datensparsam (kein geteiltes Geheimnis). Damit wird das in Punkt 4 als „Roadmap-Upgrade" genannte
   Passkey-Thema für den **Bürger-Komfort vorgezogen** (bei Bürgern ist TOTP ohnehin nicht gewollt).
9. **Magic-Link bleibt** Bootstrap (erstes Gerät) **und Recovery** (Passkey verloren/Gerätewechsel) →
   **kein Lockout**, Magic-Link nie ganz entfernen. **Admins unverändert** (TOTP/Passkey + Step-up, kurze TTL).

**Reihenfolge nach Aufwand/Nutzen:** (a) lange Sessions = minimal, sofort; (b) Passkeys = mittlerer
Aufwand, großer UX-Hebel; (c) eID/EUDI = Verifizierungs-Roadmap (ADR-018), **nicht** Login.
**Abwägung:** lange Sessions vergrößern das Zeitfenster bei Gerätediebstahl — akzeptabel für Bürger
(Schadenshorizont = eine Stimme, vgl. Punkt 1). Tickets dazu im BACKLOG (Bürger-Login-Block).
