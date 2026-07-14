# ADR-024 — Gebiets- und Sichtbarkeitsmodell: hierarchischer Gebietsbaum (AGS/ARS)

**Status:** Akzeptiert · **Datum:** 2026-07-14 · **Entscheidung:** Owner (Patrick)
**Bezug:** Ersetzt das feste `scope_level`-Enum aus ADR-015; verfeinert die
Regions-/PLZ-Front-Door (ADR-015), das Verifikationsmodell (ADR-014) und die
Abstimm-Roadmap (ADR-016). Design-Grundlage: `docs/architecture/GEBIETSMODELL.md`.

## Kontext

Das heutige Modell kennt genau vier feste Ebenen (`scopeLevelEnum` =
`ortsteil`/`stadt`/`kreis`/`land`). `polls`, `roles` und `qr_codes` tragen
`scope_level` + `scope_code`; `plz_regionen` mappt PLZ → Ortsteil-Code (ADR-015).
Ein verorteter Nutzer sieht heute alle Umfragen mit `scope_level in
(stadt,kreis,land)` tenant-weit plus die seines eigenen Ortsteils (Match über
`scope_code`) — die vertikale Scheibe seines Wohnorts, keine Nachbarorte.

Dieses Enum ist zu starr für das Zielbild:

- Es kennt **keine Ebene BUND** und keine Zwischenebenen (z. B. Verbandsgemeinde,
  Regierungsbezirk, Stadtbezirk).
- Es kodiert die Hierarchie **implizit im Code** statt in den Daten. Jede neue
  Kommune, jeder neue Kreis wäre potenziell ein Sonderfall.
- „Einschließende Vorfahren" (Gemeinde ⊂ Kreis ⊂ Land ⊂ Bund) sind nicht
  first-class abbildbar, sondern werden über String-Konventionen rekonstruiert.

Deutschland hat mit dem **Amtlichen Gemeindeschlüssel (AGS)** und dem
**Amtlichen Regionalschlüssel (ARS)** aus dem Gemeindeverzeichnis-Informationssystem
(Destatis GV-ISys) einen amtlichen, frei verfügbaren, hierarchisch aufgebauten
Schlüssel. Der 12-stellige ARS ist von Natur aus ein Präfix-Baum
(Land → Regierungsbezirk → Kreis → Gemeindeverband → Gemeinde) und damit die
natürliche Grundlage für einen Gebietsbaum.

## Entscheidung

Wir ersetzen das feste `scope_level`-Enum durch einen **hierarchischen
Gebietsbaum** als Single Source of Truth. Gewählt wird das Zielbild **Ansatz B**,
umgesetzt mit der **expand/contract-Disziplin aus Ansatz A**.

1. **`regions`-Baum als Single Source of Truth.** Eine Tabelle `regions` bildet
   den amtlichen Gebietsbaum ab (Bund → Land → … → Gemeinde → Ortsteil). Jeder
   Knoten trägt seinen ARS/AGS (soweit amtlich vorhanden; Ortsteile unterhalb der
   amtlichen Ebene erhalten synthetische, stabile Kinder-Schlüssel), einen
   Anzeigenamen, den Typ und den Verweis auf den Elternknoten.

2. **`region_id`-Fremdschlüssel statt Enum + Code.** `polls`, `roles`, `qr_codes`
   und die PLZ-Zuordnung referenzieren künftig **eine `region_id`** (FK auf
   `regions`). Das Paar `scope_level` + `scope_code` entfällt — die Ebene ergibt
   sich aus der Position des Knotens im Baum, die Zuständigkeit aus dem Pfad.

3. **`ltree` + ARS als Rückgrat.** Der Pfad jedes Knotens wird als PostgreSQL
   `ltree` materialisiert (Wurzel = Bund). Vorfahren-/Nachfahren-Abfragen
   („zeige alles auf meiner vertikalen Scheibe") laufen als `@>` / `<@` /
   `path ~ 'lquery'` mit GiST-Index statt über String-Präfixe. ARS bleibt der
   fachliche, stabile Schlüssel; `ltree` ist die Abfrage-Optimierung darüber.

4. **Ebene BUND wird ergänzt.** Der Baum bekommt eine echte Wurzel „Deutschland
   (Bund)". Bundesweite Umfragen hängen an dieser Wurzel und sind damit für jeden
   verorteten Nutzer Teil seiner Scheibe.

5. **Standard-Sicht = vertikale Scheibe des Wohnorts** (unverändert im Prinzip,
   sauberer in der Umsetzung): ein verorteter Nutzer sieht
   - seine **eigene Gemeinde**,
   - **alle einschließenden Vorfahren bis zum Bund** (Kreis, Land, Bund, ggf.
     Zwischenebenen),
   - seine **eigenen Ortsteile** (Nachfahren seines Wohnknotens),
   - **keine Nachbarorte** (keine Geschwisterknoten).
   Formal: sichtbar sind Knoten auf dem Pfad des Wohnknotens (Vorfahren +
   Selbst) plus dessen Nachfahren.

6. **PLZ/Standort = niedrigschwelliger Einstieg, verifizierter Wohnsitz = harte
   Zuständigkeit.** Die PLZ-/Standort-Zuordnung (ADR-015) ordnet unverbindlich
   einer Region zu (Lesen, Ergebnisse, Personalisierung). Für **verbindliche
   Abstimmungen** zählt weiterhin der **verifizierte Wohnsitz** (QR/Termin, später
   eID — ADR-014, ADR-018); der Gebietsbaum liefert dafür die eindeutige
   Zuständigkeitsregion.

7. **Neue Kommune/Kreis/Land = Datenimport, kein Code-Change.** Eine neue
   Gebietskörperschaft wird durch **Einspielen ihrer `regions`-Knoten** (aus
   GV-ISys) und der zugehörigen `plz_regionen` aktiviert. Es gibt keine
   Enum-Erweiterung, kein Deployment für neue Ebenen mehr.

8. **Bewusst NICHT jetzt: Tenancy-Umbau.** Der einzige invasive B-Baustein — die
   Umstellung der Mandantentrennung von `tenant_id`-Gleichheit auf
   `path <@ tenant_root` — wird **bewusst nicht jetzt** gebaut. Die
   **`tenant_id`-Isolation bleibt** die harte Sicherheitsgrenze. Der Gebietsbaum
   steuert vorerst **nur Sicht und Zuständigkeit**, nicht die Mandantenisolation.

## Begründung

- **Ansatz B als Zielbild:** Ein datengetriebener Baum ist die einzige Variante,
  die „neue Kommune = Import" ohne Code-Change wirklich einlöst und Bund sowie
  beliebige Zwischenebenen ohne Sonderfälle trägt.
- **Harter Schnitt statt Dual-Read-Overlay:** Das `drizzle`-Verzeichnis ist leer
  und die Pilotdaten sind dünn. Der direkte Schnitt auf `region_id` ist **jetzt
  billiger als je später**. Ein dauerhaftes Dual-Read-Overlay (Enum *und* Baum
  parallel lesen) wäre unnötige technische Schuld.
- **Expand/contract-Disziplin (aus Ansatz A):** Auch der harte Schnitt wird
  diszipliniert in additiven Migrationsschritten ausgeführt (Baum aufbauen und
  füllen → `region_id` nachziehen → Leser umstellen → Enum/Code entfernen), damit
  jeder Schritt für sich prüfbar und rückrollbar bleibt.
- **Tenancy bewusst außen vor:** Der Tenancy-Umbau berührt die
  Sicherheitsgrenze und bringt im Single-Domain-Pilot keinen Nutzen. Ihn jetzt
  nicht anzufassen, hält das Risiko niedrig, ohne das Zielbild zu verbauen.

## Konsequenzen

- **Bauen jetzt:** `regions`-Tabelle (ARS/AGS, Elternverweis, `ltree`-Pfad,
  GiST-Index) + Import der Pilot-Gebiete (Taunusstein und Vorfahren bis Bund);
  `region_id`-FKs auf `polls`, `roles`, `qr_codes`, `plz_regionen`; Umbau der
  Sichtbarkeits-Query (`app/src/lib/polls/queries.ts`) von der
  `scope_level`/`scope_code`-Logik auf die Pfad-basierte vertikale Scheibe;
  Entfernen von `scopeLevelEnum` nach abgeschlossenem Schnitt.
- **Bleibt unverändert:** `tenant_id` als Isolationsgrenze und die host-basierte
  Tenancy (ADR-015). Der Baum ist orthogonal dazu.
- **Design-Dokument:** `docs/architecture/GEBIETSMODELL.md` hält das
  Datenmodell, die Import-Pipeline (GV-ISys → `regions`), die
  Pfad-Query-Muster und die verworfenen Alternativen (Enum-Beibehaltung,
  Dual-Read, sofortiger Tenancy-Umbau) im Detail fest.
- **Später (eigene Entscheidung):** Tenancy auf `path <@ tenant_root`, sobald
  echte Multi-Kommunen-Aggregation über Kreis/Land ansteht.
- Nichts in Stein — bewährt sich etwas nicht, wird es geändert.
