-- Daten-Migration (H1, Gate-B MAJOR-1): geprueft_by wurde erst in 0010 eingeführt.
-- Aussagen, die zwischen 0009 (geprueft_at) und 0010 (geprueft_by) als geprüft
-- markiert wurden, haben geprueft_at IS NOT NULL aber geprueft_by IS NULL.
-- Das hebelt das Vier-Augen-Prinzip NICHT aus (solche Aussagen gelten als
-- ungeprüft), würde bei aktivem Toggle aber zu verwirrenden Fehlablehnungen führen.
--
-- Fix: Nur bei Digests im Status 'entwurf' die Prüf-Markierung zurücksetzen, damit
-- die Prüfung mit erfasstem Prüfer (geprueft_by) wiederholt wird. Bereits
-- freigegebene/veröffentlichte Digests bleiben UNANGETASTET (historischer Stand).
UPDATE digest_statements
SET geprueft_at = NULL
WHERE geprueft_at IS NOT NULL
  AND geprueft_by IS NULL
  AND digest_id IN (SELECT id FROM digests WHERE status = 'entwurf');
