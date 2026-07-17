ALTER TYPE "public"."poll_type" ADD VALUE 'widerstandsabfrage';--> statement-breakpoint
CREATE TABLE "vote_resistances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"voter_ref" text NOT NULL,
	"wert" integer NOT NULL,
	"war_verifiziert" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vote_resistances_poll_voter_option_unique" UNIQUE("poll_id","voter_ref","option_id"),
	CONSTRAINT "vote_resistances_wert_bereich" CHECK ("vote_resistances"."wert" >= 0 AND "vote_resistances"."wert" <= 10)
);
--> statement-breakpoint
ALTER TABLE "vote_resistances" ADD CONSTRAINT "vote_resistances_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_resistances" ADD CONSTRAINT "vote_resistances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_resistances" ADD CONSTRAINT "vote_resistances_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vote_resistances_poll" ON "vote_resistances" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "idx_vote_resistances_tenant_poll" ON "vote_resistances" USING btree ("tenant_id","poll_id");--> statement-breakpoint
CREATE INDEX "idx_vote_resistances_tenant_voter" ON "vote_resistances" USING btree ("tenant_id","voter_ref");