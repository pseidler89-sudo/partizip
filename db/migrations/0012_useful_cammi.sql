CREATE TYPE "public"."poll_status" AS ENUM('entwurf', 'aktiv', 'geschlossen');--> statement-breakpoint
CREATE TYPE "public"."poll_type" AS ENUM('ja_nein_enthaltung');--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_level" "scope_level" NOT NULL,
	"scope_code" text,
	"frage" text NOT NULL,
	"typ" "poll_type" DEFAULT 'ja_nein_enthaltung' NOT NULL,
	"status" "poll_status" DEFAULT 'entwurf' NOT NULL,
	"verbindlich" boolean DEFAULT false NOT NULL,
	"erstellt_von" uuid,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"voter_ref" text NOT NULL,
	"choice" text NOT NULL,
	"war_verifiziert" boolean DEFAULT false NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_poll_voter_unique" UNIQUE("poll_id","voter_ref"),
	CONSTRAINT "votes_choice_check" CHECK ("votes"."choice" IN ('ja', 'nein', 'enthaltung'))
);
--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_erstellt_von_users_id_fk" FOREIGN KEY ("erstellt_von") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_polls_tenant_status" ON "polls" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_votes_poll_id" ON "votes" USING btree ("poll_id");