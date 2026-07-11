# ADR-008 — Auth-Daten-Retention

**Status:** Accepted · **Datum:** 2026-06-10

## Kontext

Auth-Tabellen (auth_tokens, sessions, rate_limit_events) wachsen ohne Bereinigung unbegrenzt.
Zweckbindung (DSGVO Art. 5 Abs. 1 lit. e) erfordert Löschung sobald Daten nicht mehr benötigt werden.

## Entscheidung

| Tabelle              | Frist                                     | Begründung                          |
|----------------------|-------------------------------------------|-------------------------------------|
| auth_tokens          | consumed oder expired > 24h               | Token nach Einlösung/Ablauf wertlos |
| sessions             | expired oder revoked > 30 Tage            | Audit-Puffer für Sicherheitsvorfälle |
| rate_limit_events    | > 24h                                     | Nur für 15-min-Fenster benötigt     |

Bereinigung über `npm run db:cleanup` (scripts/cleanup-auth.ts).
Keine PII in Logs — nur Zähler.

## Ausführung

Als Cron-Job beim Deployment einrichten (Betriebsaufgabe, P0).
Interim: manuell nach Bedarf.
