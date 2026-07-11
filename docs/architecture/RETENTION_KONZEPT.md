# Retention- & Löschkonzept (Datenhaltung)

**Stand:** 2026-06-12 · Gilt für die Partizip-Plattform (Pilot Taunusstein).
Begleitet ADR-008 (Auth-Retention) und das DSGVO-Self-Service-Paket (H3).

Grundsatz: **Datensparsamkeit (Art. 5 DSGVO).** Personenbezug wird so kurz wie
möglich gehalten; was als öffentliches Protokoll gebraucht wird, bleibt
**pseudonym**; Nachvollziehbarkeit (Audit) bleibt **PII-frei** erhalten.

---

## 1. „Was passiert mit den ganzen gepullten PDFs?" — kurz & klar

**Die Anwendung speichert keine Dokumentdateien.** Geprüft im Code:

- `ris_documents` hält **nur** `source_url` (Link ins ALLRIS/OParl) und
  `content_hash` (Integritätsprüfung) — **kein Datei-Blob, kein PDF-Inhalt**.
- Es gibt **keine** `writeFile`/`createWriteStream`/Upload-Logik im `app/src`.
  Dokumente werden zum Extrahieren **im Speicher** geholt und verworfen.

→ Es wächst **kein PDF-Berg** in der Plattform. Der einzige Ort, an dem
Dokumente real auf Platte landen, ist der **Assisted-Digest-Wochenlauf**, in
dem ein Agent ALLRIS-PDFs zum Lesen herunterlädt. Dafür gilt die
Scratch-Disziplin in Abschnitt 4.

---

## 2. Retention je Tabelle

| Tabelle | Inhalt | Aufbewahrung | Mechanismus |
|---|---|---|---|
| `auth_tokens` | Magic-Link-Tokens (gehasht) | **24 h** nach consumed/expired | `db:cleanup` (Cron 04:00); bei Konto-Löschung (H3) sofort per alter E-Mail gelöscht |
| `sessions` | DB-Sessions | **30 d** nach expired/revoked | `db:cleanup` (Cron 04:00); bei Konto-Löschung (H3) sofort revoked |
| `rate_limit_events` | Zähl-Fenster Missbrauchsschutz | **24 h** | `db:cleanup` (Cron 04:00) |
| `users` | Konto (E-Mail, Verif-Status, Alter-Flag) | bis Löschung durch Nutzer | DSGVO-Self-Service (H3): Zeile **bleibt**, alle PII werden anonymisiert (E-Mail→Tombstone `geloescht-<id>@deleted.invalid`, Geburts-/Wohnort-/Verif-Felder genullt), `account_status='deleted'` + `deleted_at` gesetzt |
| `roles` | Rollen-Zuweisung je Tenant | bis Konto-Löschung | H3: bei Löschung **hart entfernt** (kein Admin-Recht bleibt); letzter Admin wird an der Löschung gehindert |
| `anliegen` | Bürger-Anliegen (pseudonym, `creator_ref`=HMAC) | **dauerhaft** als Vorgangs-/Protokoll-Record | kein Auto-Delete; `zurückgezogen`-Status statt Hard-Delete; bei Konto-Löschung **erhalten** (Pseudonym bleibt, kein User-FK) |
| `anliegen_events` | Status-Historie (append-only) | mit Anliegen (CASCADE) | immutable; bei Konto-Löschung erhalten (hängen an Anliegen, nicht am User) |
| `anliegen_followers` | Benachrichtigungs-Verknüpfung (User-FK) | bis Konto-Löschung | H3: bei Löschung **hart entfernt** (keine Benachrichtigungen mehr); zusätzlich CASCADE bei DB-User-Löschung |
| `anliegen_matches` | RIS-Verknüpfung (M8) | mit Anliegen (CASCADE) | — |
| `digests` / `digest_statements` | Veröffentlichte Bürger-Zusammenfassungen | **dauerhaft** (öffentliches Protokoll) | kein Auto-Delete; Korrekturen versioniert/auditiert |
| `ris_bodies` / `ris_meetings` / `ris_documents` | RIS-Metadaten + Quell-URLs (kein Blob) | dauerhaft (Quellenbindung) | re-importierbar, idempotent (`content_hash`) |
| `verification_locations` / `verification_slots` | Verifikations-Termine (Phase 2) | bis Abschluss/Ablauf | beim M4-Bau Gate-B-pflichtig |
| `audit_events` | **PII-freie** Nachvollziehbarkeit | **dauerhaft** (Compliance) | kein FK auf `users` → bleibt bei Löschung erhalten |
| `tenants` / `ortsteile` | Stammdaten | dauerhaft | — |

**Begründung der „dauerhaft"-Einträge:** Anliegen und Digests sind das
öffentliche Beteiligungs-Protokoll der Kommune — sie löschen hieße den Vorgang
verschwinden lassen. Personenbezug entsteht dort nicht (Anliegen pseudonym,
Digests quellgebunden). `audit_events` ist bewusst PII-frei (actor_ref =
UUID/Pseudonym, ip/ua nur gehasht) und überlebt deshalb auch eine
Konto-Löschung, ohne Betroffenenrechte zu verletzen.

---

## 3. Was automatisiert läuft (Stand 2026-06-12)

- **Backup:** `0 3 * * * backup.sh` → Backup-Verzeichnis auf dem Host (pg_dump,
  Restore-Drill bestanden, siehe `BACKUP_RESTORE.md`).
- **Cleanup:** `0 4 * * * cleanup.sh` → `db:cleanup` (auth_tokens/sessions/
  rate_limit_events). Läuft **nach** dem Backup. Trifft nur die Staging-App-DB,
  **nie** altprod. Log: `/var/log/partizip-cleanup.log`.

Beide Cronjobs liegen im root-crontab der VM. Verifiziert am 2026-06-12
(erster Cleanup-Lauf: 8 auth_tokens + 16 rate_limit_events entfernt).

---

## 4. Agent-Scratch-Disziplin (Assisted-Digest-Wochenlauf)

Wenn ein Agent ALLRIS-Dokumente zum Aufbereiten herunterlädt:

- Downloads **ausschließlich** ins Job-/Scratch-Verzeichnis (`$CLAUDE_JOB_DIR/tmp`),
  **nie** ins Repo, nie nach `/srv`, nie in App-Volumes.
- Nach Abschluss des Laufs: Scratch **löschen**. Es wird nur das **Ergebnis**
  (der geprüfte Digest-Draft als JSON) über `digest-import-draft.ts` in die DB
  übernommen — die Quell-PDFs werden nicht persistiert.
- Persistenter Bezug zur Quelle bleibt über `ris_documents.source_url` +
  `content_hash` erhalten (re-fetchbar), nicht über eine lokale Kopie.

Diese Disziplin ist in `DIGEST_ASSISTED_WORKFLOW.md` (Abschnitt Wochenlauf)
referenziert.

---

## 5. Offen / später

- **N1** Content-Hash heute app-seitig; bei mehreren Admins DB-Trigger erwägen.
- **Offsite-Backup-Kopie** fehlt noch (Ziel/Credentials von Patrick).

---

## 6. DSGVO-Self-Service (H3) — umgesetzter Stand

**Auskunft (Art. 15):** Route-Handler `GET /[tenant]/konto/export` liefert die
eigenen Daten des eingeloggten Users als JSON-Download (Konto inkl. eigener
E-Mail, eigene Rollen, gefolgte Anliegen, eigene Anliegen via Pseudonym samt
Events). Alle Queries tenant-isoliert. Code: `src/lib/konto/export.ts`.

**Löschung (Art. 17):** Server-Action `kontoLoeschen("LÖSCHEN")` (mit
Bestätigungspflicht). In **einer Transaktion**, tenant- und user-scoped
(`src/lib/konto/delete.ts`):

| Tabelle | Aktion bei Konto-Löschung |
|---|---|
| `users` | **anonymisieren** (Zeile bleibt): E-Mail→Tombstone, PII genullt, `account_status='deleted'`, `deleted_at`=now, `verification_status='pending'` |
| `roles` | **löschen** |
| `anliegen_followers` | **löschen** |
| `sessions` | **revoken** (`revoked_at`=now) |
| `auth_tokens` | **löschen** (per alter E-Mail, vor Anonymisierung gelesen) |
| `anliegen` / `anliegen_events` / `anliegen_matches` | **erhalten** (pseudonymer Vorgang; kein User-FK) |
| `audit_events` | **erhalten** + Eintrag `konto.deleted` (PII-frei: actor_ref=UUID, metadata `{tenantId}`) |

**Letzter Admin:** Ist der User die einzige kommune_admin/super_admin-Person des
Tenants, wird die Löschung verweigert (verhindert verwaisten Tenant).
