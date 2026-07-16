-- Audit M6: höchstens EIN Gemeinde-Knoten je Tenant (struktureller Schutz gegen
-- den stillen Doppel-Gemeinde-Knoten aus einer regionen.json-Label/Name-Änderung).
-- Voraussetzung: kein Tenant hat heute >1 Gemeinde-Knoten. Falls doch, schlägt
-- CREATE UNIQUE INDEX bewusst fehl (fail-closed) — dann zuerst die Duplikate
-- bereinigen. Prod/Staging haben verifiziert genau 1 Gemeinde-Knoten je Tenant.
CREATE UNIQUE INDEX "regions_one_gemeinde_per_tenant" ON "regions" USING btree ("tenant_id") WHERE "regions"."typ" = 'gemeinde' AND "regions"."tenant_id" IS NOT NULL;