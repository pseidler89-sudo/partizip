-- Block J2b (E-Mail-Adresse ändern): additive, nullable user_id-Spalte auf
-- auth_tokens. Nur vom purpose 'email_change' gesetzt (der anfordernde User);
-- Login-/Hint-Tokens lassen sie NULL — daher KEIN Backfill nötig. FK ON DELETE
-- CASCADE: ein echtes users-DELETE (z. B. Tenant-Teardown) reißt offene
-- Änderungs-Tokens mit (DSGVO-sauber). Die Produkt-Löschung (lib/konto/delete.ts)
-- anonymisiert die users-Zeile statt sie zu löschen → die Kaskade feuert dort
-- nicht; delete.ts räumt die Tokens weiterhin per (tenant_id,email) ab. Rein
-- additiv, kein Index-Umbau → App-Stopp während der Migration nicht nötig.
ALTER TABLE "auth_tokens" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;