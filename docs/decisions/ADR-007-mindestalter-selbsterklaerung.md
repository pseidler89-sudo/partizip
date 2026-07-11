# ADR-007 — Mindestalter-Selbsterklärung als min_age_confirmed_at

**Datum:** 2026-06-10 · **Status:** Entschieden (M2) · **Review:** rechtlich ausstehend

**Entscheidung:** Beim Erstregistrierungsflow speichert die Plattform den
Zeitstempel der Selbstauskunft „Ich bin mindestens 16 Jahre alt" als
`users.min_age_confirmed_at` (Konzept Kap. 10.5). Kein Boolean — der
Zeitstempel ermöglicht datenschutzrechtliche Nachweisführung ohne weitere PII.

**Gründe:** (1) Kommunale Beteiligungsplattform, keine öffentliche Abstimmung
mit rechtlicher Bindewirkung → Selbstauskunft ausreichend für Pilotbetrieb.
(2) Zeitstempel als Nachweis der Zustimmungserklärung (Privacy-Design).
(3) Kein Geburtsdatums-Zwang bei Erstregistrierung — datensparsamst.

**Durchsetzung (N3, 2026-06-13):** Das Mindestalter wird an ZWEI Stellen
erzwungen, nicht nur erfasst:
1. **Registrierung** (`/api/auth/request`): Ein Konto wird nur angelegt, wenn
   `minAgeConfirmed === true` übergeben wird; ohne Bestätigung → Hinweis-Mail,
   kein Konto. Die Bestätigung wird PII-frei auditiert (`registration:true,
   minAgeConfirmed:true`).
2. **Eligibility-Schicht** (`getStufe`): Ohne gesetztes `min_age_confirmed_at`
   bleibt ein Konto auf **Stufe 0** (nur Lesen) — Defense-in-Depth gegen Konten,
   die über andere Pfade (Seed, künftiger Admin-Override) ohne Bestätigung
   entstehen könnten. Erst mit Bestätigung ist Stufe ≥1 (Anliegen/Teilnahme).

**Offene Punkte (P0-5):**
- Rechtliche Feinabstimmung mit Datenschutzerklärung (Datenschutzbeauftragter)
- Altersklausel in AGB/Nutzungsbedingungen verankern
- Playwright-E2E-Tests folgen mit erstem öffentlichen UI-Meilenstein (M7/M8)
