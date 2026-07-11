CREATE TYPE "public"."account_status" AS ENUM('active', 'locked', 'deleted');--> statement-breakpoint
ALTER TABLE "anliegen_events" DROP CONSTRAINT "anliegen_events_anliegen_status_notiz_unique";--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_tenant_user_role_scope_unique";--> statement-breakpoint
ALTER TABLE "anliegen" DROP CONSTRAINT "anliegen_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "ortsteile" DROP CONSTRAINT "ortsteile_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_locations" DROP CONSTRAINT "verification_locations_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "account_status" SET DEFAULT 'active'::"public"."account_status";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "account_status" SET DATA TYPE "public"."account_status" USING "account_status"::"public"."account_status";--> statement-breakpoint
ALTER TABLE "anliegen" ADD CONSTRAINT "anliegen_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ortsteile" ADD CONSTRAINT "ortsteile_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_locations" ADD CONSTRAINT "verification_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_anliegen_tenant_status" ON "anliegen" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_anliegen_events_anliegen_id" ON "anliegen_events" USING btree ("anliegen_id");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_user_role_scope_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","user_id","role_type","scope_level","scope_code");--> statement-breakpoint
ALTER TABLE "verification_slots" ADD CONSTRAINT "verification_slots_booked_count_check" CHECK ("verification_slots"."booked_count" >= 0 AND "verification_slots"."booked_count" <= "verification_slots"."capacity");