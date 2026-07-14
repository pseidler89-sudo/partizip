# Gebietsmodell — Hierarchischer Gebietsbaum (regions) als Single Source of Truth

Status: Angenommen (Design) · Stand: 2026-07 · Kontext: ADR-015 (PLZ-Einstieg), Ablösung `scopeLevelEnum`
Betrifft: `app/src/db/schema.ts`, `app/src/lib/polls/queries.ts`, `app/src/lib/roles/*`, QR-Erzeugung

---

## 1. Kontext & Ziel

Partizip ist eine überparteiliche kommunale Beteiligungsplattform. Die geografische
Zuständigkeit einer Umfrage, einer Rolle, eines QR-Codes und einer Verifizierungs-Location
wird heute über den Enum `scopeLevelEnum` (`ortsteil | stadt | kreis | land`) plus einen
freien `scope_code` (Text) getragen. Diese Konstruktion mischt zwei Dinge, die getrennt
gehören:

- die **Gebietsart** (ist das ein Ortsteil, eine Gemeinde, ein Kreis, ein Land?), und
- die **Sichtlogik / Zuständigkeit** (wer darf das sehen bzw. darüber abstimmen?).

Die Standard-Sicht (`getAktivePolls`, `queries.ts` ~Z.168–176) reproduziert die Absicht
„vertikale Scheibe" heute per Sonderfall-Code: `scopeLevel IN (stadt, kreis, land)`
tenant-weit **plus** ein String-Match `scopeLevel = ortsteil AND scope_code = userOrtsteilCode`.
Nachbarorte bleiben ausgeschlossen. Das ist korrekt, aber:

- **Nicht skalierbar in der Tiefe:** Eine neue Ebene (z. B. Bund, Regierungsbezirk,
  Verbandsgemeinde) erfordert `ALTER TYPE scope_level ADD VALUE` **und** Query-Anpassungen
  an mehreren Stellen.
- **Nicht aggregationsfähig:** „Alle Umfragen eines Kreises über mehrere Kommunen" ist mit
  einem flachen Enum + tenant-gebundenem Code nicht ohne Sonderpfad ausdrückbar.
- **Ortsteil-Match ist String-fragil** und kennt keine Mehrfach-Ortsteile pro Nutzer.

### Ziel

Weg vom festen Enum, hin zu einem **hierarchischen Gebietsbaum** auf Basis des amtlichen
Regionalschlüssels (ARS, aus Destatis GV-ISys, frei/amtlich, Lizenz dl-de/by-2.0). Die
Ebene **Bund** kommt hinzu — als schlichte Wurzel jedes Pfads, nicht als Sonderfall. Die
Standard-Sicht bleibt semantisch identisch (eigene Gemeinde + einschließende Vorfahren bis
Bund + eigene Ortsteile, **keine Nachbarorte**). Und: **Neue Kommune / neuer Kreis / neues
Land = Daten importieren, kein Code-Change, kein Deploy, keine neuen Enum-Werte.**

PLZ / Standortfreigabe bleibt der **niedrigschwellige, weiche Einstieg** (steuert nur
Sichtbarkeit). Der **verifizierte Wohnsitz** (QR / Termin / später eID) bleibt die **harte
Zuständigkeit** für verbindliche Abstimmungen.

---

## 2. Entwurfsentscheidung (kurz)

Es lagen zwei Ansätze vor: (A) additives Overlay mit dauerhaftem Dual-Read neben dem Enum;
(B) `regions`-Baum als Single Source of Truth mit hartem Schnitt auf `region_id`-FKs.

**Gewählt: B als Zielbild, umgesetzt mit der expand/contract-Disziplin aus A.**

Begründung:

- Das `drizzle`-Verzeichnis ist **leer** (noch keine Migrationen), die Pilotdaten sind dünn.
  Der Backfill trifft eine Handvoll Zeilen. Der harte Schnitt auf `region_id` ist **jetzt so
  billig wie nie wieder** — je später, desto teurer.
- Ein dauerhaftes Dual-Read-Overlay (Enum **und** Baum parallel konsistent halten) ist
  vermeidbare technische Schuld: doppelte Wahrheit, Divergenz-Gefahr, ein Cut, der
  erfahrungsgemäß nie kommt. Für einen produktiv laufenden Altbestand wäre A richtig — hier
  nicht.
- Wir übernehmen aus A jedoch die **expand/contract-Sequenz** (additive DDL → seed → backfill
  → verifizieren → contract). Jede Stufe ist einzeln deploybar; erst nach verifiziertem
  Backfill fällt der Enum. Das ist kein „Big Bang", sondern ein disziplinierter Schnitt in
  gerichteter Bahn.
- **Bewusst NICHT jetzt** (Scope-Grenze, siehe §8): der invasive Tenancy-Umbau von
  `tenant_id`-Gleichheit auf `path <@ tenant_root`. Der Baum ist tenant-frei, aber die
  Isolation bleibt im Pilot über `tenant_id`. Der Baum steuert vorerst nur Sicht &
  Zuständigkeit, nicht die Mandanten-Isolation.

---

## 3. Datenmodell

### 3.1 `regions` — der Baum (SSOT)

Tenant-**frei** (Bund → Land → Kreis → Gemeinde existieren genau einmal, global; Kreis/Land
aggregieren per Definition mehrere Kommunen).

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | `uuid` PK | |
| `parent_id` | `uuid` FK → `regions.id` (RESTRICT), NULL nur bei Bund | normalisierte Wahrheit der Baumkanten |
| `typ` | `region_typ` (Enum) | **Gebietsart**, nicht Scope: `bund \| land \| kreis \| gemeinde \| ortsteil`. Erweiterbar (z. B. `regierungsbezirk`, `verbandsgemeinde`) **ohne Query-Änderung** — die Logik hängt an `parent_id`/`path`, nicht am Typ |
| `ags` | `text`, NULL | amtlicher 8-Steller (Gemeinde/Kreis); NULL für Bund/Ortsteil. Für Joins gegen andere amtliche Datensätze |
| `ars` | `text`, NULL | 12-stelliger Regionalschlüssel, **kanonischer Baum-Anker** (Land 2 · RB 1 · Kreis 2 · VB 4 · Gemeinde 3). Trägt die Hierarchie im Präfix → Import/Backfill trivial |
| `name` | `text` NOT NULL | |
| `path` | `ltree` | materialisierter Pfad, z. B. `de.hessen.rtk.taunusstein.wehen`. **Abgeleitet** aus `parent_id` per Trigger — nie von Hand |
| `tenant_id` | `uuid` FK → `tenants.id`, NULL | operativer Betreuungs-Marker (Branding/Betrieb), **nicht** Isolation. Kreis/Land/Bund oberhalb: NULL |
| `lat` / `lon` | `numeric`, NULL | ungefähres Zentrum (Haversine-Standortauflösung, aus `plz_regionen` übernehmbar) |
| `is_active` | `boolean` | Gebietsreform/Fusion: Knoten deaktivierbar |
| `created_at` / `updated_at` | `timestamptz` | |

Constraints / Indizes:

- `UNIQUE (ars) WHERE ars IS NOT NULL` — natürlicher Schlüssel, idempotenter Import.
- `UNIQUE (parent_id, name)` — Ortsteile ohne amtlichen Schlüssel eindeutig unter ihrer Gemeinde.
- `CHECK`: genau eine Wurzel (`parent_id IS NULL ⇒ typ = 'bund'`).
- **GiST-Index auf `path`** — Kern der O(1)-Vorfahren/Nachfahren-Queries.

**Warum `parent_id` UND `path` redundant?** `parent_id` ist die normalisierte Wahrheit
(referentielle Integrität, Import per ARS-Präfix). `path` ist die abgeleitete Beschleunigung
für die vertikale Scheibe und die Aggregation (`path <@ 'de.hessen'` = ganzer Teilbaum in
einem Index-Scan). `path` wird per **Trigger** aus `parent_id` gepflegt.

**AGS vs. ARS:** ARS ist das Rückgrat, weil er die Baumkanten bereits kodiert (parent =
ARS-Präfix). AGS wird als bequemer 8-Steller für Fremd-Joins mitgeführt. **Ortsteile haben
keinen amtlichen Schlüssel** → synthetischer, unter der Gemeinde stabiler Code (analog dem
heutigen `ortsteile.code`, jetzt als `regions`-Knoten mit `parent_id`).

### 3.2 Fachtabellen hängen über `region_id`

`polls`, `roles`, `qr_codes` und `verification_locations` verlieren `scope_level` +
`scope_code` und bekommen:

```
region_id  uuid NOT NULL  FK → regions.id (RESTRICT)
```

Ein Poll (bzw. eine Rolle / ein QR-Code / eine Location) „gehört" **genau einem
Gebietsknoten**. Ob Ortsteil, Gemeinde, Kreis, Land oder Bund ergibt sich aus `regions.typ`
bzw. `path` — kein separates Ebenen-Feld mehr. Die Unique-Constraints wandern mit, z. B.:

```
roles          UNIQUE (tenant_id, user_id, role_type, region_id)   -- NULLS wegfallend, region_id NOT NULL
qr_codes       (token_hash UNIQUE bleibt)
```

### 3.3 `users` — Wohnort weich vs. hart

- `home_region_id` `uuid` FK → `regions.id` — der **weich** ermittelte Wohnort-Knoten
  (Gemeinde oder Ortsteil), aus PLZ/Standort oder Selbstwahl. Steuert **Sichtbarkeit**.
- `residency_region_id` `uuid` FK → `regions.id`, NULL — der **verifizierte** Wohnsitz
  (aus QR/Termin/später eID). Steuert **Zuständigkeit** für verbindliche Abstimmungen.
- `ortsteil_id` (heute) wird beim Backfill nach `home_region_id` überführt; die `ortsteile`-
  Tabelle bleibt als fachliche Stammdaten bestehen und spiegelt sich als `regions`-Knoten.

### 3.4 `plz_regions` — PLZ ↔ Region als echtes n:m

Der heutige `plz_regionen`-Ansatz (eine Zeile je PLZ → Tenant + optional ein Ortsteil-Code)
bricht an der Realität: eine PLZ überlappt mehrere Gemeinden, eine Gemeinde hat mehrere PLZ.

```
plz_regions
  plz         text
  region_id   uuid FK → regions.id (RESTRICT)   -- i. d. R. Gemeinde ODER Ortsteil
  weight      numeric NULL   -- Flächen-/Einwohneranteil bei Splitlagen (Ranking)
  is_primary  boolean        -- Default-Auflösung bei Mehrdeutigkeit
  source      text           -- Herkunft (Destatis / OpenPLZ / OSM / manuell)
  PRIMARY KEY (plz, region_id)
  INDEX (plz)
```

Auflösung: alle `region_id` zu einer PLZ → i. d. R. genau eine Gemeinde ⇒ direkt; bei
Splitlagen ⇒ der Bürger wählt aus einem kleinen Kandidatenset (Default `is_primary`, Ranking
`weight`). Die Standortfreigabe (lat/lon) bleibt orthogonal — Haversine gegen `regions.lat/lon`
liefert denselben `region_id`.

> **Wichtig:** PLZ-Auflösung ergibt **Sichtbarkeit/Einstieg** (weich) → setzt
> `home_region_id`. **Zuständigkeit** für verbindliche Abstimmungen bleibt am verifizierten
> Wohnsitz (`residency_region_id`), niemals an der selbstgewählten PLZ.

---

## 4. Migrations- & Backfill-Plan (expand → backfill → contract)

Gerichtete Bahn. Schritte 1–3 sind additiv und rückwärtskompatibel (der Enum-Pfad läuft
unverändert weiter, `region_id` ist reine Zusatzinfo); Schritt 4 ist der Contract.

### Schritt 0 — Datenumfang (welche AGS-Daten, in welchem Umfang zuerst)

- **Jetzt (Pilot):** Nur den **Pilot-Teilbaum** amtlich seeden — Bund-Wurzel (synthetisch,
  `de`) → Land Hessen (`06`) → Kreis Rheingau-Taunus (`06439`) → Gemeinde Taunusstein
  (AGS `06439015`, ARS `064390015015`) → deren Ortsteile (aus der bestehenden
  `ortsteile`-Tabelle). Das sind wenige
  Knoten, sofort verifizierbar.
- **Später (optional, reiner Datenlauf):** Bundesweiter Import aus **Destatis GV-ISys /
  Gemeindeverzeichnis GV100** (~11.000 Gemeinden + Kreise + Länder, wenige MB, quartalsweise,
  dl-de/by-2.0). Kostet fast nichts und macht „neue Kommune = nur Daten" (§6) vollständig
  real: der Baum steht schon, man aktiviert nur einen Knoten. **Für den Pitch nicht nötig**,
  aber die Modell-Struktur ist darauf ausgelegt.
- **PLZ ↔ Gemeinde:** amtlich frei nur eingeschränkt sauber verfügbar → OpenPLZ API / OSM-
  Ableitung mit `weight`/`is_primary` als pragmatischer offener Weg. Für den Pilot ist
  Taunusstein ≈ eine PLZ, also trivial.

### Schritt 1 — Expand (additive DDL)

`regions` + `plz_regions` anlegen; `region_typ`-Enum. Fachtabellen (`polls`, `roles`,
`qr_codes`, `verification_locations`) bekommen `region_id` **nullable** dazu. `users`
bekommt `home_region_id` + `residency_region_id` (nullable). Kein Verhalten ändert sich →
sofort rollback-bar (Spalten droppen). `path`-Trigger installieren.

### Schritt 2 — Seed Baum

Pilot-Teilbaum aus §0 importieren: parent per ARS-Präfix, `path` per Trigger. Pilot-Ortsteile
aus `ortsteile` als Kinder der Gemeinde (`ortsteile.code` → `regions.name`/synthetischer Code,
`parent_id` = Gemeindeknoten). Import als **versioniertes, idempotentes Seed-Skript** (idempotent
über `UNIQUE(ars)`).

### Schritt 3 — Backfill Fach-FKs (deterministisch, verifizierbar)

Aus `(tenant, scope_level, scope_code)`, weil jeder alte Scope im Single-Tenant-Pilot **genau
einen** Knoten trifft:

- `ortsteil` + `scope_code` → `regions` mit `parent` = Tenant-Gemeinde ∧ `code` = `scope_code`.
- `stadt` → der Gemeindeknoten des Tenants (`tenant.root_region_id`).
- `kreis` / `land` → der jeweilige Vorfahr im `path` des Tenant-Knotens.
- `users.ortsteil_id` → `home_region_id` über die Ortsteil-Spiegelknoten.
- `plz_regionen` (alt) → `plz_regions` (neu), `ortsteil_code` → passende Region.

**Verifikation (Gate vor Contract):** `COUNT(*) WHERE region_id IS NULL` muss auf **jeder**
Fachtabelle 0 sein. Optional Shadow-Read: neue Baum-Query gegen alte Enum-Query auf
Ergebnisgleichheit prüfen (im dünnen Pilot billig).

### Schritt 4 — Contract (der Schnitt)

Erst nach grünem Gate:

- `region_id` auf **NOT NULL** setzen.
- `scope_level` / `scope_code` auf `polls`, `roles`, `qr_codes`, `verification_locations`
  **droppen**; `scopeLevelEnum` aus dem Schema entfernen; `plz_regionen` (alt) entfernen.
- Anwendungscode (`queries.ts`, `roles/*`, QR-Erzeugung) im **selben** Contract-Schritt auf
  `region_id` umstellen — kein dauerhaftes Dual-Read-Fenster.

**Rückwärtskompatibilität:** Schritte 1–3 lassen den Enum-Pfad unverändert laufen; jede Stufe
ist einzeln rollback-bar (Read-Code unverändert, Spalten droppbar). Der einzige nicht-triviale
Rollback ist Schritt 4 — der wird erst nach grünem Verifikations-Gate gefahren, und da die
Bestandsdaten dünn sind, ist ein Re-Backfill in die Gegenrichtung notfalls trivial.

---

## 5. Standard-Sicht-Query — vertikale Scheibe inkl. Bund

Der Nutzer hat `home_region_id` (weich per PLZ/Standort oder verifiziert). Sichtbar sind alle
Polls auf Knoten **auf dem Pfad von der eigenen Gemeinde bis zur Wurzel (Bund)** **plus** die
**eigenen Ortsteil-Kinder** — keine Nachbarorte.

```sql
-- viewer_path = regions.path des home_region-Knotens (Gemeinde bzw. Ortsteil)
SELECT p.*
FROM polls p
JOIN regions r ON r.id = p.region_id
WHERE p.status = 'aktiv'
  AND (p.opens_at  IS NULL OR p.opens_at  <= now())
  AND (p.closes_at IS NULL OR p.closes_at >  now())
  AND (
        r.path @> :viewer_path     -- Vorfahren: Gemeinde selbst, Kreis, Land, Bund
     OR r.path <@ :viewer_path      -- Nachfahren: eigene Ortsteile
      )
ORDER BY nlevel(r.path), p.created_at DESC;
```

- `r.path @> :viewer_path` liefert **alle Vorfahren-Knoten** — die vertikale Scheibe nach
  oben; **Bund fällt automatisch mit rein**, weil er im Pfad jedes Nutzers liegt. Kein
  Sonderfall-Code pro Ebene.
- `r.path <@ :viewer_path` liefert die **eigenen Ortsteile** — ersetzt exakt das heutige
  `scope_code == userOrtsteilCode`, aber strukturell statt per String-Match, also auch bei
  **mehreren** Ortsteilen korrekt.
- `nlevel(r.path)` gruppiert nach Ebene (Bund → … → Ortsteil) für die Ebenen-UI aus ADR-015 —
  die Ebenen-Kennzeichnung fällt aus `regions.typ`/`nlevel` ab, ohne Extra-Feld.
- **Nicht eingeloggt / nicht verortet:** `:viewer_path` fehlt ⇒ Fallback auf den Pilot-Tenant-
  Gemeindeknoten (entspricht dem heutigen Default „stadt/kreis/land tenant-weit", ohne
  Ortsteil-Kinder).

Ein einziger GiST-Index-Scan, keine `IN (…)`-Enum-Liste. Semantik identisch zur heutigen
Absicht, nur korrekt generalisiert und um Bund erweitert.

**Aggregation nach oben** (Kreis-Digest über mehrere Kommunen) ist dieselbe Mechanik von der
anderen Seite: `WHERE r.path <@ :kreis_path` sammelt alle Polls/Stimmen des ganzen Kreis-
Teilbaums — der ADR-015-Roadmap-Punkt „Kreis-/Land-Aggregation über mehrere Kommunen-Tenants",
hier ohne Sonderpfad. (Setzt allerdings den in §8 zurückgestellten Tenancy-Umbau voraus, bevor
er echt tenant-übergreifend wird — die Query-Form steht schon.)

> **Hinweis zur Zuständigkeit:** Für **verbindliche** Abstimmungen wird nicht `home_region_id`,
> sondern `residency_region_id` als `:viewer_path` bzw. als Berechtigungsanker herangezogen
> (weiche Sicht ≠ harte Stimmberechtigung).

---

## 6. „Neue Kommune = nur Daten"

Sobald der Baum (mindestens die amtlichen Vorfahren) steht, ist Onboarding rein datengetrieben:

1. **Gemeindeknoten** sicherstellen — bei bundesweitem Vorimport bereits vorhanden (kein
   Insert); sonst per ARS unter den Kreis hängen (`parent_id`, `path` ergänzt sich aus Präfix).
2. `tenant` anlegen, `tenant.root_region_id` = Gemeindeknoten; `regions.tenant_id` für den
   betreuten Teilbaum setzen (Branding/Betrieb).
3. Optional **Ortsteile** als Kinder ergänzen (`INSERT regions … parent_id = Gemeinde`) — der
   einzige manuelle Datenteil, weil amtlich nicht vorhanden.
4. **PLZ-Zeilen** in `plz_regions` (ggf. mit `weight`/`is_primary`) + optional `lat/lon`.

Kreis-/Land-/Bund-Vorfahren aggregieren die neue Kommune automatisch mit. **Kein Code-Change,
keine Migration, keine neuen Enum-Werte, kein Deploy.** Eine neue **Ebene** (z. B.
`regierungsbezirk`) ist ein weiterer Knoten-Typ-Wert bzw. schlicht eine Zwischenebene im
`path` — keine Query-Änderung.

---

## 7. Bewusste Trade-offs

| Thema | Einschätzung |
|---|---|
| **Enum weg statt Overlay** | Wir zahlen einen einmaligen, disziplinierten Contract-Schnitt statt dauerhafter Dual-Read-Schuld. Gerechtfertigt, weil `drizzle` leer und Pilotdaten dünn — später wäre das Overlay der günstigere Weg, jetzt nicht. |
| **`ltree`-Abhängigkeit** | Postgres-Contrib-Extension (in PG16 vorhanden). Elegant + ein Index-Scan. Alternative: reiner `parent_id` + Recursive-CTE — funktioniert, aber teurer/weniger elegant. `ltree` klar empfohlen; Ops muss die Extension aktivieren. |
| **ARS als Rückgrat** | Präfix-Logik macht Import/Backfill trivial. Preis: Gebietsreformen/Fusionen ändern Schlüssel → braucht Reimport-Umgang (`is_active`, Umhängen). Im Pilot vernachlässigbar. |
| **Ortsteile bleiben Handarbeit** | Amtlich nicht vorhanden; pro Pilotkommune manuell + synthetischer, dokumentierter, stabiler Code (sonst brechen Backfill-Joins). Das „nur Daten"-Versprechen gilt für amtliche Ebenen voll, für Ortsteile mit manuellem Anteil. |
| **PLZ↔Gemeinde-Datenqualität** | Keine freie, amtliche, saubere PLZ→AGS-Zuordnung. OSM/OpenPLZ + `weight` genügen für den **weichen** Einstieg. Solange PLZ nur Sicht (nicht Zuständigkeit) steuert, ist der Fehler-Impact gering. |
| **Über-Engineering für einen Tenant** | Objektiv mehr als ein Pilot braucht. Rechtfertigung: erklärtes Ziel ist Multi-Kommune/Multi-Ebene + Bund; das Fundament ist nie wieder so billig zu legen wie mit leerem `drizzle`. |

---

## 8. Was NICHT jetzt (Scope-Grenze)

Bewusst **außerhalb** dieses Schritts, um den Piloten nicht zu gefährden:

- **Tenancy-Umbau auf `path <@ tenant_root`.** Der invasivste Teil des SSOT-Zielbilds:
  Isolation von `tenant_id`-Gleichheit auf Teilbaum-Zugehörigkeit umstellen. Jeder
  RLS-/Query-Pfad mit `eq(tenantId)` müsste revidiert und jede Gate-B-geprüfte
  Isolationsinvariante neu verifiziert werden. **Bleibt vorerst:** `tenant_id`-Isolation wie
  heute; `regions` ist tenant-frei und steuert nur Sicht & Zuständigkeit. Der echte
  tenant-übergreifende Kreis-Digest wartet auf diesen Umbau (die Query-Form steht schon).
- **Bundesweiter GV-ISys-Vollimport.** Nur Pilot-Teilbaum jetzt; der Vollimport ist ein
  späterer reiner Datenlauf, kein Code.
- **Quartalsweiser Reimport-/Gebietsreform-Job** (Fusionen, Umschlüsselung, Poll-/Rollen-
  Umhängen). Modell sieht es vor (`is_active`, `parent_id`), Automatisierung folgt später.
- **eID als Zuständigkeitsnachweis.** `residency_region_id` ist vorgesehen; die eID-Anbindung
  selbst ist eigener Scope.
- **`regierungsbezirk` / `verbandsgemeinde` als reale Zwischenebenen.** Das Modell trägt sie
  (offener `typ`, `path`), sie werden erst mit Bedarf befüllt.
- **Bund-Erstellpfad + Composer-Region-Picker.** Die **Bund-Ebene ist in Etappe 2 nur
  lesend aktiv**: sie fällt als Wurzel jedes Pfads automatisch in die Standard-Sicht (§5),
  aber `scopeLevelEnum` (`ortsteil | stadt | kreis | land`) kennt **kein `bund`** — der
  Composer kann also keine Bund-Umfrage anlegen. Das ist eine **bewusste Scope-Grenze**:
  Die Umfrage-**Erstellung** hängt weiter am alten Scope-Enum (Dual-Write). Erst wenn in der
  contract-/Folge-Etappe `scope_level`/`scope_code` fallen und der **Region-Picker (Baum-
  Auswahl)** das Scope-Dropdown ablöst (§9, „Poll-Erstellung UI"), wird das Anlegen auf
  beliebigen Knoten — inkl. Bund — möglich (governt über `roles.region_id` + `path`).

---

## 9. Offene Punkte

- **Ortsteil-Code-Schema:** Verbindliches, dokumentiertes Namens-/Suffix-Schema für synthetische
  Ortsteil-Knoten (Stabilität über Reimports) festlegen — sonst Backfill-Join-Bruch.
- **`ltree`-Freigabe durch Ops** auf dem Produktivserver (Extension aktivieren) — vor Schritt 1
  klären; Fallback `parent_id` + CTE dokumentieren.
- **`tenant.root_region_id`** einführen: schon jetzt (nur als Anker/Branding) oder erst mit dem
  Tenancy-Umbau? Empfehlung: Feld jetzt additiv anlegen, Isolation-Semantik später.
- **Poll-Erstellung UI:** Region-Auswahl (Baum-Picker) ersetzt das alte Scope-Dropdown —
  welche Knoten darf welche Rolle bespielen? (Governance an `roles.region_id` + `path`.)
- **PLZ-Splitlagen-UX:** konkrete Auswahlkomponente bei mehrdeutiger PLZ (Kandidatenset,
  `is_primary`-Default) mit ADR-015 abstimmen.
- **Verifikations-Gate formalisieren:** genaue Diff-/Shadow-Read-Queries als Teil des
  Migrationsskripts, damit Schritt 4 nur bei grün läuft.
