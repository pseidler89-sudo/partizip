# ADR-020 — Demo-Mandant „Musterstadt" + gestufter Produktiv-Launch

**Status:** umgesetzt (2026-07-10, Gate-B: SHIP) · **Entscheider:** Patrick (Auftrag
„partizip.online als Hauptseite; demo.* als Akquise-Demo; simpel, robust, skalierbar"),
Umsetzungsentscheidungen Projektleiter.

## Entscheidung

1. **EIN Produktions-Stack** (eigener Docker-Compose-Stack, eigene DB/App) bedient
   künftig `partizip.online` (Haupt-Domain → Pilot-Tenant, ADR-015) **und**
   `demo.partizip.online` (Subdomain → Demo-Tenant). Kein separater Demo-Stack,
   kein neuer Routing-Mechanismus — Tenant-Isolation trennt Demo und Echt.
2. **Demo-Mandant = „Musterstadt (Demo)"** (env `DEMO_TENANT_SLUG`), bewusst
   FIKTIV statt Taunusstein-gebrandet: eine öffentliche Demo unter echtem
   Stadtnamen würde Live-Kundschaft suggerieren (Overclaiming) und die Stadt
   ungefragt vereinnahmen.
3. **Ephemere Demo-Session statt Login-Aussetzung:** Der Bauauftrag (Handoff)
   wollte die Login-Pflicht für Stimmungsbilder im Demo-Modus aussetzen — das
   hätte ADR-014 im Voting-Gate aufgeweicht. Stattdessen erzeugt der erste
   Abstimm-Tap auf dem Demo-Mandanten ein gedeckeltes Wegwerf-Konto+Session
   (`lib/demo/actions.ts`); `abstimmen()` bleibt byte-identisch, jede Stimme
   hängt weiter an Konto+Session, verbindlich bleibt Stufe-2-gesperrt.
4. **Gestufter Launch:** (a) Demo hinter Vorschau-Basic-Auth + dauerhaftem
   `X-Robots-Tag: noindex` (Traefik-Middleware) — öffentlich, sobald Impressum/
   Datenschutz final (Vorschau-Middleware entfernen). (b) Haupt-Domain bleibt
   Holding-Page, bis Impressum UND echter SMTP-Versand geklärt sind; erst dann
   Taunusstein-Prod-Tenant seeden + Router umlegen (Launch-Freigabe Patrick).
5. **Nächtlicher Reset** (`scripts/demo-reset.ts`, Cron 03:30) — fail-closed mit
   doppeltem Demo-Marker-Guard (Tenant-Name + deterministische Seed-Poll-ID),
   damit eine Env-Fehlbedienung nie einen echten Mandanten leeren kann
   (Gate-B-MAJOR-Fund, behoben und real getestet).

## Konsequenzen

- Neue Kommune = neuer Tenant (+ ggf. Subdomain-Router) — skaliert ohne Umbau.
- Demo-Konten (`…@demo.invalid`) sind vom Mail-Versand ausgeschlossen (notify-Filter).
- Prod-DB hängt am bestehenden Backup-Cron (backup.sh, Label `prod`).
- Kit/Deck: Roadmap-Punkt „Demo-/Sandbox-Mandant" → GEBAUT (Dateien 02/03/04/06/07/08).
