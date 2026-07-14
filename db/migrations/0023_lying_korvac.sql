-- ADR-024 / GEBIETSMODELL §3.1: ltree-Extension muss vor der regions-Tabelle
-- existieren (Spalte "path" ltree). Contrib-Extension, in PG16 vorhanden.
-- Ops-Hinweis: benötigt einmalig CREATE EXTENSION-Recht auf dem Produktivserver.
CREATE EXTENSION IF NOT EXISTS ltree;--> statement-breakpoint
CREATE TYPE "public"."region_typ" AS ENUM('bund', 'land', 'kreis', 'gemeinde', 'ortsteil');--> statement-breakpoint
CREATE TABLE "plz_regions" (
	"plz" text NOT NULL,
	"region_id" uuid NOT NULL,
	"weight" numeric,
	"is_primary" boolean DEFAULT false NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plz_regions_plz_region_id_pk" PRIMARY KEY("plz","region_id")
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"typ" "region_typ" NOT NULL,
	"ags" text,
	"ars" text,
	"name" text NOT NULL,
	"path_label" text NOT NULL,
	"path" "ltree",
	"tenant_id" uuid,
	"lat" numeric,
	"lon" numeric,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regions_parent_name_unique" UNIQUE NULLS NOT DISTINCT("parent_id","name"),
	CONSTRAINT "regions_parent_label_unique" UNIQUE NULLS NOT DISTINCT("parent_id","path_label"),
	CONSTRAINT "regions_root_is_bund" CHECK (("regions"."typ" = 'bund') = ("regions"."parent_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "home_region_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "residency_region_id" uuid;--> statement-breakpoint
ALTER TABLE "plz_regions" ADD CONSTRAINT "plz_regions_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_parent_id_regions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plz_regions_plz" ON "plz_regions" USING btree ("plz");--> statement-breakpoint
CREATE INDEX "idx_plz_regions_region_id" ON "plz_regions" USING btree ("region_id");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_ars_unique" ON "regions" USING btree ("ars") WHERE "regions"."ars" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_regions_parent_id" ON "regions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_regions_tenant_id" ON "regions" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_home_region_id_regions_id_fk" FOREIGN KEY ("home_region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_residency_region_id_regions_id_fk" FOREIGN KEY ("residency_region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- ADR-024 / GEBIETSMODELL §3.1 — rohes SQL, das drizzle-kit nicht abdeckt:
-- path_label-Format, genau-eine-Wurzel, GiST-Index auf path, der path-pflegende
-- Trigger (Insert + Move inkl. Zyklus-Abwehr + Nachfahren-Kaskade) und
-- NOT NULL auf path. Rein additiv, Tabelle leer.
-- ===========================================================================

-- ltree-sicheres Label (ein Pfad-Segment).
ALTER TABLE "regions" ADD CONSTRAINT "regions_path_label_format" CHECK ("path_label" ~ '^[a-z0-9_]+$');--> statement-breakpoint

-- Genau EINE Wurzel: höchstens ein Knoten mit parent_id IS NULL (der Bund).
CREATE UNIQUE INDEX "regions_single_root" ON "regions" ((true)) WHERE "parent_id" IS NULL;--> statement-breakpoint

-- Kern der O(1)-Vorfahren/Nachfahren-Queries (@> / <@).
CREATE INDEX "idx_regions_path_gist" ON "regions" USING gist ("path");--> statement-breakpoint

-- path aus parent_id + path_label ableiten (BEFORE INSERT/UPDATE). Nie von Hand.
-- ZYKLUS-ABWEHR (MAJOR-Fix): Beim Umhängen darf ein Knoten nicht unter sich
-- selbst oder einen seiner eigenen Nachfahren gehängt werden — sonst triebe die
-- Kaskade den Pfad unbegrenzt in die Länge (OOM/DB-Recovery). Ist der neue
-- Elternpfad `<@` dem eigenen (alten) Pfad, wird sauber abgewiesen.
CREATE OR REPLACE FUNCTION regions_compute_path() RETURNS trigger AS $$
DECLARE
  parent_path ltree;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := text2ltree(NEW.path_label);
  ELSE
    SELECT path INTO parent_path FROM regions WHERE id = NEW.parent_id;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'regions.path: Elternknoten % hat keinen Pfad (oder existiert nicht)', NEW.parent_id;
    END IF;
    IF TG_OP = 'UPDATE' AND parent_path <@ OLD.path THEN
      RAISE EXCEPTION 'regions.path: Zyklus — Knoten % darf nicht unter seinen eigenen Nachfahren (%) gehaengt werden', NEW.id, NEW.parent_id;
    END IF;
    NEW.path := parent_path || text2ltree(NEW.path_label);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER regions_compute_path_biu
  BEFORE INSERT OR UPDATE OF parent_id, path_label ON regions
  FOR EACH ROW EXECUTE FUNCTION regions_compute_path();--> statement-breakpoint

-- Bewegt sich ein Knoten (path ändert sich), ziehen die Nachfahren nach: ein
-- No-op-UPDATE auf path_label der direkten Kinder triggert deren BEFORE-Neuberechnung,
-- die sich rekursiv nach unten fortsetzt (Abbruch, sobald sich nichts mehr ändert).
-- Da die Zyklus-Abwehr im BEFORE-Trigger einen Zyklus VOR jeder Kaskade abweist,
-- terminiert die Rekursion immer (streng wachsende bzw. konstante Pfadmenge).
CREATE OR REPLACE FUNCTION regions_cascade_path() RETURNS trigger AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path THEN
    UPDATE regions SET path_label = path_label WHERE parent_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER regions_cascade_path_au
  AFTER UPDATE ON regions
  FOR EACH ROW EXECUTE FUNCTION regions_cascade_path();--> statement-breakpoint

-- path ist ab jetzt Trigger-gepflegt und pflichtig (Tabelle leer → sicher).
ALTER TABLE "regions" ALTER COLUMN "path" SET NOT NULL;