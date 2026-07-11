# ADR-003 — Rechtekonzept v1 gegen Kommune-Kontext gechallenged

**Datum:** 2026-06-10 · **Status:** Entschieden (Projektleiter) · **Gate B:** Implementierung reviewpflichtig

**Kontext:** Das Rechtekonzept v1 (Planning-Stand: Rollen `user/verifier/
local_admin/district_admin/state_admin/federal_admin/super_admin`, Scopes
`local/district/state/federal`, Eligibility-Pipeline aus
`AUTH_ELIGIBILITY_MIDDLEWARE.md`) entstand im Partei-Kontext.

**Challenge-Ergebnis für Tenant = Kommune:**

1. **Scope-Mapping neu (Konzept Kap. 8):** `local` = Ortsteil, `district` =
   Stadt/Gemeinde, `state` = Kreis, `federal` = Land. Benennung im Code
   entsprechend prüfen/anpassen.
2. **Rollen im Pilot real vergeben:** `user`, `verifier`
   (Verifizierungs-Sprechstunde), `kommune_admin` (Scope Stadt/Gemeinde),
   `super_admin` (Plattformbetreiber, Remote-Override auditiert +
   begründungspflichtig). Die übrigen Admin-Stufen bleiben im Enum angelegt,
   werden aber im Pilot nicht vergeben (Skalierungsreserve, kein UI dafür).
3. **Eligibility-Pipeline übernommen mit Deltas:** `ACCOUNT_INACTIVE`
   (Partei-/Mitgliedsstatus) **entfällt**; `require_party_member` **entfällt
   ersatzlos**; statt `plz_prefix_whitelist` gelten Wohnsitz-/Ortsteil-Regeln
   (`residency_verified_at`, `ortsteil_code`); Altersregel über konservatives
   `is_adult`-Flag (birth_year + birth_month, Konzept Kap. 6). Fehlercodes und
   Reihenfolge (401 → 403 Tenant → 403 NOT_VERIFIED → 404/409 Poll → 403
   NOT_ELIGIBLE → 409 ALREADY_VOTED) bleiben.
4. **Stufenmodell statt binärem verified:** Verifikationsstufen 0–3 (Konzept
   Kap. 5). `verification_status=verified` der Alt-Spec entspricht Stufe 2
   (Wohnsitz). Anliegen melden erfordert nur Stufe 1 (Magic Link), Abstimmen
   Stufe 2 — das Rechtekonzept muss Stufen, nicht nur Status kennen.
5. **`party_member_status` wird deprecated** (nicht gedroppt; Migration
   dokumentieren, Konzept Kap. 6).

**Konsequenz:** Auth-, Tenant-Isolations- und Eligibility-Implementierung
ausnahmslos unter Gate B (Second-Agent-Review).
