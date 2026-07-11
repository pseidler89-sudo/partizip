# OParl-Adapter: Gremium umschalten

## Was ist OParl?

OParl (https://oparl.org/) ist ein offener Standard für kommunale Ratsinformationssysteme (RIS). Er definiert eine JSON-API, über die Sitzungsdaten — Termine, Tagesordnungen, Beschlüsse, Protokolle und Dokumente — maschinenlesbar abgerufen werden können. OParl wird von verschiedenen RIS-Anbietern (ALLRIS, SD.NET, SessionNet u.a.) als optionales Modul angeboten und ermöglicht eine deutlich zuverlässigere Datenabfrage als HTML-Scraping.

## Gremium auf OParl umschalten

Wenn ein RIS-Gremium eine OParl-Schnittstelle aktiviert hat, kann der Partizip-Import auf den OParl-Adapter umgestellt werden. Dazu genügt eine SQL-Anweisung in der Produktivdatenbank:

```sql
UPDATE ris_bodies
SET
  ris_type = 'oparl',
  base_url = '<OParl-Body-URL>'
WHERE key = '<gremium-key>';
```

**Beispiel:**

```sql
UPDATE ris_bodies
SET
  ris_type = 'oparl',
  base_url = 'https://oparl.taunusstein.de/api/body/1'
WHERE key = 'taunusstein-stadt';
```

Danach läuft der Import normal:

```bash
npm run ris:import -- --body taunusstein-stadt
```

## OParl-Body-URL herausfinden

Die Body-URL ist der Einstiegspunkt der OParl-API. Sie lässt sich wie folgt ermitteln:

1. Das RIS-System der Kommune aufrufen (z.B. https://www.taunusstein.de/allris/).
2. In der RIS-Oberfläche oder im Impressum nach einem OParl- oder API-Link suchen.
3. Alternativ: die Systeminformationsseite aufrufen. Bei ALLRIS findet sich oft ein Link unter `/oparl/v1.0/system` oder `/oparl/system`. Das System-Objekt enthält dann eine `body`-Liste mit den Body-URLs.

Beispiel System-Objekt:
```json
{
  "id": "https://oparl.beispiel.de/api/",
  "type": "https://schema.oparl.org/1.1/System",
  "body": "https://oparl.beispiel.de/api/body/"
}
```

Das erste Objekt in der Body-Liste ist in der Regel das gesuchte Gremium.

## Hinweise

- Der OParl-Adapter ist vollständig in `app/src/lib/ris/oparl.ts` implementiert und verhält sich wie die anderen Adapter (Provox, ALLRIS).
- Nach dem Umschalten läuft `npm run ris:import` wie gewohnt — keine weiteren Konfigurationsänderungen nötig.
- Falls die OParl-API nicht erreichbar ist oder Fehler zurückgibt, erzeugt der Import aussagekräftige Fehlermeldungen; einzelne fehlerhafte Dokumente werden übersprungen ohne den Gesamtimport abzubrechen.
- Zurückschalten auf den alten Adapter: `UPDATE ris_bodies SET ris_type = 'allris4' WHERE key = '...'`

## Seitenlimit (Paginierung)

Der OParl-Adapter paginiert die Sitzungsliste bis zu **5 Seiten** (Standard). Für sehr große Gremien kann das Limit per Umgebungsvariable erhöht werden:

```bash
OPARL_MAX_PAGES=20 npm run ris:import -- --body taunusstein-stadt
```

Oder dauerhaft in der `.env`-Datei setzen:

```
OPARL_MAX_PAGES=20
```
