CREATE INDEX "idx_votes_tenant_poll" ON "votes" USING btree ("tenant_id","poll_id");--> statement-breakpoint
CREATE INDEX "idx_votes_tenant_voter" ON "votes" USING btree ("tenant_id","voter_ref");