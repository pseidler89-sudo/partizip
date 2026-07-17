ALTER TYPE "public"."poll_type" ADD VALUE 'dot_voting';--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_options_poll_position_unique" UNIQUE("poll_id","position")
);
--> statement-breakpoint
CREATE TABLE "vote_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"voter_ref" text NOT NULL,
	"punkte" integer NOT NULL,
	"war_verifiziert" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vote_allocations_poll_voter_option_unique" UNIQUE("poll_id","voter_ref","option_id"),
	CONSTRAINT "vote_allocations_punkte_positiv" CHECK ("vote_allocations"."punkte" > 0)
);
--> statement-breakpoint
ALTER TABLE "polls" ADD COLUMN "punkte_budget" integer;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_allocations" ADD CONSTRAINT "vote_allocations_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_allocations" ADD CONSTRAINT "vote_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_allocations" ADD CONSTRAINT "vote_allocations_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_poll_options_poll_id" ON "poll_options" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "idx_poll_options_tenant_poll" ON "poll_options" USING btree ("tenant_id","poll_id");--> statement-breakpoint
CREATE INDEX "idx_vote_allocations_poll" ON "vote_allocations" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "idx_vote_allocations_tenant_poll" ON "vote_allocations" USING btree ("tenant_id","poll_id");--> statement-breakpoint
CREATE INDEX "idx_vote_allocations_tenant_voter" ON "vote_allocations" USING btree ("tenant_id","voter_ref");