-- Block J2a (Audit-Fund F-A): E-Mail-Fundament — Normalisierung + funktionaler
-- Unique-Index. users.email/auth_tokens.email werden auf die kanonische Form
-- (lower(btrim(...))) gebracht; der case-SENSITIVE Constraint weicht einem
-- funktionalen UNIQUE-Index auf (tenant_id, lower(email)). Zusätzlich zwei
-- additive, verhaltensneutrale Benachrichtigungs-Opt-outs (Vorgriff J2c).
--
-- Additiv + fail-closed. Reihenfolge ist bewusst: Wächter → Backfill → alten
-- Constraint droppen → funktionalen Index anlegen (erst NACH dem Backfill, sonst
-- scheiterte er an Case-Zwillingen) → neue Spalten. Muster: 0027 (Custom-Backfill).

-- 1) Kollisionswächter (fail-closed, PII-frei): existiert je (tenant_id,
--    lower(btrim(email))) mehr als eine users-Zeile, würde der Backfill zwei
--    Konten kollidieren lassen und der Unique-Index nicht anlegbar sein. Dann
--    ABBRUCH mit der ANZAHL der Kollisionsgruppen — NIE die Adressen selbst
--    (Migrations-Output landet in Logs). Betreiber löst manuell auf und
--    migriert erneut. Erwartung: 0 auf allen realen Tenants (Demo-Wegwerf-
--    Adressen sind generiert-lowercase).
DO $$
DECLARE
  kollisionsgruppen integer;
BEGIN
  SELECT count(*) INTO kollisionsgruppen
  FROM (
    SELECT tenant_id, lower(btrim(email)) AS norm_email
    FROM users
    GROUP BY tenant_id, lower(btrim(email))
    HAVING count(*) > 1
  ) AS kollisionen;

  IF kollisionsgruppen > 0 THEN
    RAISE EXCEPTION 'E-Mail-Normalisierung abgebrochen: % Kollisionsgruppe(n) mit mehr als einem Konto je (tenant_id, lower(email)). Bitte manuell auflösen, dann erneut migrieren.', kollisionsgruppen;
  END IF;
END $$;
--> statement-breakpoint

-- 2) Backfill auf die kanonische Form. auth_tokens ist kurzlebig, aber der
--    Verify-Pfad liest consumed.email → in-flight-Tokens über den Deploy hinweg
--    müssen den User weiterhin finden.
UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));--> statement-breakpoint
UPDATE "auth_tokens" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));--> statement-breakpoint

-- 3) Alten rohen, case-SENSITIVEN Unique-Constraint droppen (redundant zum
--    funktionalen Index; würde bei künftigen Kollisionen die falsche Diagnose
--    liefern).
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_email_unique";--> statement-breakpoint

-- 4) Funktionaler UNIQUE-Index — DB-seitiges Netz für die Kanonizität.
CREATE UNIQUE INDEX "users_tenant_email_lower_unique" ON "users" USING btree ("tenant_id",lower("email"));--> statement-breakpoint

-- 5) Benachrichtigungs-Opt-outs (additiv, verhaltensneutral; Versand-Logik/UI = J2c).
ALTER TABLE "users" ADD COLUMN "notify_anliegen_updates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_reverify" boolean DEFAULT true NOT NULL;
