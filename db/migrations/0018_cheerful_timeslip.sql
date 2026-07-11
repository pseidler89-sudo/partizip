CREATE TABLE "vote_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	CONSTRAINT "vote_receipts_poll_code_unique" UNIQUE("poll_id","code")
);
--> statement-breakpoint
ALTER TABLE "vote_receipts" ADD CONSTRAINT "vote_receipts_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_receipts" ADD CONSTRAINT "vote_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;