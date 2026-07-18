ALTER TYPE "public"."poll_status" ADD VALUE 'in_pruefung';--> statement-breakpoint
CREATE TABLE "ki_pruefungen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"poll_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"begruendung" text NOT NULL,
	"verletzte_regel" text,
	"prompt_version" text NOT NULL,
	"modell" text NOT NULL,
	"geprueft_von" uuid,
	"ist_override" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ki_pruefungen_verdict_check" CHECK ("ki_pruefungen"."verdict" IN ('neutral', 'angehalten'))
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ki_neutralitaets_pflicht" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ki_pruefungen" ADD CONSTRAINT "ki_pruefungen_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ki_pruefungen" ADD CONSTRAINT "ki_pruefungen_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ki_pruefungen" ADD CONSTRAINT "ki_pruefungen_geprueft_von_users_id_fk" FOREIGN KEY ("geprueft_von") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ki_pruefungen_tenant_poll" ON "ki_pruefungen" USING btree ("tenant_id","poll_id");--> statement-breakpoint
CREATE INDEX "idx_ki_pruefungen_tenant_created" ON "ki_pruefungen" USING btree ("tenant_id","created_at" DESC NULLS LAST);