# ADR-006 — DB-Sessions mit gehashtem Token statt JWT

**Datum:** 2026-06-10 · **Status:** Entschieden (M2) · **Gate B:** erforderlich

**Entscheidung:** Sessions werden als Zeilen in der `sessions`-Tabelle gespeichert
(SHA-256-Hex des Roh-Tokens, nie Klartext). Kein JWT.

**Gründe:** (1) Revozierbarkeit: Logout und Admin-Sperrung wirken sofort — kein
ablaufendes JWT im Umlauf. (2) Einfachheit: kein Signing-Key-Management, keine
JWT-Bibliothek. (3) Tenant-Bindung in der DB erzwungen (`session.tenant_id`
muss Host-Tenant entsprechen — zusätzlich zur host-only-Cookie-Eigenschaft).
(4) host-only Cookie (kein `Domain=`-Attribut): Browser sendet Cookie nur an
die exakte Subdomain, die ihn gesetzt hat. DB-Prüfung als Defense-in-Depth.

**Konsequenzen:** DB-Zugriff bei jeder Session-Validierung (kein stateless JWT);
toleriert wegen kurzer Latenz auf Loopback/LAN zur Postgres-Instanz.
