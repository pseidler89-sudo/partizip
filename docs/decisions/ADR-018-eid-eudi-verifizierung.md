# ADR-018: eID/EUDI als Verifizierungs-Provider (Remote-Stufe-2 / Wohnsitznachweis)

- **Status:** Akzeptiert (Richtungsentscheidung, Owner 2026-06-15) · Umsetzung als Tickets unten
- **Kontext-Docs:** `MARKTANALYSE_GENERELL.md` (P0), `IDENTITAET_WEGZUG.md`, `ADR-014` (Stufenmodell),
  `ADR-007` (Mindestalter), `ADR-016` (verifizierbares Abstimmen), `ADR-019` (Auth ≠ Verifizierung),
  `POSITIONING_W_SOCIAL.md`, `VOTE_PRIVACY.md`. **Keine Rechtsberatung.**

> **Herkunft:** externe Analyse-Session. Ergänzungsreferenz — bei Widerspruch gilt der real gebaute
> Code + `Konzept.MD` + `docs/decisions/`. **Abgrenzung (mit ADR-019):** eID/EUDI ist **Verifizierung
> (Stufe 2), niemals Login** — die Anmeldung läuft über Magic-Link/Session/Passkeys (ADR-017). Diese
> ADR hebt eID von P3 (`IDENTITAET_WEGZUG.md`) auf **P1**; die Umsetzung bleibt als Tickets im BACKLOG.

## Kontext
Stufe 2 (verbindlich abstimmen) braucht heute eine **In-Person-/QR-Verifizierung** → Engpass im
Funnel. Der Markt liefert jetzt eine bessere Remote-Schiene: Die **deutsche eID** (seit 2010 in
Ausweis/Pass) und die **EUDI Wallet** (eIDAS 2.0, EU-Pflicht bis Dez 2026, DE Vorreiter) können
**den Wohnsitz** verifizieren — genau das, was W Identity/World **nicht** geben. Beide sind
datensparsam (selektive Attributfreigabe), was zu Partizips Invarianten passt.

## Entscheidung
1. **Verifizierung wird ein pluggable Provider-Interface** (`VerificationProvider`) mit Adaptern:
   `InPersonQR` (heute, bleibt Fallback/Offline), **`GermanEid`** (jetzt umsetzbar) und
   **`EudiWallet`** (Erweiterung 2026/27, gleiches Muster).
2. **Nur abgeleitete, minimale Attribute speichern** — kein Klarname, keine volle Anschrift:
   - **Pseudonym** (eID: dienstespezifisches Kennzeichen / EUDI: PID-Pseudonym) → **Dubletten-Sperre**
     (eine Person, ein verifiziertes Konto; unverkettbar) — löst die Dubletten-Frage aus `IDENTITAET_WEGZUG.md`.
   - **Alters-Bestätigung** (≥18, Boolean) → Mindestalter ohne Geburtsdatum (vgl. ADR-007).
   - **Wohnort** → on-the-fly auf **`scope_level`/`scope_code`** gemappt und nur das Ergebnis
     (z. B. „Taunusstein") + ein `residency_verified_until` gespeichert; die rohe Anschrift wird **nicht** persistiert.
3. eID hebt sich damit von P3 (in `IDENTITAET_WEGZUG.md`) auf **P1**; EUDI bleibt die Roadmap-Erweiterung.

## Wie es funktioniert (Kurzmechanik)
**Deutsche eID (heute):**
- Nutzer:in identifiziert sich mit Ausweis + **AusweisApp** (NFC).
- Partizip ist **Relying Party** und braucht ein **Berechtigungszertifikat** (legt fest, welche
  Felder gelesen werden dürfen — Datensparsamkeit by design), beantragt über die **VfB/BVA** via BerCA.
- Technisch über einen **eID-Service** (z. B. Governikus/AusweisIDent, Bundesdruckerei/D-Trust,
  Deutsche Post POSTIDENT eID) ODER eigenen eID-Server; Sicherheit per EAC v2 (BSI).
- Gelesen werden nur: **Pseudonym + Altersverifikation + Anschrift** (nichts sonst).

**EUDI Wallet (2026/27):**
- Nutzer:in präsentiert Nachweise aus der Wallet via **OpenID4VP**; **selektive Offenlegung**
  (nur Alter/Wohnort/Pseudonym).
- Partizip implementiert einen **OpenID4VP-Verifier-Endpoint**, registriert sich im **nationalen
  Relying-Party-Register** + holt ein **Access-Zertifikat**, prüft Trust-/Revocation-Listen,
  mappt SD-JWT-VC/mdoc-Claims auf interne Attribute.

## Was zu tun ist (Umsetzung)

**Organisatorisch/rechtlich (Owner)**
- [ ] Zweck + **Datenschutzkonzept** für den Attributzugriff (Pseudonym/Alter/Anschrift) formulieren.
- [ ] **Berechtigungszertifikat** beantragen (VfB/BVA über eine BerCA); eID-Service-Anbieter wählen (Kosten/Tenant-Modell).
- [ ] EUDI: Zeitplan beobachten; ~Q4 2026 RP-Registrierung + Access-Zertifikat vorbereiten.

**Technisch (Build-Session)**
- [ ] `VerificationProvider`-Interface + Adapter `InPersonQR` (Refactor bestehender QR-Flow dahinter).
- [ ] Adapter **`GermanEid`** gegen eID-Service (Redirect/Callback, Attribut-Mapping → Pseudonym/Alter/Wohnort).
- [ ] **Wohnort→`scope_level`-Mapping** (PLZ/Gemeinde → Ortsteil/Stadt/Kreis/Land) + nur Ergebnis speichern.
- [ ] **Pseudonym-Dedup**: unique constraint je Tenant; Konflikt → „bereits verifiziert".
- [ ] Stufe-2-Vergabe + `residency_verified_until` aus Provider-Resultat; In-Person bleibt Fallback.
- [ ] Tests: Adapter-Contract, Dedup, scope-Mapping, Ablauf/Re-Verifizierung; Trust-Seite ergänzen.
- [ ] (Später) Adapter **`EudiWallet`** (OpenID4VP-Verifier) nach gleichem Contract.

## Konsequenzen
- **Funnel-Hebel:** Stufe 2 ohne Vor-Ort-Termin → mehr verifizierte Stimmen, schnellerer Pilot-Rollout.
- **Datensparsamkeit gewahrt:** nur Pseudonym/Alter/Scope, keine Klaridentität/rohe Anschrift.
- **Zukunftssicher:** gleiches Provider-Muster für eID heute und EUDI ab 2027 (Relying-Party-Pflicht).
- **Aufwand/Abhängigkeit:** Berechtigungszertifikat + eID-Service (Bürokratie + Kosten) — daher In-Person als Fallback behalten.

## Risiken
- Berechtigungszertifikat-Prozess (Dauer/Zweckprüfung); eID-Service-Kosten.
- EUDI-Specs noch in Bewegung (Deadline eng) → erst als gekapselter Adapter, keine harte Abhängigkeit.
- „Verifiziert" wird Commodity → Burggraben bleibt Governance/kommunale Hoheit, nicht die Identität.

## Alternativen
- **Nur In-Person/QR** (Status quo): bleibt als Fallback, skaliert aber schlecht.
- **W Identity/World als Provider:** liefern **keinen Wohnsitz** → für Eignung ungeeignet (siehe POSITIONING_W_SOCIAL.md).

## Quellen
- BSI eID-Funktion: https://www.bsi.bund.de/EN/Themen/Oeffentliche-Verwaltung/Elektronische-Identitaeten/Online-Ausweisfunktion/online-ausweisfunktion_node.html
- Berechtigungszertifikat: https://www.berechtigungszertifikat.de/ · Implementierungs-Leitfaden: https://www.die-online-ausweisfunktion.de/leitfaden-zur-implementierung/implementierung-der-online-ausweisfunktion/
- eID-Service (Beispiel Governikus AusweisIDent): https://www.governikus.de/en/produkte/ausweisident/
- EUDI ARF / OpenID4VP: https://eudi.dev/1.4.0/arf/ · RP-Integration: https://trustid-solutions.eu/en/articles/eudi-wallet-integration-guide
- EUDI Rollout 2026: https://www.corbado.com/blog/eudi-wallet-2026-deadline-rollout-eic-2026
