# ADR-029 — Poll-Erstellung an Gebiets-Autorität gebunden; Bund/Land = Separate-Tenant-Modell

**Status:** Akzeptiert · **Datum:** 2026-07-18 · **Entscheidung:** Owner (Patrick)
**Bezug:** Baut auf ADR-024 (Gebiets-/Sichtbarkeitsmodell, `regions`/ltree) auf und
spiegelt die QR-Gebietsbindung aus Block K1 (`qr-core.ts`). Umsetzung: Block H
(`lib/polls/composer-autoritaet.ts`, Durchsetzung in `lib/polls/actions.ts`).

> Hinweis: ADR-028 ist für den KI-Neutralitäts-Check reserviert (Onboarding-Spec,
> noch nicht in diesem Repo verfasst) — daher trägt diese Entscheidung 029.

## Kontext

`pollErstellen` gated bisher nur über `requireAdminCtx()` → „irgendein Admin des
Tenants" und **verwarf die Rollen-Gebiete**. Das zod-Feld `scopeLevel` akzeptiert
`ortsteil|stadt|kreis|land`, und `resolveRegionIdForScope` löst jeden Scope
tenant-intern ohne Autoritäts-Check auf. Folge: ein präparierter Request eines
beliebigen Tenant-Admins konnte kreis-/land-Polls anlegen (bestehende Lücke). Der
Composer bot `scopeLevel` hartkodiert an, nicht aus der Autorität abgeleitet.

## Entscheidung

1. **Autorität = vertikale Scheibe ABWÄRTS von der eigenen `roles.region_id`**
   (ltree-`@>` via `pfadDecktAb`). Ein kommune_admin mit Gemeinde-Anker darf Polls
   auf `stadt` (Gemeinde-Knoten) und dessen Ortsteile erstellen — **nicht** kreis/
   land/bund. Anker aus `getUserRolesMitScope` (nicht „Admin = immer Gemeinde"):
   ein per super_admin auf einen Ortsteil gesetzter Admin ist nur dort berechtigt.
2. **super_admin bypasst** die Gebietsbindung (Plattform-Betreiber/Eskalation).
3. **Durchsetzung serverseitig** in `pollErstellen` **und symmetrisch** in
   `pollAktivieren`/`pollSchliessen`/`pollEntwurfLoeschen` (gegen `poll.region_id`).
   Die UI ist nur Komfort: der Composer-Picker wird server-getrieben aus
   `erlaubteZielGebiete` gespeist (Gemeinde + berechtigte Ortsteile, nie kreis/land).
4. **Bund/Land bleibt dem Separate-Tenant-Modell** (PR #49) vorbehalten und wird in
   H bewusst **nicht** erstellbar. kreis-/land-Knoten tragen `tenant_id=NULL`; die
   Tenant-Bindung steckt in der Gemeinde-Verankerung, nicht in einem
   `regions.tenant_id`-Filter.

## Konsequenzen

- Die bestehende Lücke ist geschlossen: kreis/land per direktem Action-Aufweis wird
  abgelehnt (`poll.create_denied`, PII-frei auditiert).
- **Bestandsdaten:** die bereits `aktiv` geseedeten kreis-/land-Polls (`polls.json`)
  bleiben unberührt (kein Action-Pfad). Ein an die Gemeinde gebundener Admin kann
  sie danach jedoch **nicht** schließen — das ist die gewollte Grenze (kreis/land ≠
  Gemeinde-Autorität). super_admin bleibt unbeschränkt, falls das im Pilot stört.
- Keine Migration (nutzt vorhandene `polls.region_id`/`roles.region_id`/`getNachfahren`).
