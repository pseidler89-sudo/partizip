# ADR-014 — Abstimm- & Verifikationsmodell: Stufe-1-Minimum + QR-Verifizierung

**Status:** akzeptiert · **Datum:** 2026-06-13 · **Entscheidung:** Patrick
**Bezug:** ADR-013 (Mitmachen zuerst), ADR-007 (Stufenmodell), IDENTITAET_WEGZUG
(Verifikations-Ablauf). **Revidiert** die frühere MVP-Entscheidung „anonymes
Stimmungsbild als Default".

## Kontext
Anonymes Abstimmen („jeder über die Website, 0 verifiziert") lädt Bots/Trolle ein
und wirkt für die Institutionen (Multiplikatoren) unglaubwürdig. Gleichzeitig
sollen Bürger zur Verifizierung *bewegt*, nicht abgeschreckt werden.

## Entscheidung
1. **Mitstimmen erfordert mind. Stufe 1** (E-Mail-Konto, Magic-Link, kein
   Passwort). Anonymes Abstimmen entfällt → jede Stimme hängt an einer
   bestätigten E-Mail (Bot-/Troll-Schutz). Frage **und** Ergebnis bleiben für
   alle (auch nicht angemeldet) sichtbar — der Wert kommt vor der E-Mail-Frage;
   nur das Mitstimmen kostet die kurze Anmeldung.
2. **Verifiziert-Unterscheidung sichtbar, aber dezent:** Ergebnisse weisen Stufe-2
   (wohnsitz-verifiziert) separat aus — auch für Unangemeldete erkennbar
   („X Stimmen, davon Y verifiziert"), unaufdringlich (kein Alarm-Ton), mit
   kurzer Erklärung. Macht Verifizierung erstrebenswert, ohne abzuschrecken.
3. **Verbindliche Abstimmungen:** nur Stufe 2.
4. **QR-Verifizierung = Schnellweg zu Stufe 2 (Wohnsitz):** Verifier/Admin/
   Institution erzeugt einen **signierten QR** (kurze Gültigkeit + Nutzungs-
   Limit + scope-gebunden). Ein **eingeloggter** Bürger löst ihn ein →
   **dauerhafte** Wohnsitz-Verifizierung (Stufe 2) für seinen Bereich, **mit
   Ablauf** (Default 24 Monate → Re-Verifizierung, vgl. IDENTITAET_WEGZUG).
   Ersetzt im Pilot den Briefcode. Sicherheit: signiert (nicht erratbar),
   kurzlebig, gedeckelt, nur eingeloggt einlösbar → ein geleakter QR verifiziert
   nicht beliebig viele Fremde. Restrisiko (Weitergabe im Limit) für ein
   Bürger-Stimmungsbild akzeptabel; die Institution „vouched" für ihre Leute.
5. **Anliegen-Einreichen vorerst deaktiviert** (Feature-Flag): braucht
   Kuratierung, lenkt vom Kern ab. Code bleibt, Roadmap „gebaut, später aktiv".

## Listing (viele Umfragen)
- **Nicht angemeldet:** aktive Abstimmungen neu→alt; Frage + Ergebnis lesbar,
  „Anmelden zum Mitstimmen".
- **Angemeldet:** getrennt „Für dich offen" (aktiv, im eigenen Gebiet, noch nicht
  abgestimmt) und „Bereits teilgenommen". Gebiet = Stufenmodell, geschachtelt
  (Ortsteil ⊂ Stadt ⊂ Kreis ⊂ Land).

## Konsequenzen
- `abstimmen` wird auf Stufe-1-Pflicht umgestellt (anonymer Device-Pfad entfällt).
- M4-Verifizierung kommt als **leichtgewichtige QR-Variante früh** (statt Brief).
- Build-Reihenfolge: (Block 1) Stufe-1-Abstimmen + Verifiziert-Anzeige + Listing
  + Anliegen-Flag; (Block 2) QR-Verifizierung; (Block 3) M5 Composer-UI für
  Multiplikatoren. Nichts in Stein — bei Nicht-Bewährung ändern.
