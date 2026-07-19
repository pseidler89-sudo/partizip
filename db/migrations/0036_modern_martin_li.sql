CREATE TYPE "public"."interessent_status" AS ENUM('neu', 'kontaktiert', 'pilot', 'abgelehnt');--> statement-breakpoint
CREATE TABLE "interessenten" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kommune" text,
	"ansprechpartner" text NOT NULL,
	"email" text NOT NULL,
	"rolle" text,
	"groesse" text,
	"nachricht" text,
	"quelle" text NOT NULL,
	"tymeslot_meeting_uid" text,
	"termin_am" timestamp with time zone,
	"status" "interessent_status" DEFAULT 'neu' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_interessenten_created_at" ON "interessenten" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "interessenten_tymeslot_uid_unique" ON "interessenten" USING btree ("tymeslot_meeting_uid") WHERE "interessenten"."tymeslot_meeting_uid" IS NOT NULL;