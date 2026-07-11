# ADR-012: Redakteur-Rolle & Vier-Augen-Schiene für Digest-Freigaben

**Status:** akzeptiert · **Datum:** 2026-06-13 · **Bezug:** Architektur-Review
(H1), Entscheidung Patrick 2026-06-12, Konzept Kap. 10.2

## Kontext

Im Pilot prüft, gibt frei und veröffentlicht **eine** Person (Patrick) jeden
Digest. Echtes Vier-Augen (Freigeber ≠ Bearbeiter) lässt sich nicht erzwingen,
solange es nur eine bedienende Person gibt — ein vorgetäuschtes Vier-Augen würde
kein Vertrauen schaffen. Gleichzeitig soll die Skalierung (Kommune 2…N) nicht an
einer Ein-Personen-Redaktion ersticken.

## Entscheidung

1. **Neue Rolle `redakteur`** (zwischen `user` und Admin): darf Digests
   **bearbeiten und quellen-prüfen** (`setStatementGeprueft`,
   `setAlleStatementsGeprueft`, `setStatementHighlight`, Detail-/Listenansicht),
   **aber nicht freigeben/veröffentlichen**. Freigabe bleibt `kommune_admin`/
   `super_admin` vorbehalten.
2. **`geprueft_by` je Aussage erfassen** (wer hat geprüft). `freigegeben_by`
   existiert bereits als `digests.approved_by`.
3. **Tenant-Toggle `vier_augen_pflicht`** (Default **false** im Pilot): ist er
   aktiv, lehnt die Freigabe ab, wenn der Freigeber selbst Aussagen geprüft hat
   oder eine Aussage keinen erfassten Prüfer hat (Freigeber ≠ Prüfer). Der Check
   ist sowohl als freundliche Vorprüfung als auch als **atomarer Backstop im
   UPDATE** (TOCTOU-sicher) umgesetzt.
4. **Öffentliches Freigabe-/Korrektur-Log** unter `/[tenant]/transparenz`: weist
   je veröffentlichtem Digest die menschliche Freigabe nach und macht Korrekturen
   (erneute Freigaben) sichtbar — auf Institutionsebene, ohne Personennennung.

## Zentralisierung

Die zuvor über viele Dateien duplizierte Rollenprüfung wandert nach
`src/lib/auth/roles.ts` (`canRedaktion` / `canFreigeben` / `isAdmin`). Für dieses
Paket auf den Digest-Pfaden umgestellt; Anliegen-/übrige Admin-Pfade folgen mit
dem Audit-Paket (Achse B).

## Konsequenzen

- **+** Vier-Augen ist sofort möglich, sobald eine zweite Person als `redakteur`
  eingerichtet wird — ohne Code-Änderung, nur Toggle + Rollenvergabe.
- **+** Redaktionslast delegierbar (Skalierung), Freigabe-Hoheit bleibt zentral.
- **+** Transparenz nach außen statt stiller Ein-Personen-Freigabe.
- **−** Im Pilot bleibt es faktisch Ein-Personen-Freigabe (Toggle aus) — das wird
  auf der Transparenz-Seite **offen kommuniziert**.
- Rollenvergabe erfolgt derzeit noch per SQL; eine auditierte Admin-Action dafür
  kommt mit dem Audit-Paket (Achse B).
