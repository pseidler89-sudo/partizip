-- ADR-024 / GEBIETSMODELL §3.2, §4 (ETAPPE 2): region_id-FK auf den Fachtabellen.
-- expand → (Ortsteil-Spiegelung) → backfill → trigger → contract-auf-NOT-NULL, alles
-- in EINER Migration. SELBST-AUSREICHEND: die Migration setzt NICHT voraus, dass
-- db:seed:regions vorher lief — sie spiegelt fehlende Ortsteil-Knoten selbst aus der
-- `ortsteile`-Tabelle (§2b), damit jede bis 0023 migrierte Bestands-DB (inkl.
-- Bestand an Polls/Rollen/QR/Standorten) auch bei der Deploy-Reihenfolge
-- „migrate vor seed" sauber nachzieht. scope_level/scope_code BLEIBEN als Schatten
-- (Dual-Write); ihr Wegfall ist die spätere contract-Etappe.
--
-- SCOPE-GRENZE (bewusst, Folge-Etappe — kein Fix hier): scopeLevelEnum kennt kein
-- 'bund'. Der Composer kann daher KEINE Bund-Umfrage anlegen (Bund ist nur lesend
-- aktiv — er fällt als Wurzel jedes Pfads automatisch in die Sicht, siehe §5). Die
-- Bund-ERSTELLUNG samt Composer-Region-Picker (Baum-Auswahl statt Scope-Dropdown)
-- ist Teil der contract-/Folge-Etappe, wenn scope_level/scope_code fallen
-- (GEBIETSMODELL §8, §9).

-- ---------------------------------------------------------------------------
-- 1) EXPAND: region_id zunächst NULLABLE hinzufügen (Backfill folgt), + FK + Index.
-- ---------------------------------------------------------------------------
ALTER TABLE "polls" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_locations" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_locations" ADD CONSTRAINT "verification_locations_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_polls_region_id" ON "polls" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "idx_qr_codes_region_id" ON "qr_codes" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "idx_roles_region_id" ON "roles" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "idx_verification_locations_region_id" ON "verification_locations" USING btree ("region_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2) Ableitungs-Logik als SQL-Funktionen (Single Source of Truth für Backfill,
--    Dual-Write und Trigger — keine Divergenz zwischen den Pfaden).
-- ---------------------------------------------------------------------------

-- ltree-sicheres Label / stabiler Ortsteil-Code (identisch zu scripts/seed-regions.ts
-- ltreeLabelExpr): lowercase, Umlaute/ß transliterieren, Rest → '_'. Damit hält der
-- Format-CHECK ^[a-z0-9_]+$ und Ortsteil-Codes joinen deterministisch.
CREATE OR REPLACE FUNCTION regions_ltree_label(txt text) RETURNS text AS $$
  SELECT regexp_replace(
    replace(replace(replace(replace(lower($1), 'ä','ae'), 'ö','oe'), 'ü','ue'), 'ß','ss'),
    '[^a-z0-9_]+', '_', 'g');
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

-- (tenant, scope_level, scope_code) → region_id über den Baum:
--   stadt / (NULL)  → Gemeinde-Knoten des Tenants
--   ortsteil + code → Ortsteil-Kind der Gemeinde mit path_label = label(code)
--   kreis           → Kreis-Vorfahr der Gemeinde (path @> gemeinde.path)
--   land            → Land-Vorfahr der Gemeinde
-- Der Gemeinde-Anker ist EINDEUTIG (genau ein Gemeinde-Knoten pro Tenant); ein
-- mehrdeutiges ORDER BY … LIMIT 1 ist raus — Mehrdeutigkeit bricht hart ab.
-- p_provision=false (Backfill): fehlt ein Knoten → RAISE (kein stilles NULL).
-- p_provision=true  (Trigger/Dual-Write, Laufzeit): das Sicherheitsnetz (minimaler
--   Pilot-Pfad + per-Tenant-Gemeinde/Ortsteil) greift NUR, wenn es zusätzlich per
--   GUC `app.region_provision` (on/true/1/yes) freigegeben ist — gedacht für Test-/
--   Demo-DBs. In PRODUKTION ist die GUC ungesetzt → das Netz ist AUS und ein
--   fehlender Baum schlägt HART fehl (der Baum MUSS via db:seed:regions da sein;
--   keine stille Baum-Pollution). Labels de/hessen/rtk decken sich mit dem
--   amtlichen Seed (idempotent über (parent_id, path_label)).
CREATE OR REPLACE FUNCTION regions_resolve_region_id(
  p_tenant uuid, p_scope text, p_code text, p_provision boolean
) RETURNS uuid AS $$
DECLARE
  v_bund uuid; v_land uuid; v_kreis uuid;
  v_gem_id uuid; v_gem_path ltree; v_result uuid;
  v_gem_count int; v_provision boolean;
BEGIN
  -- Sicherheitsnetz nur, wenn der Aufrufer es anfordert UND es per GUC freigegeben
  -- ist (Test/Demo). Produktion: GUC ungesetzt → false → kein Provisioning.
  v_provision := p_provision
    AND coalesce(current_setting('app.region_provision', true), 'off')
        IN ('on', 'true', '1', 'yes');

  -- Gemeinde-Anker EINDEUTIG bestimmen (kein mehrdeutiges LIMIT 1). Mehr als ein
  -- Gemeinde-Knoten pro Tenant ist ein Konfigurationsfehler → sofortiger Abbruch.
  SELECT count(*) INTO v_gem_count
    FROM regions WHERE typ = 'gemeinde' AND tenant_id = p_tenant;
  IF v_gem_count > 1 THEN
    RAISE EXCEPTION 'region_id: % Gemeinde-Knoten für Tenant % — Anker nicht eindeutig', v_gem_count, p_tenant;
  END IF;
  SELECT id, path INTO v_gem_id, v_gem_path
    FROM regions WHERE typ = 'gemeinde' AND tenant_id = p_tenant LIMIT 1;

  IF v_gem_id IS NULL THEN
    IF NOT v_provision THEN
      RAISE EXCEPTION 'region_id: kein Gemeinde-Knoten für Tenant % (Baum nicht geseedet — db:seed:regions vor db:migrate)', p_tenant;
    END IF;
    INSERT INTO regions (parent_id, typ, name, path_label, ars)
      VALUES (NULL, 'bund', 'Deutschland', 'de', NULL)
      ON CONFLICT (parent_id, path_label) DO NOTHING;
    SELECT id INTO v_bund FROM regions WHERE parent_id IS NULL AND typ = 'bund' LIMIT 1;
    INSERT INTO regions (parent_id, typ, name, path_label, ags, ars)
      VALUES (v_bund, 'land', 'Hessen', 'hessen', '06', '060000000000')
      ON CONFLICT (parent_id, path_label) DO NOTHING;
    SELECT id INTO v_land FROM regions WHERE parent_id = v_bund AND path_label = 'hessen' LIMIT 1;
    INSERT INTO regions (parent_id, typ, name, path_label, ags, ars)
      VALUES (v_land, 'kreis', 'Rheingau-Taunus-Kreis', 'rtk', '06439', '064390000000')
      ON CONFLICT (parent_id, path_label) DO NOTHING;
    SELECT id INTO v_kreis FROM regions WHERE parent_id = v_land AND path_label = 'rtk' LIMIT 1;
    INSERT INTO regions (parent_id, typ, name, path_label, tenant_id)
      VALUES (v_kreis, 'gemeinde', 'Gemeinde ' || left(replace(p_tenant::text, '-', ''), 8),
              'g_' || replace(p_tenant::text, '-', '_'), p_tenant)
      ON CONFLICT (parent_id, path_label) DO NOTHING;
    SELECT id, path INTO v_gem_id, v_gem_path
      FROM regions WHERE typ = 'gemeinde' AND tenant_id = p_tenant LIMIT 1;
  END IF;

  IF p_scope IS NULL OR p_scope = 'stadt' THEN
    v_result := v_gem_id;
  ELSIF p_scope = 'ortsteil' THEN
    IF p_code IS NULL THEN
      RAISE EXCEPTION 'region_id: scope=ortsteil ohne scope_code (Tenant %)', p_tenant;
    END IF;
    SELECT id INTO v_result FROM regions
      WHERE parent_id = v_gem_id AND typ = 'ortsteil'
        AND path_label = regions_ltree_label(p_code) LIMIT 1;
    IF v_result IS NULL AND v_provision THEN
      INSERT INTO regions (parent_id, typ, name, path_label, tenant_id)
        VALUES (v_gem_id, 'ortsteil', p_code, regions_ltree_label(p_code), p_tenant)
        ON CONFLICT (parent_id, path_label) DO NOTHING;
      SELECT id INTO v_result FROM regions
        WHERE parent_id = v_gem_id AND typ = 'ortsteil'
          AND path_label = regions_ltree_label(p_code) LIMIT 1;
    END IF;
  ELSIF p_scope = 'kreis' THEN
    SELECT id INTO v_result FROM regions WHERE typ = 'kreis' AND path @> v_gem_path LIMIT 1;
  ELSIF p_scope = 'land' THEN
    SELECT id INTO v_result FROM regions WHERE typ = 'land' AND path @> v_gem_path LIMIT 1;
  ELSE
    RAISE EXCEPTION 'region_id: unbekannter scope_level %', p_scope;
  END IF;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'region_id: Scope (%, %) für Tenant % nicht auf einen Knoten abbildbar', p_scope, p_code, p_tenant;
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2b) SELBST-AUSREICHENDE Ortsteil-Spiegelung VOR dem Backfill.
--     Damit 0024 auch auf einer Bestands-DB durchläuft, die NUR die amtlichen
--     Knoten (bund/land/kreis/gemeinde) trägt und auf der db:seed:regions noch
--     NICHT lief (Deploy-Reihenfolge migrate vor seed): die fehlenden Ortsteil-
--     Knoten werden hier idempotent aus der `ortsteile`-Tabelle unter dem
--     passenden Gemeinde-Knoten gespiegelt (identisch zu scripts/seed-regions.ts).
--
--     Der Spiegel-Join hängt an ortsteile.tenant_id = gemeinde.tenant_id. Auf
--     Bestands-DBs kann der Gemeinde-Knoten tenant_id=NULL tragen (der Seed war an
--     einen anderen Tenant-Slug gebunden). Deshalb VORHER robust binden — OHNE
--     festen Slug: pro Tenant mit Fachzeilen den EINDEUTIGEN, noch ungebundenen
--     Gemeinde-Knoten adoptieren. Fehlt für einen solchen Tenant ein Gemeinde-
--     Knoten (oder ist die Zuordnung mehrdeutig), FRÜH und klar abbrechen — nicht
--     erst mitten im Fachtabellen-Backfill.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant uuid;
  v_free int;
BEGIN
  FOR v_tenant IN
    SELECT tenant_id FROM polls
    UNION SELECT tenant_id FROM roles
    UNION SELECT tenant_id FROM qr_codes
    UNION SELECT tenant_id FROM verification_locations
  LOOP
    -- Schon ein Gemeinde-Knoten für diesen Tenant? Dann nichts zu binden.
    PERFORM 1 FROM regions WHERE typ = 'gemeinde' AND tenant_id = v_tenant;
    IF FOUND THEN CONTINUE; END IF;

    -- Sonst den genau EINEN ungebundenen Gemeinde-Knoten (tenant_id NULL) über
    -- die amtliche Kette adoptieren. 0 → Baum fehlt; >1 → nicht eindeutig.
    SELECT count(*) INTO v_free FROM regions WHERE typ = 'gemeinde' AND tenant_id IS NULL;
    IF v_free = 1 THEN
      UPDATE regions SET tenant_id = v_tenant, updated_at = now()
        WHERE typ = 'gemeinde' AND tenant_id IS NULL;
    ELSIF v_free = 0 THEN
      RAISE EXCEPTION 'region_id-Backfill: kein Gemeinde-Knoten für Tenant % — Gebietsbaum muss vor der Migration geseedet sein (db:seed:regions)', v_tenant;
    ELSE
      RAISE EXCEPTION 'region_id-Backfill: % ungebundene Gemeinde-Knoten — Zuordnung für Tenant % nicht eindeutig; tenant_id am richtigen Gemeinde-Knoten setzen (db:seed:regions)', v_free, v_tenant;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- Ortsteil-Knoten idempotent spiegeln (identisch zu scripts/seed-regions.ts §2):
-- jede ortsteile-Zeile → Ortsteil-Kind unter dem Gemeinde-Knoten ihres Tenants.
-- ON CONFLICT (parent_id, path_label) DO NOTHING → auf voll geseedeter DB No-op.
INSERT INTO regions (parent_id, typ, name, path_label, tenant_id)
  SELECT g.id, 'ortsteil', o.name, regions_ltree_label(o.code), o.tenant_id
  FROM ortsteile o
  JOIN regions g ON g.typ = 'gemeinde' AND g.tenant_id = o.tenant_id
  ON CONFLICT (parent_id, path_label) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3) BACKFILL der Bestandszeilen (strikt, p_provision=false → deckt ALLES ab
--    oder bricht ab). Idempotent über WHERE region_id IS NULL.
-- ---------------------------------------------------------------------------
UPDATE polls   SET region_id = regions_resolve_region_id(tenant_id, scope_level::text, scope_code, false) WHERE region_id IS NULL;--> statement-breakpoint
UPDATE roles   SET region_id = regions_resolve_region_id(tenant_id, scope_level::text, scope_code, false) WHERE region_id IS NULL;--> statement-breakpoint
UPDATE qr_codes SET region_id = regions_resolve_region_id(tenant_id, scope_level::text, scope_code, false) WHERE region_id IS NULL;--> statement-breakpoint
UPDATE verification_locations SET region_id = regions_resolve_region_id(tenant_id, 'stadt', NULL, false) WHERE region_id IS NULL;--> statement-breakpoint

-- Verifikations-Gate vor dem Contract (§4): 0 NULL auf JEDER Fachtabelle.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM polls WHERE region_id IS NULL)
     OR EXISTS (SELECT 1 FROM roles WHERE region_id IS NULL)
     OR EXISTS (SELECT 1 FROM qr_codes WHERE region_id IS NULL)
     OR EXISTS (SELECT 1 FROM verification_locations WHERE region_id IS NULL) THEN
    RAISE EXCEPTION 'Backfill unvollständig: es verbleiben NULL region_id (Gebietsbaum unvollständig geseedet?)';
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4) Dual-Write-Sicherheitsnetz: BEFORE-INSERT-Trigger leitet region_id ab, wenn
--    der Aufrufer es nicht setzt (Seeds/Tests/direkte Inserts). Der App-Server
--    setzt region_id zusätzlich explizit (queries/actions) — dann No-op.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION regions_derive_fk_region_id() RETURNS trigger AS $$
BEGIN
  IF NEW.region_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'verification_locations' THEN
    NEW.region_id := regions_resolve_region_id(NEW.tenant_id, 'stadt', NULL, true);
  ELSE
    NEW.region_id := regions_resolve_region_id(NEW.tenant_id, NEW.scope_level::text, NEW.scope_code, true);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER polls_region_fk_bi BEFORE INSERT ON polls
  FOR EACH ROW EXECUTE FUNCTION regions_derive_fk_region_id();--> statement-breakpoint
CREATE TRIGGER roles_region_fk_bi BEFORE INSERT ON roles
  FOR EACH ROW EXECUTE FUNCTION regions_derive_fk_region_id();--> statement-breakpoint
CREATE TRIGGER qr_codes_region_fk_bi BEFORE INSERT ON qr_codes
  FOR EACH ROW EXECUTE FUNCTION regions_derive_fk_region_id();--> statement-breakpoint
CREATE TRIGGER verification_locations_region_fk_bi BEFORE INSERT ON verification_locations
  FOR EACH ROW EXECUTE FUNCTION regions_derive_fk_region_id();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5) CONTRACT-Schritt dieser Etappe: region_id NOT NULL (nach grünem Gate).
-- ---------------------------------------------------------------------------
ALTER TABLE "polls" ALTER COLUMN "region_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "qr_codes" ALTER COLUMN "region_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "region_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_locations" ALTER COLUMN "region_id" SET NOT NULL;
