# ADR-028 — KI-Neutralitäts-Check (L1 assisted): öffentlicher Prompt, hält an statt abzulehnen

**Status:** Akzeptiert · **Datum:** 2026-07-18 · **Entscheidung:** Owner (Patrick)
**Bezug:** Baut auf ADR-011 (KI optional, Modus `assisted_v1`), ADR-027 (KI-Souveränität,
lokale/pluggbare Provider) und dem Pitch-Baustein „KI-Propaganda-Gegenmodell" auf.
Quelle: ONBOARDING_VERTRAUEN_GOVERNANCE.md §6 + §11. Umsetzung: Block L
(`lib/ki/neutralitaet-prompt.ts`, `lib/polls/pruefung-core.ts`, Durchsetzung in
`lib/polls/actions.ts`, Transparenz-Log `ki_pruefungen`).

## Kontext

Umfragen gehen heute mit `pollAktivieren` direkt live (entwurf → aktiv). Für das
Vertrauensprodukt fehlt eine überparteiliche Leitplanke gegen suggestive oder
verzerrt gerahmte Fragestellungen — ohne dabei in Zensur zu kippen. Eine
vollautomatische KI-Ablehnung wäre weder DSGVO-/EU-KI-VO-unkritisch (automatisierte
Entscheidung) noch mit dem Grundsatz „Mensch entscheidet" vereinbar (ADR-011 §4,
Datenschutz Ziff. 14). L1 ist bewusst **assisted** (kein API-Key): Betreiber + Claude
Code auf der VM bewerten nach einem öffentlichen Prompt; die L2-Automation (eigener
Key / lokales LLM) folgt später.

## Entscheidung

1. **Flag je Tenant, Default AUS** (`tenants.ki_neutralitaets_pflicht`, Vorbild
   `vier_augen_pflicht`). Nur wenn AN, greift das Gate. Prod-Tenants (taunusstein, demo)
   bleiben AUS; Einschalten ist eine bewusste Owner-Entscheidung + separate Aktivierung.
2. **Neuer Status-Wert `in_pruefung`** in `poll_status` (additiv, `ADD VALUE`). Bei
   aktivem Flag setzt `pollAktivieren` die Umfrage auf `in_pruefung` statt `aktiv`
   (Audit `poll.submitted_for_review`, KEINE Benachrichtigung). Alle Wähler-Guards
   filtern hart `status='aktiv'` → `in_pruefung` ist automatisch fail-closed
   unsichtbar/unwählbar (kein Reader muss verschärft werden).
3. **Öffentlicher, versionierter Prompt** (`lib/ki/neutralitaet-prompt.ts`,
   `NEUTRALITAETS_PROMPT` + `PROMPT_VERSION` + `PROMPT_MODELL`) ist QUELLE UND ANZEIGE:
   er wird beim Prüfen wörtlich verwendet UND im Transparenz-Log im Volltext gerendert.
   Er prüft auf Suggestivität, einseitige Rahmung, unterstellende Prämissen, wertende
   Wortwahl, Partei-/Personen-Parteinahme und verzerrte Antwortoptionen. **Im Zweifel
   zulassen** — die Plattform zensiert nicht.
4. **Antwortform hart begrenzt:** Verdict (`neutral` | `angehalten`) + max. 2 Sätze
   Begründung + (bei angehalten) die verletzte Regel. **KEINE Umformulierungsvorschläge**
   (Token-Sparsamkeit + keine Bevormundung des Erstellers).
5. **Die KI lehnt NIE final ab — sie hält an.** `angehalten` setzt die Umfrage zurück
   auf `entwurf` (kein terminaler „abgelehnt"-Status); der Ersteller sieht die Begründung,
   passt an und reicht erneut ein — ODER ein zweiter Admin gibt sie per Override frei.
6. **Vier-Augen an der Freigabe** (neutral → aktiv): Prüfer ≠ Ersteller, atomar im
   CAS-`WHERE` verankert. Im Pilot per `ALLOW_SELF_APPROVAL=true` überbrückbar (fail-closed,
   Muster `isSelfApprovalAllowed`); der Override bleibt eine auditierte Handlung
   (`ist_override`). „Anhalten" darf jeder Admin (konservativ, kein SoD).
7. **Öffentliches Transparenz-Log** (`ki_pruefungen`, gerendert auf `/transparenz`):
   Verdict, Begründung, verletzte Regel, Promptversion + Modell, Zeitpunkt —
   **PII-frei**: kein `geprueft_von`/`erstellt_von`, keine Person (Institutionsebene).
   Der **Frage-Wortlaut wird bei `angehalten` bewusst NICHT publiziert**: eine
   angehaltene Frage bleibt `entwurf` und war nie öffentlich sichtbar; das Log darf
   ihren (evtl. diffamierenden oder Dritte nennenden) Wortlaut nicht der einzige
   Publikationsort werden lassen — angezeigt werden nur Verdict/Regel/Begründung.
   Bei `neutral` wird der Wortlaut gezeigt (die Umfrage ging ohnehin live).
   **Manipulationssicher:** das Log speichert einen `frage_snapshot` (Wortlaut zum
   Prüfzeitpunkt, Betreiber-/Institutions-Inhalt, kein Wähler-PII) statt eines
   Poll-Joins, und `poll_id` ist `ON DELETE SET NULL` — löscht der Betreiber den
   zurückgestellten Entwurf, bleibt der öffentliche „angehalten"-Nachweis erhalten.
8. **Kein Datenexport an Dritte** (L1 assisted): nur der öffentliche Umfrage-Text wird
   bewertet, keine Nutzerdaten; kein neuer Cookie. Datenschutz-Absatz nur bei aktivem Flag.
9. **L2 später** (ADR-027): Automatisierung erst mit eigenem Key / lokalem LLM und erst
   mit Fremd-Instanzen; die assisted L1-Betriebsart bleibt der Pilot-Standard.

## Konsequenzen

- Flag AUS = heutiger Weg exakt unverändert (Regressionsschutz per Test): direkte
  Aktivierung + Benachrichtigung. Kein Verhaltenswechsel in Prod ohne bewusstes
  Einschalten.
- Der Aktivierungs-Nebeneffekt (Benachrichtigung) zieht bei aktivem Flag von
  `pollAktivieren` auf die echte Freigabe (`pollPruefungAbschliessen`, verdict=neutral) um.
- EU-KI-VO-/DSGVO-Abgrenzung bleibt sauber: keine automatisierte Entscheidung, der
  Mensch gibt frei/hält an; die KI ist assistierender Maßstab, kein Richter.
- Migration 0035 (additiv): Enum-Wert `in_pruefung`, `tenants.ki_neutralitaets_pflicht`,
  Tabelle `ki_pruefungen` (mit `frage_snapshot`, `poll_id` nullable / `ON DELETE SET NULL`).
  Kein App-Stopp nötig (neuer Enum-Wert wird von Alt-Code nie gelesen).
