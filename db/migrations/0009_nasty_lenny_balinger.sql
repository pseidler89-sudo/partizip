ALTER TABLE "digest_statements" ADD COLUMN "geprueft_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_statements" ADD COLUMN "ist_highlight" boolean DEFAULT false NOT NULL;