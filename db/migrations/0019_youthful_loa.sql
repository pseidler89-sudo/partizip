CREATE TYPE "public"."verification_booking_status" AS ENUM('gebucht', 'wahrgenommen', 'storniert');--> statement-breakpoint
CREATE TABLE "verification_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" "verification_booking_status" DEFAULT 'gebucht' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_bookings_tenant_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
ALTER TABLE "verification_bookings" ADD CONSTRAINT "verification_bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_bookings" ADD CONSTRAINT "verification_bookings_slot_id_verification_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."verification_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_bookings" ADD CONSTRAINT "verification_bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_bookings_one_open_per_user" ON "verification_bookings" USING btree ("tenant_id","user_id") WHERE status = 'gebucht';--> statement-breakpoint
CREATE INDEX "idx_verification_bookings_slot" ON "verification_bookings" USING btree ("slot_id");