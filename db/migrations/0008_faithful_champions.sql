CREATE TYPE "public"."match_status" AS ENUM('vorgeschlagen', 'bestaetigt', 'verworfen');--> statement-breakpoint
CREATE TABLE "anliegen_followers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anliegen_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anliegen_followers_anliegen_user_unique" UNIQUE("anliegen_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "anliegen_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anliegen_id" uuid NOT NULL,
	"ris_document_id" uuid NOT NULL,
	"confidence" numeric NOT NULL,
	"status" "match_status" DEFAULT 'vorgeschlagen' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anliegen_matches_anliegen_doc_unique" UNIQUE("anliegen_id","ris_document_id"),
	CONSTRAINT "anliegen_matches_decided_at_check" CHECK (("anliegen_matches"."status" = 'vorgeschlagen') OR ("anliegen_matches"."decided_at" IS NOT NULL)),
	CONSTRAINT "anliegen_matches_confidence_check" CHECK ("anliegen_matches"."confidence" >= 0 AND "anliegen_matches"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "anliegen_followers" ADD CONSTRAINT "anliegen_followers_anliegen_id_anliegen_id_fk" FOREIGN KEY ("anliegen_id") REFERENCES "public"."anliegen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anliegen_followers" ADD CONSTRAINT "anliegen_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anliegen_matches" ADD CONSTRAINT "anliegen_matches_anliegen_id_anliegen_id_fk" FOREIGN KEY ("anliegen_id") REFERENCES "public"."anliegen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anliegen_matches" ADD CONSTRAINT "anliegen_matches_ris_document_id_ris_documents_id_fk" FOREIGN KEY ("ris_document_id") REFERENCES "public"."ris_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anliegen_matches" ADD CONSTRAINT "anliegen_matches_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_anliegen_followers_user_id" ON "anliegen_followers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_anliegen_matches_anliegen_status" ON "anliegen_matches" USING btree ("anliegen_id","status");