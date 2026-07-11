CREATE TABLE "plz_regionen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plz" text NOT NULL,
	"ortsteil_code" text,
	"lat" numeric,
	"lon" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plz_regionen_plz_ortsteil_unique" UNIQUE NULLS NOT DISTINCT("plz","ortsteil_code")
);
--> statement-breakpoint
ALTER TABLE "plz_regionen" ADD CONSTRAINT "plz_regionen_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plz_regionen_plz" ON "plz_regionen" USING btree ("plz");--> statement-breakpoint
CREATE INDEX "idx_plz_regionen_tenant_id" ON "plz_regionen" USING btree ("tenant_id");