# ADR-011 — KI ist optional: Kernfunktion ohne KI, Zuschaltung per Schlüssel

**Status:** Accepted · **Datum:** 2026-06-11 · **Entscheider:** Patrick
(Product Owner, Antworten #5 und #10 vom 2026-06-11)

## Kontext

ADR-009 ließ den LLM-Digest-Generator als Stub offen (Eskalation:
API-Key-Entscheidung). Patrick hat entschieden: beides, umschaltbar —
„Key vorhanden → eintragen, Key nicht vorhanden → eigene Lösung", und als
Grundsatz: KI gering halten, Kosten sparen, „im Zweifel muss es auch ohne
KI funktionieren, mit der Option für sinnvolle Integration".

## Entscheidung

1. **Kein Feature der Plattform darf KI voraussetzen.** Der deterministische
   `extractive_v1`-Generator bleibt vollwertiger Standard; Anliegen-Matching
   bleibt lexikalisch mit menschlicher Bestätigung. KI ist Komfort, nie
   Voraussetzung.
2. **Generator-Auswahl per Umgebungsvariable** (`DIGEST_GENERATOR`:
   `auto` | `extractive_v1` | `llm_v2`, Default `auto`):
   `auto` wählt `llm_v2` genau dann, wenn `ANTHROPIC_API_KEY` gesetzt ist,
   sonst `extractive_v1`. Key entfernen = KI vollständig aus, ohne
   Code-Änderung.
3. **Laufzeit-Fallback:** Scheitert `llm_v2` (API nicht erreichbar,
   Validierungsfehler), wird automatisch `extractive_v1` verwendet; das
   persistierte `generator`-Feld nennt immer den tatsächlichen Erzeuger.
4. **Vertrauensregeln gelten für KI unverändert:** Quellen-Mapping je
   Aussage ist Pflicht (`sourceDocumentId` muss auf ein übergebenes
   Dokument zeigen, URLs werden NIE aus LLM-Output übernommen, sondern
   serverseitig abgeleitet); menschliche Freigabe vor jeder
   Veröffentlichung bleibt hartes Gate (DB-Constraint, unverändert).
5. **Kostendeckel:** Standardmodell ist das günstigste geeignete
   (claude-haiku-Klasse, `DIGEST_LLM_MODEL` überschreibbar),
   Token-Obergrenze pro Aufruf (`DIGEST_LLM_MAX_TOKENS`), Dokumenttexte
   werden gekürzt übergeben. KI wird nur bei expliziter Digest-Generierung
   aufgerufen — nie automatisch im Hintergrund, kein KI-Einsatz pro
   Seitenaufruf.
6. **Datenschutz-Leitplanke:** An die LLM-API werden ausschließlich Texte
   öffentlicher Ratsdokumente übermittelt — niemals Nutzerdaten, Anliegen
   oder E-Mail-Adressen. (Datenschutzerklärung Ziff. 9 enthält den
   passenden Baustein, nur bei Aktivierung zu veröffentlichen.)

## Drei Betriebsmodi

**Datum:** 2026-06-11 · **Entscheider:** Patrick (Antworten #3 und #9)

Im Pilot werden drei Betriebsmodi unterschieden:

**(1) `extractive_v1` — deterministisch, Default ohne Key**
Regelbasierte Extraktion aus Sitzungsdokumenten. Keine KI, keine API-Kosten.
Wird automatisch verwendet wenn `ANTHROPIC_API_KEY` nicht gesetzt ist
(`DIGEST_GENERATOR=auto` oder `DIGEST_GENERATOR=extractive_v1`).

**(2) `assisted_v1` — Pilot-Standard: Claude Code auf der VM, auf Zuruf**
Patrick sagt Claude Code: „Mach den Digest für Sitzung X." Claude Code führt
`digest:export` aus (lädt Dokumente als JSON-Bundle), formuliert bürgerfreundliche
Aussagen, und `digest:import-draft` validiert sie mit denselben harten Regeln
wie `llm_v2` (gemeinsames `validate-draft`-Modul). Der Digest-Entwurf liegt zur
Freigabe im Admin-UI bereit.

Vorteile: **keine API-Token-Kosten** (läuft über das bestehende Claude-Code-Abo),
menschliche Bearbeitung und Freigabe sind inhärent, identische Sicherheitsregeln
(sourceDocumentId-Validierung, server-seitige URL-Ableitung, kein Wicket-URL in
Statements). Generator-Feld: `"assisted_v1"`.

**(3) `llm_v2` — vollautomatischer Entwurf per API-Key, optional später**
Anthropic Messages API; erfordert `ANTHROPIC_API_KEY`. Identische Validierung
via `validate-draft`-Modul. Generator-Feld: `"llm_v2"`. Für den Pilot nicht
aktiv (Kosten), kann später per Key-Eintrag zugeschaltet werden.

## Konsequenzen

- Patrick kann KI jederzeit ein-/ausschalten: API-Key in `.env` eintragen
  oder Zeile leeren, fertig.
- Betriebskosten ohne Key: 0 €. Mit Key: nur pro erzeugtem Digest-Entwurf,
  gedeckelt.
- Abgrenzung nach außen („funktioniert komplett ohne KI, KI nur als
  geprüfter Entwurfs-Assistent") ist zugleich Verkaufsargument gegenüber
  Kommunen (EU-KI-VO-unkritisch, keine automatisierten Entscheidungen).
