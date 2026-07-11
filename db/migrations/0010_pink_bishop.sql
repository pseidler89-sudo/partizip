ALTER TYPE "public"."anliegen_status" ADD VALUE 'zurueckgezogen';--> statement-breakpoint
ALTER TYPE "public"."role_type" ADD VALUE 'redakteur' BEFORE 'ortsteil_admin';--> statement-breakpoint
ALTER TABLE "anliegen" ADD COLUMN "verborgen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "anliegen" ADD COLUMN "verborgen_grund" text;--> statement-breakpoint
ALTER TABLE "digest_statements" ADD COLUMN "geprueft_by" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "vier_augen_pflicht" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_statements" ADD CONSTRAINT "digest_statements_geprueft_by_users_id_fk" FOREIGN KEY ("geprueft_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;