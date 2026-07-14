# ADR-025 — Beteiligungsformate: über Ja/Nein hinaus, aggregatbasiert und barrierearm

**Status:** Akzeptiert · **Datum:** 2026-07-14 · **Entscheidung:** Owner (Patrick)
**Bezug:** Baut auf dem Abstimm-Verifikationsmodell (ADR-014), der
Mitmachen-zuerst-Ausrichtung (ADR-013) und dem Wahlgeheimnis-/k-Anonymitäts-Fundament
(ADR-022, `docs/architecture/K_ANONYMITY.md`, `VOTE_PRIVACY.md`) auf.

## Kontext

Die Plattform kennt bislang die binäre Ja/Nein-Abstimmung. Für echte kommunale
Beteiligung ist das oft zu grob: Bürger wollen **priorisieren** („welche drei
Projekte zuerst?"), **Zustimmung abstufen** („ich kann damit leben" vs. „auf
keinen Fall") und **Argumente statt nur Optionen** gewichten. Social-Media-Formate
(Umfragen, Reaktionen, Ranglisten) zeigen, dass ausdrucksstärkere Mechaniken die
Beteiligung erhöhen — sie tragen aber eine Werte-Logik (Sieg, Profil, Empörung),
die unserer Anti-Empörungs-Positionierung widerspricht.

## Entscheidung

Wir ergänzen Ja/Nein um **aggregatbasierte, ausdrucksstärkere Formate** in dieser
Priorität:

1. **Dot-/Budget-Voting** (zuerst): Teilnehmende verteilen eine feste Zahl von
   Punkten bzw. ein fiktives Budget auf mehrere Optionen. Ergebnis ist eine
   Prioritätenverteilung, kein Einzelsieger. Barrierearm über Zähl-Stepper /
   Eingabefelder — **kein Drag&Drop**.
2. **Widerstandsabfrage / Systemisches Konsensieren** (danach): pro Option ein
   Widerstandswert 0–10 („keine Einwände" bis „maximaler Widerstand"). Ausgewertet
   wird die Option mit dem **geringsten Gesamtwiderstand** — Konsens statt
   Mehrheitssieg. Erfasst über beschriftete Slider/Radiogruppen mit
   Tastaturbedienung.
3. **Statement-Voting im Polis-Stil** (später): Teilnehmende bewerten kurze
   Aussagen mit Zustimmung/Ablehnung/Enthaltung; das System findet
   Konsens-Statements und Meinungsgruppen. Größter Umfang, daher hinten
   eingeplant.

### Bewusst NICHT

**Tier-Lists und Brackets/Turnier-Duelle für Sachthemen** werden nicht gebaut:

- **k-Anonymität:** Eine vollständige individuelle Rangfolge über viele Elemente
  ist ein nahezu eindeutiger Fingerabdruck — sie bricht die k-Anonymität, die
  das Wahlgeheimnis schützt (ADR-022, `K_ANONYMITY.md`).
- **Barrierefreiheit:** Die typische Drag&Drop-Interaktion verletzt WCAG 2.2
  (Tastatur, Motorik, Screenreader).
- **Positionierung:** Bracket-„Duelle" kippen in Empörungs- und
  Gewinner-Verlierer-Gamification — direkter Widerspruch zur
  Anti-Empörungs-Ausrichtung der Plattform.

### Leitprinzip

**Interaktions-Mechanik der Social-Formate, Werte-Logik der Civic-Tech-Verfahren.**
Konkret:

- **Aggregat statt Profil:** Ausgewertet und gezeigt wird die Verteilung, nie das
  individuelle Muster.
- **Konsens statt Sieg:** Formate bevorzugen tragfähige, breit akzeptierte
  Optionen gegenüber knappen Mehrheiten.
- **1 Person = 1 Stimme:** kein Gewichten durch Reichweite, Lautstärke oder
  Mehrfachbeteiligung.
- **Mindest-N vor Ergebnis:** Ergebnisse werden erst ab einer Mindestzahl
  Teilnehmender angezeigt (k-Anonymitätsschwelle, ADR-022).
- **Barrierearm ohne Drag&Drop:** jedes Format ist per Tastatur, Screenreader
  und mit einfacher Motorik bedienbar.

## Konsequenzen

- **Datenmodell:** `polls` bekommt einen Format-Typ; die Stimmenerfassung muss
  Punkte-/Widerstands-/Statement-Werte tragen, ohne das anonyme
  HMAC-Pseudonym-Schema (ADR-022) aufzuweichen. Aggregation und
  Mindest-N-Schwelle gelten je Format.
- **Reihenfolge des Baus:** Dot-/Budget-Voting zuerst (kleinster Schnitt, größter
  Nutzen), dann Widerstandsabfrage, Statement-Voting später als eigenes
  Vorhaben.
- **Barrierefreiheit ist Abnahmekriterium**, kein Nachgedanke
  (`docs/architecture/ACCESSIBILITY.md`): kein Format ohne
  tastatur-/screenreaderfähige Bedienung.
- Tier-Lists/Brackets sind für Sachentscheidungen dauerhaft ausgeschlossen; eine
  spätere spielerische Nutzung außerhalb verbindlicher Beteiligung wäre eine
  eigene, neu zu begründende Entscheidung.
- Nichts in Stein — bewährt sich ein Format nicht, wird es geändert.
