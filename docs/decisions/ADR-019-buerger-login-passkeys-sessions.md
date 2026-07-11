# ADR-019 — Bürger-Login-UX: Passkeys + lange Sessions; Auth ≠ Verifizierung

**Status:** ⛔ **MERGED INTO / SUPERSEDED BY ADR-017** (2026-06-18). Der Inhalt ist in ADR-017 als
„Ergänzung 2026-06-18 — Bürger-Wiederkehr-Anmeldung" (§6–9) eingearbeitet; **kanonisch ist ab jetzt
ADR-017**. Dieses Dokument bleibt als Begründungs-/Quellen-Archiv erhalten. **Keine Rechtsberatung.**
**Bezug:** ADR-017 (Anmeldekonzept), ADR-006 (DB-Sessions), ADR-018 (eID/EUDI-Verifizierung),
ADR-014 (Stufenmodell), AUTH_SECURITY.md.

> **Herkunft:** externe Analyse-Session. Bei Widerspruch gilt der real gebaute Code + `docs/decisions/`.
> ADR-017 ist die kanonische Auth-Entscheidung; diese ADR konkretisiert nur die **Bürger-Wiederkehr-
> Anmeldung** und die **Abgrenzung Auth↔Verifizierung**. Doppeltes bitte in ADR-017 einarbeiten.

## Kontext
Frage Patrick: Magic-Link schickt bei jeder Anmeldung eine E-Mail — das nervt im Alltag. Idee:
„Der Ausweis (eID) wäre fast ein Passkey" / „oder generell Passkeys". Dahinter steckt eine
**Verwechslung zweier Dinge**, die wir hier sauber trennen.

## Grundsatz (die zentrale Klarstellung)
- **Authentifizierung** = „derselbe Account-Inhaber wie vorher?" → passiert bei **jeder** Anmeldung
  (Magic-Link, **Passkey**, Session).
- **Verifizierung** = „echter, einzigartiger Mensch, der **hier wohnt**?" → **einmalig** (Stufe 2;
  QR/Vor-Ort heute, **eID/EUDI** als Roadmap, ADR-018).

Daraus: **Der Ausweis ist KEIN Login-Mechanismus.** NFC + 6-stellige eID-PIN bei *jeder* Anmeldung
wäre **mehr** Reibung als Magic-Link, und ein Passkey wiederum beweist **nichts** über Person/Wohnort.
→ eID bleibt strikt **Verifizierung** (ADR-018), Passkeys/Sessions sind die **Anmeldung**.

## Entscheidung / Empfehlung (Bürger)
1. **Magic-Link bleibt** Bootstrap (erste Anmeldung pro Gerät) und **Recovery** (ADR-017 unverändert).
2. **Lange, gleitende Bürger-Session** (Ziel ~60–90 Tage, sliding; httpOnly, host-only wie ADR-006).
   → **keine E-Mail bei jeder Anmeldung**, sondern nur bei neuem Gerät / nach Ablauf. Das ist der
   **billigste** Fix für Patricks Schmerz (ADR-017 setzt explizit nur die *Admin*-TTL auf 8–24 h;
   Bürger-TTL hier bewusst lang). „Überall abmelden"/Session-Liste aus ADR-017 bleibt das Gegengewicht.
3. **Passkeys (WebAuthn) als primärer Wiederkehr-Login** für Bürger: nach dem ersten Login optional
   Passkey registrieren → danach Face-ID/Fingerprint/Geräte-PIN, **sofort, ohne Mail,
   phishing-resistent, datensparsam** (kein geteiltes Geheimnis). Hebt ADR-017s „Passkeys als
   Roadmap-Upgrade" für den **Bürger-Komfort** vor (bei Bürgern ist TOTP ohnehin nicht gewollt).
4. **Reihenfolge nach Aufwand/Nutzen:** (a) lange Sessions = minimal, sofort; (b) Passkeys =
   mittlerer Aufwand, großer UX-Hebel; (c) eID/EUDI = Verifizierung-Roadmap (ADR-018), **nicht** Login.

## Verifizierungsstärke an Verbindlichkeit koppeln
Stufe-1-Mitmachen (Masse, niedrigschwellig) braucht nur leichte Auth (Session/Passkey). Nur
**verbindliche** Abstimmungen brauchen Stufe-2-Verifizierung. Auth-Komfort und Verifizierungs-Tiefe
also getrennt skalieren.

## Konsequenzen / Tickets (Build-Session)
- [ ] **Bürger-Session-TTL** konfigurierbar + sliding (lang); Admin-TTL bleibt kurz (ADR-017).
- [ ] **WebAuthn**: Passkey-Registrierung nach Login + Passkey-Login; user-verification required;
      mehrere Passkeys pro Konto; Anzeige/Verwaltung im `/konto`.
- [ ] **Recovery-Pfad**: Passkey verloren/Gerätewechsel → Magic-Link bleibt Fallback (kein Lockout).
- [ ] **Trennung im Code/UX** sichtbar machen: „Anmelden" (Session/Passkey) ≠ „Verifizieren" (Stufe 2);
      eID/EUDI niemals als Login anbieten.
- [ ] UX-Copy: „Schneller anmelden mit Face-ID/Fingerabdruck" (nach erstem Login anbieten).
- [ ] Tests: Passkey-Register/Login, Fallback auf Magic-Link, Session-Ablauf/Rotation, „überall abmelden".

## Risiken / Abwägung
- **Passkey-Verlust / Geräteverlust** → Recovery via Magic-Link (deshalb Magic-Link nie ganz entfernen).
- **Lange Sessions** erhöhen das Zeitfenster bei Gerätediebstahl → akzeptabel für Bürger
  (Schadenshorizont = eine Stimme, vgl. ADR-017); Gegengewicht: Session-Liste + Rotation bei Stufe-2/Rollen-Wechsel.
- **Admins:** unberührt — dort gilt weiter ADR-017 (TOTP/Passkey + Step-up), strengere TTL.

## Alternativen (verworfen)
- **eID/Ausweis als Login:** zu viel Reibung pro Anmeldung (NFC+PIN), niedrige eID-PIN-Verbreitung; eID bleibt Verifizierung.
- **Passwort:** schlechtere UX + Breach-/Phishing-Risiko als Passkey.
- **Social-Login (Google/Apple):** widerspricht Datensparsamkeit/Überparteilichkeit/Souveränität → nein.

## Quellen
- WebAuthn/Passkeys (W3C): https://www.w3.org/TR/webauthn-3/ · Passkeys-Überblick: https://fidoalliance.org/passkeys/
- eID-Mechanik/Hürden: siehe ADR-018 + BSI eID (https://www.bsi.bund.de/EN/Themen/Oeffentliche-Verwaltung/Elektronische-Identitaeten/Online-Ausweisfunktion/online-ausweisfunktion_node.html)
