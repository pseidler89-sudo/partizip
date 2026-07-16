-- Audit 2026-07-16 M1 (Wahlgeheimnis): votes.ip_hash war über denselben Salt
-- mit dem userId-tragenden Auth-Audit-ip_hash korrelierbar → Deanonymisierungs-
-- Brücke Person↔choice für DB-Insider. Die Spalte wird fürs Rate-Limiting nicht
-- gebraucht (separate rateLimitEvents) und ersatzlos entfernt (Bestandswerte weg).
ALTER TABLE "votes" DROP COLUMN "ip_hash";