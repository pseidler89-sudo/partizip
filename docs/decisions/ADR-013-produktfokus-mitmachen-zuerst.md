# ADR-013 — Produkt-Fokus: Mitmachen (lokale Umfragen) als Front-Door

**Status:** akzeptiert · **Datum:** 2026-06-13 · **Entscheidung:** Patrick (Product Lead)
**Bezug:** Konzept Kap. 1 (Mission: „nachweisbares Zuhören bei minimaler Reibung"),
Kap. 5 (Verifikationsstufenmodell), M3/M5/M6 (Voting). Nichts ist in Stein
gemeißelt — bewährt sich etwas nicht oder hält Challenges nicht stand, wird es geändert.

## Kontext / Problem

Die bisherige Front-Door war das **Transparenz-/Digest-Produkt** („geprüfte
Zusammenfassungen von Ratssitzungen"). Das ist **Information = Bringschuld** und
spricht nur die ohnehin schon Engagierten an → „Behörden-Anmutung", holt die
Masse nicht ab. Ziel ist aber **Massen-Beteiligung** plus **Multiplikatoren**
(Rathaus/Ortsbeirat/Kreis), die ein **überparteiliches** Werkzeug freiwillig
verbreiten.

Kernfehler im alten Framing: Die Seite bot etwas zum **Lesen** an, statt etwas
zum **Tun**. „Tante Erna" will man nicht informieren, sondern **fragen**: Eine
Frage verleiht Bedeutung („deine Meinung wird gebraucht"), Information lädt Arbeit
ab („lies dich ein").

## Entscheidung — neue Fokus-Reihenfolge

1. **Mitmachen (Bürger wird gefragt) — die Haustür.** Lokale Umfrage/
   Stimmungsbild: Ort wählen (oder automatisch) → echte lebende Frage für
   Ort/Stadt/Kreis sehen → in <30 s antworten → sofort Ergebnis + sozialer Beweis
   („so denkt deine Nachbarschaft, X haben mitgemacht") → **erst danach** optional
   „Bescheid bekommen?". Account-Erstellung so spät wie möglich. Headline führt
   mit der lokalen Frage + sozialem Beweis, **nicht** mit „überparteilich/
   quellengebunden" (das ist Eigenschaft, kein Versprechen — Kleingedrucktes).
2. **Multiplikatoren — der Wachstumsmotor.** Gescoptes Fragen-Erstellen über das
   **Stufenmodell**: Ortsbeirat → Ortsteil, Stadtverwaltung → Stadt (inkl. ihrer
   Ortsteile), Kreis → Landkreis. Das ist der Vertriebskanal **und** die
   Bedingung dafür, dass Punkt 1 sich folgenreich anfühlt (eine echte Institution
   fragt und sieht das Ergebnis).
3. **Verständliche Ratsarbeit (Digests) — Tiefen-/Glaubwürdigkeitsschicht.**
   Erreichbar, aber nicht Front. Für Pilot-Kommunen **human-seeded** (Mensch im
   Loop), die teure Extraktions-Pipeline **zuletzt**.

**Anliegen-Schreiben** durch Bürger bleibt, rückt im Reiz-Ranking aber bewusst
**hinter** die einfache Antwort-Schleife (Ventil für bereits Engagierte, kein
Masse-Einstieg).

## Begründung

- **Interdependenz von 1 und 2:** „Klick hier, sag deine Meinung" läuft ins
  Leere, wenn am anderen Ende keine echte Institution sitzt. Darum: Bürger ist die
  Frontseite, aber der **Bau beginnt mit der Institutions-/Multiplikator-Pipeline**.
- **Überparteilichkeit ist Voraussetzung**, nicht Detail: Eine Verwaltung adoptiert
  nie ein Parteiwerkzeug. Der Multiplikator-Kanal existiert nur, weil neutral.
- **Reiz von früher bleibt** („geh wieder auf die Seite — ist deine Meinung
  gefragt?") und funktioniert überparteilich besser (riecht nicht nach Wahlkampf).
- **Das Rückgrat existiert schon:** `scope_level` (ortsteil/stadt/kreis/land) +
  gescopte `roles` sind im Schema; M3/M5/M6 sind in Konzept + BACKLOG bereits
  spezifiziert. Der Pivot ist überwiegend **Vorziehen + Umrahmen**, kein Neubau.

## Konsequenzen

- **Re-Sequencing:** M3 (Voting/Umfragen), M5 (Composer), M6 (Ergebnis/k-Anonymität)
  von Phase 2 nach **vorn (P1, Front-Door)**. M7-Digests von Front-Door zu
  Tiefenschicht. Landing wird neu gebaut (führt mit lebender lokaler Frage).
- **Build-Order de-risking:** Mitmach-Loop zuerst beweisen, Pilot-Digests
  human-seeded, Extraktions-Automatik zuletzt — der größte technische Aufwand wird
  nicht verbrannt, bevor das Kernversprechen trägt.
- **Offen (beim M3-Bau zu entscheiden):** Eligibility-/Reibungsmodell —
  niedrigschwelliges, unverbindliches **Stimmungsbild** (Masse) vs. **verifiziert/
  verbindlich** (Stufe 2). Empfehlung: gestuft (niedrigschwellig als Default,
  „verbindlich" als Aufsatz über das Stufenmodell; Ergebnis zeigt beide Signale).
- Bestehende Governance-Arbeit (Auth, Rollen/Audit, DSGVO, Anliegen-Härtung)
  bleibt gültig und trägt den neuen Fokus.
