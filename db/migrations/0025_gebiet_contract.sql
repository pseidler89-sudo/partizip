-- ADR-024 / GEBIETSMODELL §4 Schritt 4 (CONTRACT): scope_level/scope_code +
-- scopeLevelEnum VOLLSTÄNDIG entfernen. Nach Etappe 2 tragen polls/roles/qr_codes
-- (und die aufgeschobene Rolle: invitations) BEIDES — den alten Enum-Scope als
-- Schatten UND region_id (Baum). Lese-/Schreibpfade der App nutzen bereits
-- ausschließlich region_id. Dieser Schnitt zieht den Schatten weg.
--
-- Reihenfolge (sicher, region_id ist bereits NOT NULL aus 0024 auf den vier Etappe-2-
-- Tabellen; verification_locations trug nie einen scope_level):
--   1) invitations bekommt region_id (additiv, nullable) → Backfill (streng) → Gate
--      → NOT NULL. Damit ist die Einladung eine vollwertige aufgeschobene Rolle.
--   2) roles-UNIQUE von (tenant,user,role_type,scope_level,scope_code) auf
--      (tenant,user,role_type,region_id) umstellen — ERST neuen Constraint anlegen,
--      DANN alten droppen (kein Fenster ohne Eindeutigkeits-Schutz).
--   3) Die Dual-Write-BEFORE-INSERT-Trigger für polls/roles/qr_codes entfernen (sie
--      lesen NEW.scope_level; nach dem Spalten-Drop wären sie kaputt). Der
--      verification_locations-Trigger BLEIBT (er nutzt die 'stadt'-Konstante, kein
--      scope_level) und füllt region_id für Seeds/direkte Standort-Inserts weiter.
--   4) scope_level/scope_code auf polls/roles/qr_codes/invitations droppen.
--   5) DB-Enum scope_level droppen (jetzt referenzfrei).
--
-- Rückrollbarkeit: Schritt 4/5 sind der eigentliche, bewusst nicht-triviale Schnitt
-- (GEBIETSMODELL §4). Schritt 1 ist additiv/rückrollbar bis zum Drop. Der Backfill
-- ist deterministisch (regions_resolve_region_id, provision=false → deckt ALLES ab
-- oder bricht hart ab) — dieselbe Ableitung wie 0024 für die anderen Fachtabellen.

-- ---------------------------------------------------------------------------
-- 1) invitations.region_id: additiv (nullable) + FK + Index.
-- ---------------------------------------------------------------------------
ALTER TABLE "invitations" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invitations_region_id" ON "invitations" USING btree ("region_id");--> statement-breakpoint

-- Backfill der Bestands-Einladungen aus (tenant, scope_level, scope_code) über den
-- Baum — strikt (provision=false): fehlt ein Knoten, bricht die Migration hart ab
-- (kein stilles NULL). Idempotent über WHERE region_id IS NULL.
UPDATE "invitations" SET region_id = regions_resolve_region_id(tenant_id, scope_level::text, scope_code, false) WHERE region_id IS NULL;--> statement-breakpoint

-- Verifikations-Gate vor dem NOT-NULL/Contract (§4): 0 NULL auf invitations.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM invitations WHERE region_id IS NULL) THEN
    RAISE EXCEPTION 'invitations.region_id-Backfill unvollständig: es verbleiben NULL (Gebietsbaum unvollständig geseedet?)';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "invitations" ALTER COLUMN "region_id" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2) roles-UNIQUE auf region_id umstellen (erst neu, dann alt droppen).
--    region_id ist NOT NULL (0024) → kein nullsNotDistinct mehr nötig.
-- ---------------------------------------------------------------------------
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_user_role_region_unique" UNIQUE("tenant_id","user_id","role_type","region_id");--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_tenant_user_role_scope_unique";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3) Dual-Write-Trigger für polls/roles/qr_codes entfernen (lesen NEW.scope_level).
--    verification_locations-Trigger BLEIBT — die derive-Funktion wird neu definiert,
--    sodass sie NUR noch den Gemeinde-Knoten ('stadt') ableitet und scope_level
--    NICHT mehr referenziert (sonst bräche sie beim Spalten-Drop syntaktisch nie,
--    aber wir halten die Funktion sauber referenzfrei).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "polls_region_fk_bi" ON "polls";--> statement-breakpoint
DROP TRIGGER IF EXISTS "roles_region_fk_bi" ON "roles";--> statement-breakpoint
DROP TRIGGER IF EXISTS "qr_codes_region_fk_bi" ON "qr_codes";--> statement-breakpoint

CREATE OR REPLACE FUNCTION regions_derive_fk_region_id() RETURNS trigger AS $$
BEGIN
  -- Nur noch verification_locations: der Standort gehört zur Kommune → Gemeinde-
  -- Knoten des Tenants. Kein scope_level-Bezug mehr (ADR-024 contract).
  IF NEW.region_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  NEW.region_id := regions_resolve_region_id(NEW.tenant_id, 'stadt', NULL, true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4) scope_level/scope_code droppen (polls, roles, qr_codes, invitations).
-- ---------------------------------------------------------------------------
ALTER TABLE "polls" DROP COLUMN "scope_level";--> statement-breakpoint
ALTER TABLE "polls" DROP COLUMN "scope_code";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "scope_level";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "scope_code";--> statement-breakpoint
ALTER TABLE "qr_codes" DROP COLUMN "scope_level";--> statement-breakpoint
ALTER TABLE "qr_codes" DROP COLUMN "scope_code";--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "scope_level";--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "scope_code";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5) DB-Enum scope_level droppen (jetzt referenzfrei).
-- ---------------------------------------------------------------------------
DROP TYPE "public"."scope_level";
