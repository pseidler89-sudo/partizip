# ADR-015 — Pilot-Domänenmodell & Standort-/Regions-Einstieg

**Status:** akzeptiert · **Datum:** 2026-06-14 · **Entscheidung:** Patrick
**Bezug:** ADR-013 (Mitmachen zuerst), ADR-014 (Stufe-1/QR). Ergänzt/verfeinert die
Front-Door. Revidiert die Annahme „Subdomain pro Kommune ist der primäre Bürger-Einstieg".

## Kontext
Jemandem zu sagen „tippe `taunusstein.partizip.online`" ist für die Masse Reibung.
Die App ist host-basiert multi-tenant (Subdomain → Tenant, isoliert, Gate-B-geprüft).
Für den Pilot mit **einer** Kommune ist das overkill als Einstieg.

## Entscheidung
1. **Pilot läuft SINGLE-DOMAIN** (`partizip.online`). Der Bürger gibt seine **PLZ
   ein bzw. gibt den Standort frei** → wird seiner Region zugeordnet und sieht
   **alle Abstimmungen, an denen er teilnehmen kann, klar nach Ebene
   gekennzeichnet**: Ortsteil ⊂ Stadt/Kommune ⊂ Kreis ⊂ Land. Die Wahl wird
   **gemerkt** (Cookie), „Region ändern" jederzeit möglich. Lesen + Ergebnis ohne
   Konto; Mitstimmen ab Stufe 1 (ADR-014).
2. **Subdomains pro Kommune bleiben technisch erhalten** (host-basierte Tenancy,
   bereits gebaut — Isolation, Branding, Teilen/QR), werden im Pilot aber **nicht**
   als primärer Bürger-Einstieg genutzt. Der Ausbau auf Subdomains ist ein
   eigener **Roadmap-Punkt „Skalierung"**, zu klären, sobald Anklang/Traktion da ist.
3. **Struktur export-/importierbar halten:** alles bleibt sauber tenant-scoped,
   PLZ→Region als **portable Mapping-Tabelle** (`plz_regionen`), damit sich eine
   Kommune später leicht herauslösen/einspielen lässt (Voraussetzung für die
   Subdomain-Skalierung).

## Begründung
- Niedrigste Reibung für die Masse: eine Domain, PLZ statt Subdomain-Tippen.
- Die nach Ebene gekennzeichnete Sicht macht „was betrifft *mich*" sofort klar und
  nutzt das bereits gebaute Stufenmodell (`scope_level`).
- Host-Tenancy nicht wegwerfen: Isolation + Skalierungs-Option bleiben erhalten,
  ohne den Pilot zu verkomplizieren.

## Konsequenzen
- **Bauen jetzt:** Regions-/PLZ-Einstieg + Cookie-Persistenz; `plz_regionen`-Mapping
  (Pilot: Taunusstein-PLZ); nested-scope-Ansicht (Polls gruppiert/gelabelt nach
  Ortsteil/Stadt/Kreis/Land) auf Landing + `/umfragen`; anonyme Personalisierung
  über das Region-Cookie (für Ortsteil-Ebene), Stadt/Kreis/Land tenant-weit.
- **Launch/Deploy (später, Eskalation Außen/DNS):** produktiv `partizip.online`
  → Pilot-Tenant statt Holding-Page (Traefik).
- **Skalierungs-Roadmap (später):** Tenant-Export/Import; Kreis-/Land-Aggregation
  ÜBER mehrere Kommunen-Tenants; Subdomain-Erweiterung.
- Nichts in Stein — bewährt sich etwas nicht, wird geändert.
