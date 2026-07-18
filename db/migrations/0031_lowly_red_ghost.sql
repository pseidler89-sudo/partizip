CREATE TYPE "public"."role_appointment_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "role_appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"role_type" "role_type" NOT NULL,
	"region_id" uuid NOT NULL,
	"status" "role_appointment_status" DEFAULT 'pending' NOT NULL,
	"proposed_by" uuid,
	"decided_by" uuid,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_appointments" ADD CONSTRAINT "role_appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_appointments" ADD CONSTRAINT "role_appointments_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_appointments" ADD CONSTRAINT "role_appointments_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_appointments" ADD CONSTRAINT "role_appointments_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_appointments" ADD CONSTRAINT "role_appointments_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_appointments_pending_unique" ON "role_appointments" USING btree ("tenant_id","target_user_id","role_type","region_id") WHERE "role_appointments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_role_appointments_tenant_status" ON "role_appointments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_role_appointments_target_user" ON "role_appointments" USING btree ("target_user_id");