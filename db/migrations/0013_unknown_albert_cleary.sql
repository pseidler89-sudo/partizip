ALTER TYPE "public"."verification_method" ADD VALUE 'qr';--> statement-breakpoint
CREATE TABLE "qr_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_level" "scope_level" NOT NULL,
	"scope_code" text,
	"token_hash" text NOT NULL,
	"label" text,
	"max_redemptions" integer NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qr_codes_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "qr_codes_max_redemptions_check" CHECK ("qr_codes"."max_redemptions" >= 1),
	CONSTRAINT "qr_codes_redemption_count_check" CHECK ("qr_codes"."redemption_count" >= 0 AND "qr_codes"."redemption_count" <= "qr_codes"."max_redemptions")
);
--> statement-breakpoint
CREATE TABLE "qr_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qr_code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qr_redemptions_qr_user_unique" UNIQUE("qr_code_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "residency_verified_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_redemptions" ADD CONSTRAINT "qr_redemptions_qr_code_id_qr_codes_id_fk" FOREIGN KEY ("qr_code_id") REFERENCES "public"."qr_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_redemptions" ADD CONSTRAINT "qr_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_redemptions" ADD CONSTRAINT "qr_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_qr_codes_tenant_id" ON "qr_codes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_qr_redemptions_qr_code_id" ON "qr_redemptions" USING btree ("qr_code_id");