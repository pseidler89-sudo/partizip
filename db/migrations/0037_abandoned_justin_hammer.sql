ALTER TABLE "verification_locations" ADD COLUMN "oeffnungszeiten" jsonb;--> statement-breakpoint
ALTER TABLE "verification_locations" ADD COLUMN "termin_erforderlich" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_locations" ADD COLUMN "barrierefrei" boolean;--> statement-breakpoint
ALTER TABLE "verification_locations" ADD COLUMN "kontakt" text;