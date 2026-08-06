-- Block #59 — Kulanzfrist für die Zwei-Faktor-Pflicht: einmaliger Backfill.
--
-- WARUM ALS DATEN-MIGRATION UND NICHT ZUR LAUFZEIT:
-- Die Frist ist ein Migrationszustand, keine Eigenschaft eines Kontos. Zuerst
-- war sie so gebaut, dass die Anwendung sie beim ersten Admin-Zugriff setzt.
-- Gate-B hat zwei Löcher darin gefunden:
--   1. Jedes NEU ernannte Admin-Konto hätte dauerhaft 14 Tage ohne zweiten
--      Faktor bekommen — und ein Admin hätte sich diese Frist über ein weiteres
--      Konto beliebig oft verlängern können.
--   2. Wer nur Server Actions aufruft und nie eine /admin-Seite lädt, wäre nie
--      an der setzenden Stelle vorbeigekommen und damit dauerhaft befreit
--      gewesen.
-- Deshalb: Die zum Rollout vorhandenen Admins bekommen hier ihre Frist, und
-- `totp_grace_until IS NULL` bedeutet in der Anwendung ab sofort KEINE Kulanz.
--
-- LÄUFT GEGEN ALLE TENANTS, nicht nur den Piloten: Die Auswahl kommt aus der
-- roles-Tabelle ohne Tenant-Einschränkung.
--
-- SELBST-AUSREICHEND: Gibt es (noch) keine Admin-Konten, trifft das UPDATE
-- null Zeilen und läuft trotzdem durch. Der WHERE-Zusatz auf
-- `totp_grace_until IS NULL` macht die Migration wiederholbar, ohne eine
-- bereits laufende Frist zu verlängern.

UPDATE "users"
SET "totp_grace_until" = now() + interval '14 days'
WHERE "totp_grace_until" IS NULL
  AND "totp_confirmed_at" IS NULL
  AND "account_status" = 'active'
  AND "id" IN (
    SELECT "user_id" FROM "roles"
    WHERE "role_type" IN ('kommune_admin', 'super_admin')
  );
