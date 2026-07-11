CREATE TYPE "public"."digest_status" AS ENUM('entwurf', 'freigegeben', 'veroeffentlicht');--> statement-breakpoint
CREATE TABLE "digest_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"source_document_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	CONSTRAINT "digest_statements_digest_position_unique" UNIQUE("digest_id","position")
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "digest_status" DEFAULT 'entwurf' NOT NULL,
	"generator" text DEFAULT 'extractive_v1' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digests_meeting_id_unique" UNIQUE("meeting_id"),
	CONSTRAINT "digests_veroeffentlicht_requires_approved_at" CHECK ("digests"."status" != 'veroeffentlicht' OR ("digests"."approved_at" IS NOT NULL AND "digests"."published_at" IS NOT NULL)),
	CONSTRAINT "digests_freigegeben_requires_approved_at" CHECK (("digests"."status" != 'freigegeben' AND "digests"."status" != 'veroeffentlicht') OR "digests"."approved_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "ris_bodies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text,
	"ris_type" text NOT NULL,
	"base_url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ris_bodies_tenant_key_unique" UNIQUE("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "ris_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"external_id" text,
	"title" text,
	"body_text" text,
	"source_url" text NOT NULL,
	"content_hash" text,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ris_documents_meeting_type_ext_unique" UNIQUE("meeting_id","doc_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "ris_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"body_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"gremium" text,
	"title" text,
	"meeting_date" timestamp with time zone,
	"location" text,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"raw_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ris_meetings_body_external_unique" UNIQUE("body_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "digest_statements" ADD CONSTRAINT "digest_statements_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_statements" ADD CONSTRAINT "digest_statements_source_document_id_ris_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."ris_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_meeting_id_ris_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."ris_meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ris_bodies" ADD CONSTRAINT "ris_bodies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ris_documents" ADD CONSTRAINT "ris_documents_meeting_id_ris_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."ris_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ris_meetings" ADD CONSTRAINT "ris_meetings_body_id_ris_bodies_id_fk" FOREIGN KEY ("body_id") REFERENCES "public"."ris_bodies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_digests_tenant_status" ON "digests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_ris_documents_meeting_id" ON "ris_documents" USING btree ("meeting_id");