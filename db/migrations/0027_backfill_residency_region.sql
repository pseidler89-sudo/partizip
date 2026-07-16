-- Audit M3: Backfill des verifizierten Wohnsitz-Knotens (residency_region_id).
-- grantResidency setzte residency_region_id bisher nie → alle Bestands-
-- Verifizierten haben NULL. Wir leiten den Knoten aus der jüngsten realen
-- Verifizierungs-Spur ab (QR-Einlösung bzw. wahrgenommener Termin) und setzen
-- home_region_id nur, wo noch keiner gewählt ist (COALESCE). Nur Zeilen mit
-- vorhandener Spur werden getroffen; ohne Spur bleibt NULL (kein Rateschluss).
-- Idempotent: nur residency_region_id IS NULL wird angefasst.

-- 1) QR-basiert: jüngste Einlösung je User → region_id des QR-Codes.
WITH letzte_qr AS (
  SELECT DISTINCT ON (r.user_id)
         r.user_id, r.tenant_id, q.region_id
  FROM qr_redemptions r
  JOIN qr_codes q ON q.id = r.qr_code_id AND q.tenant_id = r.tenant_id
  ORDER BY r.user_id, r.redeemed_at DESC
)
UPDATE users u
SET residency_region_id = lq.region_id,
    home_region_id = COALESCE(u.home_region_id, lq.region_id)
FROM letzte_qr lq
WHERE u.id = lq.user_id
  AND u.tenant_id = lq.tenant_id
  AND u.residency_verified_at IS NOT NULL
  AND u.residency_region_id IS NULL
  AND lq.region_id IS NOT NULL;

-- 2) Termin-basiert (für die restlichen): jüngster wahrgenommener Termin →
--    region_id des Verifizierungs-Standorts (location.region_id ist nullable).
WITH letzter_termin AS (
  SELECT DISTINCT ON (b.user_id)
         b.user_id, b.tenant_id, l.region_id
  FROM verification_bookings b
  JOIN verification_slots s ON s.id = b.slot_id
  JOIN verification_locations l ON l.id = s.location_id
  WHERE b.status = 'wahrgenommen'
    AND l.region_id IS NOT NULL
  ORDER BY b.user_id, b.updated_at DESC
)
UPDATE users u
SET residency_region_id = lt.region_id,
    home_region_id = COALESCE(u.home_region_id, lt.region_id)
FROM letzter_termin lt
WHERE u.id = lt.user_id
  AND u.tenant_id = lt.tenant_id
  AND u.residency_verified_at IS NOT NULL
  AND u.residency_region_id IS NULL
  AND lt.region_id IS NOT NULL;
