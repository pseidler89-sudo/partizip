# ADR-026 — Anonymität & Sichtbarkeits-Modi: geheime Stimme, optional offener Beitrag

**Status:** Akzeptiert · **Datum:** 2026-07-14 · **Entscheidung:** Owner (Patrick)
**Bezug:** Konkretisiert das Wahlgeheimnis-/k-Anonymitäts-Fundament
(`docs/architecture/VOTE_PRIVACY.md`, `docs/architecture/K_ANONYMITY.md`,
ADR-022) und grenzt es gegen sichtbare Beiträge (Anliegen-Tracker ADR-010) ab.

## Kontext

Beteiligung umfasst zweierlei: **die Stimme** (eine Abstimmung) und **den Beitrag**
(ein Vorschlag, ein Anliegen, ein Argument). Beide werden leicht in einen Topf
geworfen — mit gegensätzlichen Bedürfnissen. Eine Stimme muss geheim sein, damit
niemand unter Druck gerät. Ein Vorschlag lebt oft davon, dass jemand **erkennbar
dahintersteht** und Verantwortung übernimmt. Wir müssen sauber trennen, **was
anonym ist und warum**, von dem, **was optional offener sein darf**.

## Entscheidung

1. **Die Stimme bleibt geheim — nicht verhandelbar.** Für jede Abstimmung gilt
   das Wahlgeheimnis: Erfassung über HMAC-Pseudonym, k-Anonymität vor
   Ergebnisanzeige, keine Rückführbarkeit einer abgegebenen Stimme auf eine
   Person (`VOTE_PRIVACY.md`, `K_ANONYMITY.md`, ADR-022). **Grund:** Schutz vor
   Druck, Repression und Nachteilen. Kein neuer Sichtbarkeits-Modus weicht dies
   auf.
2. **Offen für andere Modi — ohne Aufweichung des Wahlgeheimnisses.** Neben der
   geheimen Stimme darf ein **Beitrag** (Vorschlag/Anliegen) bewusst **pseudonym
   sichtbar** sein: Der Autor entscheidet, unter einem Pseudonym erkennbar
   aufzutreten. Das betrifft ausschließlich Beiträge, nie das Stimmverhalten.
3. **Ergebnisdarstellung mit Verifikationsanteil.** Abstimmungsergebnisse dürfen
   ausweisen: **„X Stimmen, davon Y verifiziert"** — die Aussagekraft steigt
   (verifizierter Wohnsitz, ADR-014), ohne dass eine einzelne Stimme einer Person
   zuordenbar wird. Aggregat bleibt Aggregat.
4. **Klare begriffliche Trennung** (verbindlich in Nutzertexten):
   - **Anonym** ist **die Wahl** — weil geheime Abstimmung vor Druck schützt.
   - **Optional offener** darf **der Beitrag** sein — weil ein Vorschlag von
     erkennbarer Verantwortung profitieren kann.
   Nutzertexte adressieren die Bürgerin/den Bürger mit „Sie" und benennen bei
   jeder Eingabe unmissverständlich, ob sie geheim (Stimme) oder sichtbar
   (Beitrag) ist.

## Begründung

- Das Wahlgeheimnis ist die Vertrauensgrundlage jeder verbindlichen Abstimmung;
  es aufzuweichen wäre ein Bruch mit der Kernpositionierung und rechtlich heikel.
- Zugleich ist erzwungene Anonymität für Vorschläge kontraproduktiv: Sichtbare,
  pseudonyme Urheberschaft fördert Verantwortung und Diskurs. Die Trennung
  erlaubt beides, ohne das eine für das andere zu opfern.
- „X Stimmen, davon Y verifiziert" macht Datenqualität transparent, ohne die
  k-Anonymität zu berühren — Y ist eine Zahl, kein Namensverzeichnis.

## Konsequenzen

- **Datenmodell/UI:** Beiträge (ADR-010) erhalten einen Sichtbarkeits-Modus
  (anonym / pseudonym-sichtbar); Stimmen haben **keinen** solchen Umschalter — sie
  sind immer geheim. Ergebnis-Views zeigen optional den verifizierten Anteil.
- **Prüfung:** Kein Feature darf einen Pfad schaffen, der Stimme und Identität
  verknüpft; das bleibt Review-Kriterium gegen `VOTE_PRIVACY.md`.
- **Texte:** Alle betreffenden Nutzertexte kennzeichnen geheim vs. sichtbar
  explizit; Pseudonym-Wahl ist eine bewusste Aktion, nie Default für Stimmen.
- Nichts in Stein — bewährt sich etwas nicht, wird es geändert, solange das
  Wahlgeheimnis unangetastet bleibt.
