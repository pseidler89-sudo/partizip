# ADR-002 — Vollständig self-hosted Stack (entschieden)

**Datum:** 2026-06-10 · **Status:** Entschieden (Owner, Konzept v2.0 Kap. 3) · **Ersetzt:** ADR-001 (Planning-Stand) im Punkt Hosting/Auth

**Entscheidung:** Kein Supabase, kein externer Auth-Dienst. PostgreSQL in
Docker auf eigener Hetzner-VM; eigene Magic-Link-Auth (signierte, kurzlebige
Tokens, TTL 15 min, Single-Use, httpOnly-Session); SMTP via Env; Reverse-Proxy
mit TLS auf der VM.

**Gründe:** (1) B2G-Verkaufsargument: Betrieb vollständig auf deutschem Server,
kurze AVV-Kette für kommunale Datenschutzbeauftragte. (2) Bestandsschutz
vorhandenen self-hosted Codes. (3) Infrastruktur-Kontrolle (Hetzner/Docker).
(4) Risiko der Eigen-Auth beherrschbar durch Härtung + Gate B.

**Konsequenzen (P0, im Backlog):** getesteter Backup- **und** geprobter
Restore-Prozess für Postgres; VM-Härtung (Firewall, SSH, separater
Service-User, Updates). Eigen-Auth-Code unterliegt ausnahmslos Gate B
(Second-Agent-Review).
