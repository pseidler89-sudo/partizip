ALTER TYPE "public"."verification_method" ADD VALUE 'qr_konto';--> statement-breakpoint
CREATE TABLE "verification_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_proofs_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "verification_proofs" ADD CONSTRAINT "verification_proofs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_proofs" ADD CONSTRAINT "verification_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_proofs" ADD CONSTRAINT "verification_proofs_consumed_by_users_id_fk" FOREIGN KEY ("consumed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_verification_proofs_tenant_user" ON "verification_proofs" USING btree ("tenant_id","user_id");