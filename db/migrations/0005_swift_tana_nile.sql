CREATE TABLE "rate_limit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_rate_limit_events_scope_key_created" ON "rate_limit_events" USING btree ("scope","key_hash","created_at");--> statement-breakpoint
CREATE INDEX "idx_auth_tokens_expires_at" ON "auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires_at" ON "sessions" USING btree ("expires_at");