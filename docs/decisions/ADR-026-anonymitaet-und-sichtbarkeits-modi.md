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

## Bekanntes Restrisiko: `voter_ref`

Ehrlichkeit gehört zur Vertrauensgrundlage: Unser Wahlgeheimnis ist **stark, aber
nicht mathematisch perfekt**. Eine Stimme wird nicht anonym gespeichert, sondern
unter einem Pseudonym `voter_ref` = HMAC-SHA256(SALT, „vote:user:" + userId) —
salt-geschützt, deterministisch (für Dedup via UNIQUE), PII-frei im Audit. Die
**gewählte Option (`choice`) erscheint nie im Audit**, und Ergebnisse werden erst
nach serverseitiger **k-Anonymität** freigegeben.

Das Restrisiko: Ein **DB-Insider mit gleichzeitigem Zugriff auf den Salt**
(`VOTE_REF_SALT`, ersatzweise `ANLIEGEN_REF_SALT`) könnte `voter_ref` für eine
bekannte `userId` selbst nachrechnen und so pseudonyme Zeilen einer Person
zuordnen — **solange der Salt geheim bleibt, ist das ausgeschlossen**.

**Mitigation (mehrschichtig):**

- **Salt getrennt vom DB-Zugriff** halten (nicht in derselben Vertrauenszone wie
  die Datenbank; kein Salt in DB-Backups). Wer die DB liest, hat damit noch nicht
  den Salt.
- **`choice` nie im Audit** — selbst bei Deanonymisierung des Pseudonyms ist das
  konkrete Stimmverhalten nicht aus dem Audit-Log rekonstruierbar.
- **k-Anonymität serverseitig** vor jeder Ergebnisanzeige (kein Klein-n-Leak).
- Salt-**Rotation** deanonymisiert bestehende Stimmen nicht rückwirkend, bricht
  aber die Dedup-Kette — daher NIE auf einem Deployment mit bestehenden Stimmen
  nachträglich ändern (siehe `voter-ref.ts`).

**Bewusst akzeptiertes Restrisiko im Pilot.** Ein mathematisch perfektes,
insider-sicheres Wahlgeheimnis (z. B. rein anonyme Erfassung ohne jede Person-↔-
Wahl-Verknüpfung) würde Dedup/Doppelabgabe-Schutz und die verifizierte
Ergebnis-Qualität erschweren. Für den Pilot ist die salt-getrennte HMAC-Lösung der
tragbare Kompromiss — nicht in Stein: bewährt sich ein stärkeres Verfahren, wird es
übernommen, solange das Wahlgeheimnis nicht schwächer wird.

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
