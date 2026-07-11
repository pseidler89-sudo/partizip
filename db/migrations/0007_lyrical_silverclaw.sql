ALTER TABLE "ris_documents" DROP CONSTRAINT "ris_documents_meeting_type_ext_unique";--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "approved_content_hash" text;--> statement-breakpoint
CREATE INDEX "idx_digests_tenant_status_published" ON "digests" USING btree ("tenant_id","status","published_at");--> statement-breakpoint
ALTER TABLE "ris_documents" ADD CONSTRAINT "ris_documents_meeting_type_ext_unique" UNIQUE NULLS NOT DISTINCT("meeting_id","doc_type","external_id");