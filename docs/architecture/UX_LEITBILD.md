# UX-Leitbild — „Das iPhone/Tesla der Bürgerbeteiligung"

**Status:** Leitbild / North Star (Patrick, 2026-06-17). **Keine Rechtsberatung.**
**Verhältnis zu anderen Docs:** Dies ist das *übergeordnete Leitbild*. Es wird konkretisiert durch
`ACCESSIBILITY.md` (das *Wie* der Bedienbarkeit), das UX-Wording-Dokument (intern, die *Worte*) und das
*Design-Profil* in `app/src/app/globals.css` (der *Look*). Bei Widerspruch gilt der real
gebaute Code + `docs/decisions/`.

> **Herkunft:** externe Analyse-Session. Bitte von der Build-Session als verbindliches Leitbild in den
> bestehenden UX-Strang einarbeiten (in ACCESSIBILITY.md bzw. dem internen UX-Wording-Dokument verweisen).

## Vision in einem Satz
Wer Partizip öffnet, wird **begrüßt, versteht sofort, worum es geht, und kann nichts falsch machen** —
ohne Anleitung, ohne Fachwissen, auf dem Handy. Bedienung „so selbstverständlich wie ein iPhone,
so aufgeräumt wie ein Tesla-Screen".

## Die Leitprinzipien (mit Regel + Prüfstein)

1. **Selbsterklärend in 5 Sekunden.** Die erste Ansicht *begrüßt* und sagt in einem Satz, was das ist
   und was man tun kann. *Regel:* above the fold = Zweck + **eine** klare Aktion („Mitmachen"); kein
   Fachjargon, keine Anleitung nötig. *Prüfstein:* Eine fremde Person versteht in 5 s, wo sie ist und was sie tun kann.

2. **Eine offensichtliche Aktion pro Screen.** *Regel:* genau ein primärer CTA je Ansicht; Fortgeschrittenes
   erst auf Nachfrage (progressive disclosure). *Prüfstein:* Auf jedem Screen ist die „Hauptsache" sofort erkennbar.

3. **Man kann nichts kaputt machen.** *Regel:* sichere Defaults; rückgängig machbar wo möglich;
   Unumkehrbares mit Bestätigung (2-Step-Publish); **niemals eine Sackgasse — immer ein nächster Schritt**;
   Fehlermeldungen ohne Schuldzuweisung (siehe internes UX-Wording-Dokument). *Prüfstein:* Es gibt keinen Klick, der ohne
   Warnung etwas Unwiederbringliches tut, und keinen toten Endzustand.

4. **Geführt statt überfordert.** *Regel:* mehrstufige Abläufe (verifizieren, abstimmen, Frage erstellen)
   sind ein **klarer linearer Pfad mit sichtbarem Fortschritt**, keine Optionswand. *Prüfstein:* Man weiß
   jederzeit „Schritt X von Y" und was als Nächstes kommt.

5. **Klarheit vor Vollständigkeit.** *Regel:* einfache Sprache (Leichte-Sprache-tauglich auf den Kernpfaden),
   Vertrauen/Datenschutz in *einem* Satz erklärt, nicht als Textwand. *Prüfstein:* Kein Bildschirm verlangt Lesen
   von mehr als nötig, um weiterzukommen.

6. **Wertig & ruhig (premium-civic).** *Regel:* konsistente Muster überall, ruhiges Layout, keine ruckeligen
   Zustände; **Skeletons statt Spinner**; Eingaben gehen bei Fehlern nie verloren. *Prüfstein:* Es „fühlt sich
   gebaut an", nicht zusammengesteckt.

7. **Für alle bedienbar = Teil von „einfach".** *Regel:* WCAG 2.2 AA, große Touch-Ziele, Daumen-Zone, kein
   Bedeutungsträger nur über Farbe (siehe ACCESSIBILITY.md). *Prüfstein:* Auch mit Screenreader / großer Schrift / einer Hand nutzbar.

8. **Sofortiges, ehrliches Feedback.** *Regel:* jede wichtige Aktion wird bestätigt („Deine Stimme wurde anonym
   gezählt"), Status (verifiziert / nicht verifiziert) ist immer sichtbar. *Prüfstein:* Man ist nie im Unklaren, ob etwas geklappt hat.

9. **Smart Defaults, minimale Eingabe.** *Regel:* so wenig Felder wie möglich; Sinnvolles vorbelegen (z. B. Region
   aus PLZ/Standort); nichts abfragen, was nicht gebraucht wird (Datensparsamkeit). *Prüfstein:* Bis zur ersten Stimme braucht es minimale Eingaben.

## Der Litmus-Test (so messen wir „iPhone/Tesla")
> Eine **nicht-technikaffine Person** schafft auf dem **Smartphone** den Kernpfad
> (ankommen → verstehen → mitstimmen) **ohne Hilfe, ohne Anleitung, ohne Fehlklick** — beim ersten Versuch.

Wenn das nicht gelingt, ist die Ansicht noch nicht fertig.

## Warum das den Pitch stärkt
Eine Oberfläche, die einen **begrüßt und sofort verständlich ist, verkauft sich im Demo selbst** — gerade
vor nicht-technischen Entscheider:innen in Kommunen. „Narrensicher" ist hier kein nice-to-have, sondern das
**Adoptions-Argument**: Wenn die Bürgerin es ohne Schulung bedienen kann, sinkt das Einführungsrisiko der Kommune.
*Pitch-Satz:* „Sie werden von der ersten Sekunde an an die Hand genommen — und genau deshalb machen Ihre
Bürger:innen mit."

## Offener Punkt (zu entscheiden)
**Tonalität:** Das Design-Profil sagt **„Sie"**, das UX-Wording-Dokument nutzt **„Du"**. Bitte **eine**
Linie festlegen (für die civic-/Kommunen-Glaubwürdigkeit spricht „Sie"; für Niedrigschwelligkeit „Du") und
beide Docs angleichen. Konsistenz schlägt Geschmack.

## Definition of done (Build-Session)
- [ ] Leitbild in ACCESSIBILITY.md referenziert; Tonalität vereinheitlicht.
- [ ] Pro Kern-Screen: genau ein primärer CTA (Audit) + „nächster Schritt immer vorhanden" (kein Dead-End).
- [ ] First-Time-Verständlichkeit auf einem echten Smartphone getestet (Litmus-Test) — kurz protokolliert.
- [ ] Landing begrüßt + erklärt Zweck in 5 s; Onboarding ohne Pflicht-Lesen.
- [ ] Pitch um den „an die Hand genommen"-Baustein ergänzt.
