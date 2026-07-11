# ADR-010 — Anliegen-Tracker: Follower-Tabelle, Creator-Ref-HMAC, Matching-Strategie

**Datum:** 2026-06-10
**Status:** Akzeptiert (M8)

## Kontext

Der Anliegen-Tracker ermöglicht Bürgern, Anliegen einzureichen und öffentlich zu verfolgen.
Zwei Design-Fragen mussten entschieden werden:

1. **Benachrichtigung ohne Klartext-FK am Anliegen** — Ersteller soll benachrichtigt werden,
   ohne dass ein direkter `user_id`-FK auf dem Anliegen liegt (Datensparsamkeit, ADR-005).

2. **Semantisches Matching** — Anliegen gegen RIS-Dokumente abgleichen, ohne externe API.

## Entscheidungen

### Follower-Tabelle statt User-FK

`anliegen_followers(anliegen_id, user_id)` als eigene Tabelle:
- `creator_ref` am Anliegen bleibt HMAC-Pseudonym (kein FK auf users).
- Benachrichtigung läuft über Join auf `users.email` zur Sendezeit (E-Mail nie persistent gespeichert).
- Ersteller wird beim Anlegen automatisch als Follower eingetragen.
- Andere User können künftig ebenfalls Follower werden (erweiterbar).

`creator_ref = HMAC-SHA256(ANLIEGEN_REF_SALT, userId)`:
- Deterministisch: gleicher User → gleicher creator_ref.
- Pseudonym: kein Rückschluss auf userId ohne Salt.
- Salt in Env (ANLIEGEN_REF_SALT), niemals committet.

### Matching: lexikalisch v1, kein LLM

Deterministisches lexikalisches Matching (Jaccard + TF-Gewichtung):
- Keine externe API → kein API-Key-Eskalations-Risiko, keine Abhängigkeit.
- Schwellwert 0.15, max. 5 Kandidaten je Anliegen.
- **Mensch bestätigt immer** — kein automatischer Statuswechsel durch Matching.
- LLM/Embedding als spätere Eskalationsstufe (v2) vorbehalten.

## Konsequenzen

- Follower-Join bei Statuswechsel nötig (E-Mails laden, senden, nicht persistieren).
- anliegen_matches-Tabelle enthält `decided_by/at` — Audit ohne PII.
- Matching-CLI (`anliegen:match`) läuft manuell oder als Cron; Ergebnisse sind vorgeschlagen.
