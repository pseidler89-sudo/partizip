/**
 * Partizip — Drizzle ORM Schema (M1 Foundation + Gate-B-Fixes + M2 Auth & Tenancy)
 *
 * Design-Referenz: /home/claude/projects/partizip-wt/planning/db/migrations/0001_init.sql
 * Kommunal-Deltas: ADR-003, Konzept Kap. 5–8
 *
 * M2 adds: auth_tokens, sessions, and min_age_confirmed_at on users.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  jsonb,
  unique,
  uniqueIndex,
  index,
  check,
  customType,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// ltree — PostgreSQL-Contrib-Typ für materialisierte Baum-Pfade (ADR-024,
// GEBIETSMODELL §3.1). Drizzle kennt ltree nicht nativ → schlanker customType,
// der die DDL-Spalte als `ltree` ausgibt. Werte sind Strings der Form
// `de.hessen.rtk.taunusstein.wehen`. Die Extension + der GiST-Index + der
// pfad-pflegende Trigger werden in der Migration (rohes SQL) angelegt — Drizzle
// deckt Extension/GiST/Trigger nicht ab.
// ---------------------------------------------------------------------------

const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return "ltree";
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
]);

export const verificationMethodEnum = pgEnum("verification_method", [
  "in_person",
  "postal_code_letter",
  "remote_admin_override",
  "eid", // reserviert, im Pilot nicht vergeben
  // ADR-014 Block 2: QR-Verifizierung (Verifier/Admin erzeugt QR, Bürger löst ein)
  "qr",
  // Verifizierung 2.0 (V3): umgekehrte QR-Richtung — der Bürger zeigt seinen
  // Konto-QR, der Verifizierer scannt/bestätigt vor Ort (verification_proofs).
  "qr_konto",
]);

export const roleTypeEnum = pgEnum("role_type", [
  "user",
  "verifier",
  "kommune_admin",
  "super_admin",
  // M2/H1: Redakteur — erstellt/prüft Digests, gibt aber NICHT frei (Vier-Augen-Hebel)
  "redakteur",
  "ortsteil_admin", // Reserve, im Pilot nicht vergeben
  "kreis_admin",    // Reserve
  "land_admin",     // Reserve
  // Rollen-Governance: View-Only-Rolle für Multiplikatoren — sieht im eigenen
  // Scope Ergebnisse und Digest-Entwürfe, KEINERLEI Mutationen (roles.ts:
  // BEOBACHTUNG_ROLES; bewusst in keiner Mutations-Achse). Ans ENDE angehängt,
  // damit die Migration ein reines ALTER TYPE ... ADD VALUE bleibt.
  "beobachter",
]);

// ADR-024 contract (GEBIETSMODELL §4 Schritt 4): der frühere Enum `scope_level`
// (ortsteil|stadt|kreis|land) ist ENTFERNT. Die geografische Ebene eines Objekts
// ergibt sich jetzt ausschließlich aus seinem Gebietsknoten (`regions.typ`/`path`);
// die Composer-Eingabe-Ebene lebt als reiner TS-Union in @/lib/region/ebenen.

// ADR-024 / GEBIETSMODELL §3.1: Gebietsart des Baum-Knotens (NICHT der Scope).
// Bewusst erweiterbar (z. B. `regierungsbezirk`, `verbandsgemeinde`) — die
// Sicht-/Zuständigkeits-Logik hängt an parent_id/path, nicht an diesem Typ.
// Neue Werte ans ENDE anhängen, damit die Migration ein reines
// ALTER TYPE ... ADD VALUE bleibt.
export const regionTypEnum = pgEnum("region_typ", [
  "bund",
  "land",
  "kreis",
  "gemeinde",
  "ortsteil",
]);

export const anliegenStatusEnum = pgEnum("anliegen_status", [
  "eingegangen",
  "in_pruefung",
  "im_gremium",
  "beantwortet",
  "umgesetzt",
  "abgelehnt",
  // M3: vom Ersteller zurückgezogen (kein Hard-Delete)
  "zurueckgezogen",
]);

export const actorTypeEnum = pgEnum("actor_type", [
  "user",
  "admin",
  "system",
]);

// N2: account_status als Enum (Gate-B-Fix)
export const accountStatusEnum = pgEnum("account_status", [
  "active",
  "locked",
  "deleted",
]);

// Einladungs-Flow: Lebenszyklus einer Rollen-Einladung.
//   pending  = versendet, noch nicht angenommen (einlösbar)
//   accepted = angenommen, Rolle wurde vergeben (Endzustand)
//   revoked  = vom Admin zurückgezogen (uneinlösbar)
//   expired  = abgelaufen (nur als Diagnose-Wert; Ablauf wird primär über
//              expires_at geprüft, dieser Status ist der optionale Endzustand
//              eines Cleanups)
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  primaryColor: text("primary_color"),
  logoUrl: text("logo_url"),
  welcomeText: text("welcome_text"),
  isActive: boolean("is_active").notNull().default(true),
  // H1: Vier-Augen-Pflicht — wenn true, muss der Freigeber eines Digests ein
  // anderer sein als wer dessen Aussagen geprüft hat. Pilot: false (Ein-Personen-Betrieb).
  vierAugenPflicht: boolean("vier_augen_pflicht").notNull().default(false),
  // Block L (ADR-028): KI-Neutralitäts-Check je Tenant. Ist er AN, geht eine zur
  // Aktivierung gebrachte Umfrage zuerst in den Zustand `in_pruefung`; ein Betreiber
  // bewertet sie ASSISTED anhand des öffentlich versionierten Prompts und gibt sie
  // frei (→ aktiv) oder hält sie an (→ entwurf). Default AUS = heutiger Weg (Umfrage
  // direkt aktivierbar). Muster: vierAugenPflicht. Einschalten = bewusste
  // Owner-Entscheidung + separate Aktivierung (nicht im Feature-PR).
  kiNeutralitaetsPflicht: boolean("ki_neutralitaets_pflicht").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  // M6: $onUpdate sorgt für automatisches Aktualisieren bei jedem UPDATE
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------
// ortsteile
// ---------------------------------------------------------------------------

export const ortsteile = pgTable(
  "ortsteile",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // M2: CASCADE → RESTRICT (Tenant-Löschung soll explizit blockiert werden)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [unique("ortsteile_tenant_code_unique").on(t.tenantId, t.code)]
);

// ---------------------------------------------------------------------------
// plz_regionen — PLZ-/Standort-Einstieg (ADR-015)
//
// Portable Mapping-Tabelle: PLZ → Tenant (Kommune), optional ein Default-
// Ortsteil-Code. Backbone des Single-Domain-Einstiegs (partizip.online): der
// Bürger gibt seine PLZ ein bzw. gibt den Standort frei und wird seiner Region
// zugeordnet. Im Pilot ist Taunusstein ≈ EINE PLZ → die PLZ löst auf Stadt-Ebene
// auf (ortsteil_code NULL); den Ortsteil wählt der Bürger optional per Dropdown.
//
// lat/lon: ungefähres Zentrum der Region für die "Standort verwenden"-Auflösung
// (Haversine-Nähe, ohne externen Geocoder). NULL = nicht per Standort auflösbar.
//
// ortsteil_code ist ein Code (analog roles/polls.scope_code) — bewusst KEIN FK,
// damit die Struktur portabel/export-importierbar bleibt (ADR-015 Skalierung).
// ---------------------------------------------------------------------------

export const plzRegionen = pgTable(
  "plz_regionen",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    plz: text("plz").notNull(),
    // Optionaler Default-Ortsteil-Code; NULL = PLZ löst nur auf Stadt-Ebene auf
    ortsteilCode: text("ortsteil_code"),
    // Ungefähres Regions-Zentrum für die Standort-Auflösung (Haversine)
    lat: numeric("lat"),
    lon: numeric("lon"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // Natürlicher Schlüssel: eine Zeile je (plz, ortsteil_code). NULLS NOT DISTINCT,
    // damit (plz, NULL) eindeutig ist und nicht mehrfach angelegt werden kann.
    unique("plz_regionen_plz_ortsteil_unique")
      .on(t.plz, t.ortsteilCode)
      .nullsNotDistinct(),
    index("idx_plz_regionen_plz").on(t.plz),
    index("idx_plz_regionen_tenant_id").on(t.tenantId),
  ]
);

// ---------------------------------------------------------------------------
// regions — hierarchischer Gebietsbaum (ADR-024, GEBIETSMODELL §3.1)
//
// Single Source of Truth (contract abgeschlossen): polls/roles/qr_codes/
// verification_locations/invitations hängen ausschließlich über region_id am
// Baum; scope_level/scope_code und der Enum scopeLevelEnum sind entfernt. Die
// geografische Ebene eines Objekts ergibt sich aus regions.typ/path. Befüllt/
// gespiegelt aus den Stammdaten via scripts/seed-regions.ts.
//
// Tenant-FREI: Bund → Land → Kreis → Gemeinde existieren global genau einmal.
// tenant_id ist nur operativer Betreuungs-Marker (Branding/Betrieb), NICHT die
// Isolationsgrenze (die bleibt tenant_id-Gleichheit auf den Fachtabellen).
//
// path: materialisierter ltree-Pfad, per Trigger aus parent_id + path_label
//   gepflegt (Migration 0023, rohes SQL). path_label ist das ltree-Label des
//   Knotens (ltree-sicher: ^[a-z0-9_]+$) und dient zugleich als der in
//   GEBIETSMODELL §9 geforderte stabile Ortsteil-Code (Ortsteile haben keinen
//   amtlichen Schlüssel). NICHT von Hand setzen: der Trigger baut path.
// ---------------------------------------------------------------------------

export const regions = pgTable(
  "regions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Normalisierte Wahrheit der Baumkanten. RESTRICT: ein Elternknoten mit
    // Kindern ist nicht löschbar. NULL nur bei der Wurzel (Bund) — via CHECK.
    parentId: uuid("parent_id").references((): AnyPgColumn => regions.id, {
      onDelete: "restrict",
    }),
    typ: regionTypEnum("typ").notNull(),
    // Amtlicher 8-Steller (Gemeinde) bzw. Präfix (Kreis/Land); NULL für Bund/Ortsteil.
    ags: text("ags"),
    // 12-stelliger Amtlicher Regionalschlüssel (ARS) — kanonischer Baum-Anker.
    // NULL für Bund/Ortsteil (kein amtlicher Schlüssel).
    ars: text("ars"),
    name: text("name").notNull(),
    // ltree-Label dieses Knotens (Segment im Pfad) + stabiler synthetischer
    // Code für Ortsteile. ltree-sicher; CHECK in der Migration.
    pathLabel: text("path_label").notNull(),
    // Materialisierter Pfad (ltree), Trigger-gepflegt. In Drizzle nullable, damit
    // Inserts das Feld weglassen (der BEFORE-Trigger füllt es); die Migration
    // setzt NOT NULL auf DB-Ebene.
    path: ltree("path"),
    // Operativer Betreuungs-Marker (NICHT Isolation). Kreis/Land/Bund: NULL.
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    lat: numeric("lat"),
    lon: numeric("lon"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // Natürlicher Schlüssel für idempotenten Import amtlicher Knoten.
    uniqueIndex("regions_ars_unique").on(t.ars).where(sql`${t.ars} IS NOT NULL`),
    // Geschwister eindeutig über den Namen (Ortsteile ohne amtlichen Schlüssel).
    // NULLS NOT DISTINCT: die Wurzel (parent_id IS NULL) ist so über den Namen
    // eindeutig und als ON-CONFLICT-Ziel für den idempotenten Seed nutzbar.
    unique("regions_parent_name_unique").on(t.parentId, t.name).nullsNotDistinct(),
    // Geschwister eindeutig über das ltree-Label (Pfad-Konsistenz + Seed-Anker).
    unique("regions_parent_label_unique").on(t.parentId, t.pathLabel).nullsNotDistinct(),
    index("idx_regions_parent_id").on(t.parentId),
    index("idx_regions_tenant_id").on(t.tenantId),
    // Audit M6: höchstens EIN Gemeinde-Knoten je Tenant. Ohne diesen Index legte
    // eine pathLabel/name-Änderung in regionen.json (bei fiktiven Tenants real
    // möglich) still einen ZWEITEN Gemeinde-Knoten mit derselben tenant_id an →
    // der Seed lief grün durch, aber jeder spätere Insert ohne region_id brach mit
    // „Gemeinde-Anker nicht eindeutig" ab (genau die Falle des Staging-Deploys).
    uniqueIndex("regions_one_gemeinde_per_tenant")
      .on(t.tenantId)
      .where(sql`${t.typ} = 'gemeinde' AND ${t.tenantId} IS NOT NULL`),
    // Genau eine Wurzel, beidseitig: Bund ⇔ Wurzel. (typ='bund') genau dann,
    // wenn (parent_id IS NULL) — verhindert sowohl einen Bund mit Elternknoten
    // als auch eine Nicht-Bund-Wurzel. Die Einzigkeit der Wurzel erzwingt
    // zusätzlich ein partieller Unique-Index in der Migration.
    check(
      "regions_root_is_bund",
      sql`(${t.typ} = 'bund') = (${t.parentId} IS NULL)`
    ),
  ]
);

// ---------------------------------------------------------------------------
// plz_regions — PLZ ↔ Region als echtes n:m (ADR-024, GEBIETSMODELL §3.4)
//
// ADDITIV neben dem bestehenden plz_regionen (das in Nutzung bleibt). Eine PLZ
// kann mehrere Gemeinden/Ortsteile überlappen und umgekehrt. weight/is_primary
// steuern die Auflösung bei Splitlagen; source dokumentiert die Herkunft.
// ---------------------------------------------------------------------------

export const plzRegions = pgTable(
  "plz_regions",
  {
    plz: text("plz").notNull(),
    regionId: uuid("region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "restrict" }),
    // Flächen-/Einwohneranteil bei Splitlagen (Ranking). NULL = unbekannt.
    weight: numeric("weight"),
    // Default-Auflösung bei Mehrdeutigkeit.
    isPrimary: boolean("is_primary").notNull().default(false),
    // Herkunft (Destatis / OpenPLZ / OSM / manuell).
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.plz, t.regionId] }),
    index("idx_plz_regions_plz").on(t.plz),
    index("idx_plz_regions_region_id").on(t.regionId),
  ]
);

// ---------------------------------------------------------------------------
// users
//
// E-Mail im Klartext: erforderlich für Magic-Link-Versand (Eigen-Auth, ADR-005).
// Zweckbindung: Konzept Kap. 7. is_adult wird NICHT als Spalte gespeichert
// (nicht immutable) — stattdessen Helper-Funktion isAdult() in src/lib/age.ts.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // M2: CASCADE → RESTRICT (Tenant-Löschung soll explizit blockiert werden)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Klartext-E-Mail: Zweckbindung Magic-Link, niemals in Logs oder Audit-Metadaten
    email: text("email").notNull(),
    birthYear: integer("birth_year"),
    // birth_month: 1–12, NULL = unbekannt (konservativ → kein Alter)
    birthMonth: integer("birth_month"),
    ortsteilId: uuid("ortsteil_id").references(() => ortsteile.id, {
      onDelete: "set null",
    }),
    // ADR-024 / GEBIETSMODELL §3.3 (ETAPPE 1, additiv, nullable):
    //   home_region_id      — WEICH ermittelter Wohnort-Knoten (Gemeinde/Ortsteil),
    //                         aus PLZ/Standort/Selbstwahl. Steuert SICHTBARKEIT.
    //   residency_region_id — VERIFIZIERTER Wohnsitz (QR/Termin/später eID).
    //                         Steuert ZUSTÄNDIGKEIT für verbindliche Abstimmungen.
    // Die bestehende ortsteil_id bleibt in dieser Etappe die Wahrheit für die
    // laufende App; der Backfill spiegelt ortsteil_id → home_region_id.
    homeRegionId: uuid("home_region_id").references(() => regions.id, {
      onDelete: "set null",
    }),
    residencyRegionId: uuid("residency_region_id").references(() => regions.id, {
      onDelete: "set null",
    }),
    verificationStatus: verificationStatusEnum("verification_status")
      .notNull()
      .default("pending"),
    verificationMethod: verificationMethodEnum("verification_method"),
    residencyVerifiedAt: timestamp("residency_verified_at", { withTimezone: true }),
    // ADR-014 Block 2: Ablauf der Wohnsitz-Verifizierung (Default 24 Monate bei
    // QR-Einlösung). NULL = kein Ablauf (Bestand vor Einführung — grandfathered,
    // gilt weiter als Stufe 2). Ist es gesetzt UND < now → zurück auf Stufe 1.
    residencyVerifiedUntil: timestamp("residency_verified_until", { withTimezone: true }),
    // Skalierungs-Roadmap: Zeitpunkt der zuletzt versendeten Re-Verify-Erinnerung
    // (vor Ablauf von residency_verified_until). NULL = noch keine im aktuellen
    // Verifizierungs-Zyklus versendet; wird bei Re-Verifizierung (qr-core) auf NULL
    // zurückgesetzt, damit im nächsten Zyklus erneut erinnert werden kann.
    reverifyReminderSentAt: timestamp("reverify_reminder_sent_at", { withTimezone: true }),
    // Block J1: Öffentliche Identität für ROLLENTRÄGER (verifier/redakteur/
    // beobachter/kommune_admin/super_admin). Klarname + optionale Funktions-/
    // Amtsbezeichnung — Rollenausübung = Verantwortungsübernahme, daher öffentlich
    // sichtbar (Fragesteller-Badge, Team-Sicht). BÜRGER bleiben pseudonym: bei
    // ihnen bleiben beide Felder NULL (die Konto-UI bietet sie nur Rollenträgern
    // an). Additiv+nullable (Migration 0032), KEIN Backfill — Rollenträger setzen
    // den Namen selbst; fehlt er, greift überall ein neutraler Institutions-
    // Fallback (weiche Durchsetzung per Nudge, keine harte Sperre). Grenzen werden
    // serverseitig in zod erzwungen (display_name 2..80, funktion ≤ 80), nicht als
    // DB-Constraint — der einzige Admin (Patrick) darf sich nie selbst aussperren.
    // display_name/funktion sind PII → Art.-15-Export + Lösch-Anonymisierung.
    displayName: text("display_name"),
    funktion: text("funktion"),
    // N2: account_status als pgEnum statt freier Text
    accountStatus: accountStatusEnum("account_status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M2: Mindestalter-Selbsterklärung (ADR-007). Konzept Kap. 10.5.
    // Zeitstempel der Selbstauskunft „ich bin mindestens 16 Jahre alt" bei Erstregistrierung.
    // Kein Boolean — Zeitstempel erlaubt datenschutzrechtliche Nachweisführung ohne PII.
    minAgeConfirmedAt: timestamp("min_age_confirmed_at", { withTimezone: true }),
    // H3 DSGVO: Zeitpunkt der Konto-Löschung (Self-Service). Bei Löschung wird
    // account_status='deleted' gesetzt + E-Mail/PII anonymisiert; Zeitstempel als Nachweis.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Benachrichtigungs-Motor: Opt-out für E-Mails bei neuen Abstimmungen im
    // eigenen Gebiet. Default true (Registrierte wollen über neue Beteiligungs-
    // Möglichkeiten informiert werden; jederzeit im Konto abbestellbar — passt zur
    // Datenschutz-Formulierung „optionale Benachrichtigungen, jederzeit abbestellen").
    // Bei Konto-Löschung wird das Flag auf false gesetzt (keine Mails an gelöschte Konten).
    notifyNewPolls: boolean("notify_new_polls").notNull().default(true),
    // Block J2a (Vorgriff J2c): granulare Benachrichtigungs-Opt-outs. Additiv +
    // verhaltensneutral (Default true); Versand-Logik/UI folgen in J2c. Bei
    // Konto-Löschung analog notify_new_polls auf false zu setzen (keine Mails an
    // gelöschte Konten) — das übernimmt J2c mit der Versand-Logik.
    //   notify_anliegen_updates — Statuswechsel/Antworten zu gefolgten Anliegen.
    //   notify_reverify         — Erinnerung vor Ablauf der Wohnsitz-Verifizierung.
    notifyAnliegenUpdates: boolean("notify_anliegen_updates").notNull().default(true),
    notifyReverify: boolean("notify_reverify").notNull().default(true),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // Block J2a (F-A): funktionaler UNIQUE-Index auf (tenant_id, lower(email))
    // ersetzt den alten case-SENSITIVEN unique("users_tenant_email_unique").
    // users.email wird an allen Boundaries kanonisch (trim+lowercase) gespeichert
    // (lib/auth/email.normalizeEmail); dieser Index ist das DB-Netz darunter und
    // liefert bei künftigen Kollisionen die richtige Fehlerdiagnose. Der DROP des
    // alten Constraints + Backfill stehen in Migration 0033.
    uniqueIndex("users_tenant_email_lower_unique").on(t.tenantId, sql`lower(btrim(${t.email}))`),
    check(
      "users_birth_month_check",
      sql`${t.birthMonth} IS NULL OR (${t.birthMonth} >= 1 AND ${t.birthMonth} <= 12)`
    ),
    index("idx_users_tenant_id").on(t.tenantId),
  ]
);

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // M2: CASCADE → RESTRICT (Tenant-Löschung soll explizit blockiert werden)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // roles→users bleibt CASCADE (User-Löschung löscht dessen Rollen)
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleType: roleTypeEnum("role_type").notNull(),
    // ADR-024 / GEBIETSMODELL §3.2: Gebietsknoten dieser Rolle (contract: einzige
    // Ebenen-/Zuständigkeits-Quelle; scope_level/scope_code sind entfernt).
    // RESTRICT: referenzierter Knoten nicht löschbar. NOT NULL (Migration 0024).
    regionId: uuid("region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // ADR-024 contract: Eindeutigkeit jetzt am Gebietsknoten (region_id NOT NULL,
    // daher kein nullsNotDistinct mehr nötig) statt an (scope_level, scope_code).
    unique("roles_tenant_user_role_region_unique")
      .on(t.tenantId, t.userId, t.roleType, t.regionId),
    index("idx_roles_region_id").on(t.regionId),
  ]
);

// ---------------------------------------------------------------------------
// verification_locations
// ---------------------------------------------------------------------------

/**
 * Verifizierung 2.0 / V1: ein Öffnungs-/Sprechzeiten-Fenster eines Standorts.
 * `tag` = ISO-Wochentag Mo=1 … So=7; `von`/`bis` = Wandzeit „HH:MM". Mehrere
 * Einträge je Tag = mehrere Fenster. Am Action-Boundary per zod validiert
 * (von < bis, HH:MM-Regex, Tag 1–7); die DB speichert reines JSON (kein
 * JS-`Date` in Roh-SQL, siehe Konvention).
 */
export interface OeffnungszeitFenster {
  tag: number; // 1..7 (Mo=1 … So=7)
  von: string; // "HH:MM"
  bis: string; // "HH:MM"
}

export const verificationLocations = pgTable(
  "verification_locations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // M2: CASCADE → RESTRICT (Tenant-Löschung soll explizit blockiert werden)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    address: text("address"),
    hinweise: text("hinweise"),
    lat: numeric("lat"),
    lon: numeric("lon"),
    // Verifizierung 2.0 / V1 (Migration 0037, additiv):
    // Strukturierte Öffnungs-/Sprechzeiten. NULL / [] = „keine Angabe". Shape
    // Array<{tag:1..7, von:"HH:MM", bis:"HH:MM"}> — zod validiert am Boundary.
    oeffnungszeiten: jsonb("oeffnungszeiten").$type<OeffnungszeitFenster[]>(),
    // true = Verifizierung NUR über Termin (K1-Slots), kein Walk-in.
    terminErforderlich: boolean("termin_erforderlich").notNull().default(false),
    // null = unbekannt (Tri-State) — für Bürger-Anzeige (V2).
    barrierefrei: boolean("barrierefrei"),
    // Optionale Telefon-/Mail-Kurzangabe (≤120, per zod erzwungen).
    kontakt: text("kontakt"),
    // ADR-024 / GEBIETSMODELL §3.2: Gebietsknoten des Standorts. verification_locations
    // trug nie einen scope_level — der Standort gehört zur Kommune, der BEFORE-INSERT-
    // Trigger leitet region_id auf den Gemeinde-Knoten des Tenants ab (Sicherheitsnetz
    // für Seeds/direkte Inserts). RESTRICT: Knoten nicht löschbar.
    // In Drizzle NULLABLE (Inserts dürfen es weglassen → Trigger füllt es); die DB
    // erzwingt NOT NULL (Migration 0024).
    regionId: uuid("region_id").references(() => regions.id, { onDelete: "restrict" }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // Natürlicher Key für Idempotenz beim Seeding: Standort-Name ist pro Tenant eindeutig
    unique("verification_locations_tenant_name_unique").on(t.tenantId, t.name),
    index("idx_verification_locations_region_id").on(t.regionId),
  ]
);

// ---------------------------------------------------------------------------
// verification_slots
// ---------------------------------------------------------------------------

export const verificationSlots = pgTable(
  "verification_slots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // verification_slots→locations: CASCADE bleibt (Standort-Löschung löscht dessen Slots)
    locationId: uuid("location_id")
      .notNull()
      .references(() => verificationLocations.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    capacity: integer("capacity").notNull().default(1),
    bookedCount: integer("booked_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    check("verification_slots_ends_after_starts", sql`${t.endsAt} > ${t.startsAt}`),
    // N1: booked_count muss >= 0 und <= capacity sein
    check(
      "verification_slots_booked_count_check",
      sql`${t.bookedCount} >= 0 AND ${t.bookedCount} <= ${t.capacity}`
    ),
    // Natürlicher Key für Idempotenz beim Seeding: ein Ort kann pro Startzeitpunkt nur einen Slot haben
    unique("verification_slots_location_starts_unique").on(t.locationId, t.startsAt),
  ]
);

// ---------------------------------------------------------------------------
// D6 / Verify-Hub: Termin-Buchung (verification_bookings)
//
// Bürger:in bucht einen freien Slot in einem Bürgerbüro und weist sich VOR ORT
// aus → ein Verifier markiert den Termin als wahrgenommen, was die Person
// wohnsitz-verifiziert (Stufe 2, method='in_person'). QR bleibt Fallback.
//
// SICHERHEITS-/DATENSCHUTZ-KERN:
//   - Kapazitäts-Atomarität: booked_count wird per atomarem bedingten UPDATE
//     erhöht (WHERE booked_count < capacity AND starts_at > now()) — kein
//     Race-Überlauf, kein Buchen vergangener Slots (DB-Uhr, race-frei wie QR-Cap).
//   - Ein offener Termin je Bürger: partielles UNIQUE(tenant_id, user_id) WHERE
//     status='gebucht' (kein Slot-Hoarding; Storno gibt die Kapazität frei).
//   - Termin-Code (CSPRNG, je Tenant eindeutig): der Bürger zeigt ihn vor Ort;
//     der Verifier bestätigt über den Code → die Verifier-Liste bleibt PII-frei
//     (kein Name/keine E-Mail), der Bezug zur Person bleibt serverseitig (user_id).
//   - Verifizierung NUR über bookingWahrnehmen durch canVerify (kein Selbst-
//     Hochstufen). Tenant-Isolation via tenant_id-Redundanz + Slot→Location-Join.
//     Audit PII-frei (actorRef=UUID, nie E-Mail; nie der Termin-Code).
// ---------------------------------------------------------------------------

export const verificationBookingStatusEnum = pgEnum("verification_booking_status", [
  "gebucht",
  "wahrgenommen",
  "storniert",
]);

export const verificationBookings = pgTable(
  "verification_bookings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Tenant-Redundanz für direkte Tenant-Isolation in JEDER Query
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Slot-Löschung (durch Admin/Standort-Löschung) entfernt die Buchung mit.
    slotId: uuid("slot_id")
      .notNull()
      .references(() => verificationSlots.id, { onDelete: "cascade" }),
    // onDelete:cascade greift NICHT bei der Konto-Löschung (die users-Zeile wird
    // nur anonymisiert, nie gelöscht) — deleteKontoCore löscht die Buchungen
    // deshalb explizit (Schritt 5c, Audit M4). Cascade wirkt nur bei echtem
    // users-DELETE (z. B. Test-Teardown).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Vorlesbarer Termin-Code (TERMIN-XXXX-XXXX, CSPRNG) — vor Ort vom Bürger gezeigt.
    code: text("code").notNull(),
    status: verificationBookingStatusEnum("status").notNull().default("gebucht"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // Höchstens EIN offener Termin je Bürger (partielles Unique).
    uniqueIndex("verification_bookings_one_open_per_user")
      .on(t.tenantId, t.userId)
      .where(sql`status = 'gebucht'`),
    // Termin-Code je Tenant eindeutig → kollisionssicherer Insert + Lookup.
    unique("verification_bookings_tenant_code_unique").on(t.tenantId, t.code),
    index("idx_verification_bookings_slot").on(t.slotId),
  ]
);

// ---------------------------------------------------------------------------
// anliegen
//
// creator_ref ist ein Pseudonym — KEIN User-FK (Datensparsamkeit, ADR-005).
// ---------------------------------------------------------------------------

export const anliegen = pgTable(
  "anliegen",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // M2: CASCADE → RESTRICT (Tenant-Löschung soll explizit blockiert werden)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    trackingCode: text("tracking_code").notNull().unique(),
    // Pseudonym: kein FK auf users — Datensparsamkeit
    creatorRef: text("creator_ref").notNull(),
    titel: text("titel").notNull(),
    beschreibung: text("beschreibung"),
    status: anliegenStatusEnum("status").notNull().default("eingegangen"),
    // H2 Moderation/Takedown: Admin kann ein missbräuchliches Anliegen verbergen.
    // WER es verborgen hat, steht PII-frei in audit_events (kein User-FK am Anliegen).
    verborgenAt: timestamp("verborgen_at", { withTimezone: true }),
    verborgenGrund: text("verborgen_grund"),
    // anliegen→ortsteile: SET NULL bleibt
    ortsteilId: uuid("ortsteil_id").references(() => ortsteile.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // M3: Composite-Index für häufige Abfragen nach Tenant + Status
    index("idx_anliegen_tenant_status").on(t.tenantId, t.status),
  ]
);

// ---------------------------------------------------------------------------
// anliegen_events
// ---------------------------------------------------------------------------

export const anliegenEvents = pgTable(
  "anliegen_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // anliegen_events→anliegen: CASCADE bleibt (Anliegen-Löschung löscht dessen Events)
    anliegenId: uuid("anliegen_id")
      .notNull()
      .references(() => anliegen.id, { onDelete: "cascade" }),
    status: anliegenStatusEnum("status").notNull(),
    quelle: text("quelle"),
    notiz: text("notiz"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // Kein updatedAt auf Events — Events sind immutable (append-only)
  },
  (t) => [
    // B1: UNIQUE-Constraint entfernt — war Seed-Hilfskonstrukt, fachlich falsch
    //     (dasselbe Status-Event mit gleicher Notiz kann legitim mehrfach vorkommen)
    // M4: Index auf anliegen_id für effiziente Event-Abfragen
    index("idx_anliegen_events_anliegen_id").on(t.anliegenId),
  ]
);

// ---------------------------------------------------------------------------
// auth_tokens — Magic-Link-Tokens (M2)
//
// token_hash: sha256-hex des Roh-Tokens (32 Bytes random → base64url).
// Der Roh-Token wird NIE gespeichert oder geloggt.
// purpose: 'login' (Standard) — erweiterbar für künftige Flows.
// ---------------------------------------------------------------------------

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // E-Mail wird für den Lookup benötigt (Tenant-scoped), aber niemals in Logs/Audit
    email: text("email").notNull(),
    // SHA-256-Hex des Roh-Tokens — Roh-Token verlässt nie Server-Gedächtnis
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").notNull().default("login"),
    // Block J2b: der anfordernde User bei purpose='email_change' (Kontrolle über
    // die NEUE Adresse beweisen). NULL für Login-/Hint-Tokens. FK ON DELETE
    // CASCADE — ein echtes users-DELETE (z. B. Tenant-Teardown) reißt offene
    // Änderungs-Tokens mit (DSGVO-sauber). Die Produkt-Löschung (delete.ts)
    // ANONYMISIERT die users-Zeile (kein DELETE) → die Kaskade feuert dort nicht;
    // delete.ts räumt die Tokens weiterhin per (tenant,email) ab. Kein Doppel-
    // lösch-Problem, da beide Pfade dieselbe Zeilenmenge abdecken.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // NULL = unverbraucht; gesetzt = eingelöst (atomarer CAS in verify)
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    // Für Rate-Limit-Abfragen: (tenant_id, email, created_at)
    index("idx_auth_tokens_tenant_email_created").on(t.tenantId, t.email, t.createdAt),
    // M4/MIN1: Retention-Cleanup-Index
    index("idx_auth_tokens_expires_at").on(t.expiresAt),
  ]
);

// ---------------------------------------------------------------------------
// sessions — httpOnly-Session-Tokens (M2, ADR-006)
//
// token_hash: sha256-hex des Roh-Session-Tokens (32 Bytes random → base64url).
// Kein JWT — revozierbar, einfach, host-scoped (ADR-006).
// tenant_id-Bindung: Session gilt nur für den ausstellenden Tenant
// (zusätzlich zur host-only-Cookie-Eigenschaft des Browsers).
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // SHA-256-Hex des Roh-Session-Tokens
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // NULL = aktiv; gesetzt = revoziert (Logout)
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_sessions_user_id").on(t.userId),
    index("idx_sessions_tenant_id").on(t.tenantId),
    // M4/MIN1: Retention-Cleanup-Index
    index("idx_sessions_expires_at").on(t.expiresAt),
  ]
);

// ---------------------------------------------------------------------------
// rate_limit_events — eigene Tabelle für Rate-Limiting (Gate-B B1/M1/M3)
//
// scope: 'email' | 'ip'
// key_hash: HMAC-SHA-256(IP_HASH_SALT, scope_key) — kein Klartext gespeichert
//   E-Mail-Keys: HMAC(salt, tenantId + ':' + email)
//   IP-Keys:     HMAC(salt, ip)
// Retention: 24h (db:cleanup)
// ---------------------------------------------------------------------------

export const rateLimitEvents = pgTable(
  "rate_limit_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    scope: text("scope").notNull(), // 'email' | 'ip'
    keyHash: text("key_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("idx_rate_limit_events_scope_key_created").on(t.scope, t.keyHash, t.createdAt),
  ]
);

// ---------------------------------------------------------------------------
// invitations — Einladungs-Flow für Rollen (Ablösung der grant-role-CLI)
//
// Eine Kommune lädt Mitwirkende (redakteur/verifier/beobachter/kommune_admin,
// im Rahmen der Eskalationsgrenze) per E-Mail ein. Die Einladung wird per Mail
// zugestellt; angenommen wird sie über die bestehende Magic-Link-Infrastruktur:
// die eingeladene Person meldet sich mit der eingeladenen Adresse an (Konto
// anlegen/anmelden) und nimmt dann bewusst an — erst dann wird die Rolle im
// vorgesehenen Scope vergeben.
//
// SICHERHEITS-DESIGN (analog auth_tokens / qr_codes):
//   - token_hash = SHA-256-Hex des Roh-Tokens (CSPRNG). Der Roh-Token steht NUR
//     in der Einladungs-URL und verlässt nie das Server-Gedächtnis; in der DB
//     liegt ausschließlich der Hash. UNIQUE → O(1)-Lookup beim Annehmen.
//   - email wird für den Versand + die E-Mail-Bindung der Annahme benötigt
//     (analog users/auth_tokens), erscheint aber NIEMALS in audit_events.
//   - Tenant-Isolation: tenant_id in JEDER Query.
//   - Höchstens EINE offene (pending) Einladung je (tenant, email) — partieller
//     UNIQUE-Index. Erneutes Einladen rotiert den Token statt zu duplizieren.
//   - invited_by/resent_by/revoked_by/accepted_by: SET NULL, damit Konto-
//     löschungen die Einladungshistorie nicht blockieren.
// ---------------------------------------------------------------------------

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Zweckbindung: Versand + E-Mail-Bindung der Annahme. Niemals in Logs/Audit.
    // Immer normalisiert (trim + lowercase) gespeichert.
    email: text("email").notNull(),
    roleType: roleTypeEnum("role_type").notNull(),
    // ADR-024 contract: die Einladung ist eine aufgeschobene Rolle und trägt daher
    // — wie roles — den Gebietsknoten (scope_level/scope_code sind entfernt). Beim
    // Annehmen wird region_id 1:1 auf die erzeugte Rolle übernommen. NOT NULL.
    regionId: uuid("region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "restrict" }),
    // SHA-256-Hex des Roh-Tokens — Roh-Token verlässt nie den Server.
    tokenHash: text("token_hash").notNull().unique(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    // Einladende:r (für Audit-Lineage + Grenzprüfung zum Annahme-Zeitpunkt).
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    resentBy: uuid("resent_by").references(() => users.id, { onDelete: "set null" }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    resendCount: integer("resend_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Höchstens EINE offene Einladung je (tenant, email). Angenommene/
    // zurückgezogene Zeilen bleiben als Historie erhalten und blockieren keine
    // spätere Neu-Einladung.
    uniqueIndex("invitations_tenant_email_pending_unique")
      .on(t.tenantId, t.email)
      .where(sql`${t.status} = 'pending'`),
    index("idx_invitations_tenant_id").on(t.tenantId),
    // Retention/Cleanup abgelaufener Einladungen.
    index("idx_invitations_expires_at").on(t.expiresAt),
    index("idx_invitations_region_id").on(t.regionId),
  ]
);

// ---------------------------------------------------------------------------
// role_appointments — Vier-Augen-Verifier-Ernennung (Block K3)
//
// Produktentscheid: Das Vier-Augen-Prinzip greift an der Verifier-ERNENNUNG
// (nicht je Verifizierung): Die Rolle `verifier` wird zweistufig vergeben —
// ein Admin schlägt vor (pending), ein ZWEITER Admin bestätigt (approved) oder
// lehnt ab (rejected); der/die Vorschlagende kann zurückziehen (cancelled).
// Mechanik analog Digest-Freigabe: isSelfApprovalAllowed() (ALLOW_SELF_APPROVAL,
// Ein-Personen-Pilot) erlaubt Selbst-Bestätigung — der Bestätigungs-KLICK bleibt
// auch dann eine explizite, auditierte Handlung (kein Auto-Approve).
//
// Lebenszyklus: pending → approved | rejected | cancelled (alles Endzustände;
// die Historie bleibt als Spur erhalten).
//   - role_type generisch (roleTypeEnum) für spätere Rollen; vorerst schreibt
//     der Code ausschließlich 'verifier'.
//   - proposed_by/decided_by: SET NULL (invitations-Muster invited_by/…_by),
//     damit Kontolöschungen die Ernennungs-Historie nicht blockieren.
//   - target_user_id: CASCADE — greift NUR bei hartem Row-Delete der users-
//     Zeile (demo-reset/Test-Cleanup). Die PRODUKT-Löschung (DSGVO) ist eine
//     ANONYMISIERUNG (Zeile bleibt) — offene Vorschläge werden dort explizit
//     gecancelt (deleteKontoCore), ebenso beim Offboarding (offboardingCore).
//   - Partieller UNIQUE-Index: höchstens EINE offene (pending) Ernennung je
//     (tenant, target, role_type, region) — Doppel-Vorschläge race-fest
//     abgefangen (Muster invitations_tenant_email_pending_unique).
// ---------------------------------------------------------------------------

export const roleAppointmentStatusEnum = pgEnum("role_appointment_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

export const roleAppointments = pgTable(
  "role_appointments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Ziel der Ernennung. CASCADE feuert nur bei HARTEM Row-Delete (demo-reset);
    // die DSGVO-Produkt-Löschung anonymisiert nur → Cancel in deleteKontoCore.
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleType: roleTypeEnum("role_type").notNull(),
    // Gebietsknoten der künftigen Rolle (wie roles.region_id). RESTRICT.
    regionId: uuid("region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "restrict" }),
    status: roleAppointmentStatusEnum("status").notNull().default("pending"),
    // Vorschlagende:r / Entscheider:in — SET NULL (invitations-Muster), damit
    // Kontolöschungen die Historie nicht blockieren; die Audit-Events tragen
    // die Lineage zusätzlich PII-frei.
    proposedBy: uuid("proposed_by").references(() => users.id, { onDelete: "set null" }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().default(sql`now()`),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Höchstens EIN offener Vorschlag je (tenant, target, role_type, region) —
    // race-fest über den partiellen UNIQUE-Index (kein TOCTOU im Insert-Pfad).
    uniqueIndex("role_appointments_pending_unique")
      .on(t.tenantId, t.targetUserId, t.roleType, t.regionId)
      .where(sql`${t.status} = 'pending'`),
    index("idx_role_appointments_tenant_status").on(t.tenantId, t.status),
    index("idx_role_appointments_target_user").on(t.targetUserId),
  ]
);

// ---------------------------------------------------------------------------
// M7 Digest-Pipeline
// ---------------------------------------------------------------------------

// digest_status: Workflow-Enum mit DB-CHECK als letztes Sicherheitsnetz
export const digestStatusEnum = pgEnum("digest_status", [
  "entwurf",
  "freigegeben",
  "veroeffentlicht",
]);

// ris_bodies — Quellkörperschaften je Tenant (Stadt + Kreis möglich)
export const risBodies = pgTable(
  "ris_bodies",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // 'taunusstein-stadt' | 'rheingau-taunus-kreis'
    key: text("key").notNull(),
    name: text("name"),
    // 'allris4' | 'provox_iip'
    risType: text("ris_type").notNull(),
    baseUrl: text("base_url").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    unique("ris_bodies_tenant_key_unique").on(t.tenantId, t.key),
  ]
);

// ris_meetings — importierte Sitzungen
export const risMeetings = pgTable(
  "ris_meetings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    bodyId: uuid("body_id")
      .notNull()
      .references(() => risBodies.id, { onDelete: "cascade" }),
    // Provox-Meeting-ID oder ALLRIS SILFDNR
    externalId: text("external_id").notNull(),
    gremium: text("gremium"),
    title: text("title"),
    meetingDate: timestamp("meeting_date", { withTimezone: true }),
    location: text("location"),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    rawMeta: jsonb("raw_meta").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    unique("ris_meetings_body_external_unique").on(t.bodyId, t.externalId),
  ]
);

// ris_documents — Dokumente (TO, Protokoll, Anlage, …)
export const risDocuments = pgTable(
  "ris_documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => risMeetings.id, { onDelete: "cascade" }),
    // 'einladung'|'tagesordnung'|'protokoll'|'vorlage'|'anlage'|'top'
    docType: text("doc_type").notNull(),
    externalId: text("external_id"),
    title: text("title"),
    // Extrahierter Volltext — NULL solange nur Metadaten
    bodyText: text("body_text"),
    sourceUrl: text("source_url").notNull(),
    // sha256 über body_text
    contentHash: text("content_hash"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // M1(a): NULLS NOT DISTINCT — NULL external_id verhindert Duplikate auch bei NULL
    unique("ris_documents_meeting_type_ext_unique")
      .on(t.meetingId, t.docType, t.externalId)
      .nullsNotDistinct(),
    index("idx_ris_documents_meeting_id").on(t.meetingId),
  ]
);

// digests — Zusammenfassungen (ein Digest je Sitzung, Freigabe-Gate als DB-CHECK)
export const digests = pgTable(
  "digests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    meetingId: uuid("meeting_id")
      .notNull()
      .unique()
      .references(() => risMeetings.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    status: digestStatusEnum("status").notNull().default("entwurf"),
    generator: text("generator").notNull().default("extractive_v1"),
    // SET NULL: Freigeber kann gelöscht werden, Digest bleibt
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    // N1: sha256-Hash über alle Statements bei Freigabe; bei Veröffentlichung verglichen
    approvedContentHash: text("approved_content_hash"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // Gate-B Pflicht: Freigabe-Gate als DB-Constraints (Konzept Kap. 10)
    // (status='veroeffentlicht') ⇒ approved_at IS NOT NULL AND published_at IS NOT NULL
    check(
      "digests_veroeffentlicht_requires_approved_at",
      sql`${t.status} != 'veroeffentlicht' OR (${t.approvedAt} IS NOT NULL AND ${t.publishedAt} IS NOT NULL)`
    ),
    // (status='freigegeben' OR status='veroeffentlicht') ⇒ approved_at IS NOT NULL
    check(
      "digests_freigegeben_requires_approved_at",
      sql`(${t.status} != 'freigegeben' AND ${t.status} != 'veroeffentlicht') OR ${t.approvedAt} IS NOT NULL`
    ),
    index("idx_digests_tenant_status").on(t.tenantId, t.status),
    // N6: Index für Digest-Listen nach Status/Veröffentlichungsdatum
    index("idx_digests_tenant_status_published").on(t.tenantId, t.status, t.publishedAt),
  ]
);

// digest_statements — einzelne Aussagen mit Pflicht-Quellenlink
export const digestStatements = pgTable(
  "digest_statements",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    // Pflicht: keine Aussage ohne Quelldokument
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => risDocuments.id, { onDelete: "restrict" }),
    sourceUrl: text("source_url").notNull(),
    // Quellen-Prüfung: Zeitstempel wann als geprüft markiert (NULL = noch nicht geprüft)
    geprueftAt: timestamp("geprueft_at", { withTimezone: true }),
    // H1 Vier-Augen: WER die Aussage geprüft hat (SET NULL: Prüfer löschbar, Aussage bleibt)
    geprueftBy: uuid("geprueft_by").references(() => users.id, { onDelete: "set null" }),
    // Highlight: vom Prüfer als besonders wichtig für Bürger markiert
    istHighlight: boolean("ist_highlight").notNull().default(false),
    // Separation of Duties (Highlight): WER zuletzt eine Highlight-Markierung
    // gesetzt hat. Redaktionelle Gewichtung ist Mitgestaltung — wer highlightet
    // hat, darf den Digest nicht selbst freigeben (freigebenCore konsultiert
    // diese Spur atomar im Status-UPDATE). Bewusst SoD-Spur, NICHT im Content-
    // Hash (computeStatementsHash) — kein Bruch bestehender Freigabe-Hashes.
    // SET NULL: Person löschbar, Aussage bleibt.
    highlightedBy: uuid("highlighted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("digest_statements_digest_position_unique").on(t.digestId, t.position),
  ]
);

// ---------------------------------------------------------------------------
// M8: anliegen_followers
//
// Benachrichtigungs-Verknüpfung: Ersteller folgt automatisch.
// Eigene Tabelle statt User-FK am Anliegen — creator_ref bleibt pseudonym
// für Anzeige/Audit. Mini-ADR-010.
// ---------------------------------------------------------------------------

export const anliegenFollowers = pgTable(
  "anliegen_followers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    anliegenId: uuid("anliegen_id")
      .notNull()
      .references(() => anliegen.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    unique("anliegen_followers_anliegen_user_unique").on(t.anliegenId, t.userId),
    index("idx_anliegen_followers_user_id").on(t.userId),
  ]
);

// ---------------------------------------------------------------------------
// M8: match_status Enum + anliegen_matches
//
// Semantisches Matching: Vorschläge werden von Admins bestätigt oder verworfen.
// Mensch bestätigt immer — kein automatischer Statuswechsel durch Matching.
// ---------------------------------------------------------------------------

export const matchStatusEnum = pgEnum("match_status", [
  "vorgeschlagen",
  "bestaetigt",
  "verworfen",
]);

export const anliegenMatches = pgTable(
  "anliegen_matches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    anliegenId: uuid("anliegen_id")
      .notNull()
      .references(() => anliegen.id, { onDelete: "cascade" }),
    risDocumentId: uuid("ris_document_id")
      .notNull()
      .references(() => risDocuments.id, { onDelete: "restrict" }),
    confidence: numeric("confidence").notNull(),
    status: matchStatusEnum("status").notNull().default("vorgeschlagen"),
    // SET NULL: Entscheider kann gelöscht werden, Match bleibt
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    unique("anliegen_matches_anliegen_doc_unique").on(t.anliegenId, t.risDocumentId),
    index("idx_anliegen_matches_anliegen_status").on(t.anliegenId, t.status),
    // (bestaetigt|verworfen) ⇒ decided_at IS NOT NULL
    check(
      "anliegen_matches_decided_at_check",
      sql`(${t.status} = 'vorgeschlagen') OR (${t.decidedAt} IS NOT NULL)`
    ),
    // confidence muss zwischen 0 und 1 liegen
    check(
      "anliegen_matches_confidence_check",
      sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`
    ),
  ]
);

// ---------------------------------------------------------------------------
// M3: Mitmach-Schleife — lokale Umfragen ("Stimmungsbild")
//
// Vertrauensprodukt: Stimm-Integrität ist sicherheitskritisch.
//   - Secret Ballot: die getroffene Wahl steht NUR in der votes-Zeile, verknüpft
//     mit dem pseudonymen voter_ref — NIEMALS im Audit.
//   - Pseudonym: voter_ref = HMAC(SALT, "vote:user:" + userId) — kein User-FK an
//     der Stimme. ADR-014: Mitstimmen erfordert ein Konto (Stufe 1); der frühere
//     anonyme Device-Pfad (vote:device:) entfällt.
//   - Dedup: UNIQUE(poll_id, voter_ref) verhindert Doppelstimmen pro User.
//   - Gestuft: verbindliche Umfragen nur für wohnsitz-verifizierte Bürger (Stufe≥2),
//     der Verifizierungs-Status wird als war_verifiziert pro Stimme gesnapshottet.
// ---------------------------------------------------------------------------

export const pollStatusEnum = pgEnum("poll_status", [
  "entwurf",
  "aktiv",
  "geschlossen",
  // Block L (ADR-028): KI-Neutralitäts-Check. Ist `tenants.ki_neutralitaets_pflicht`
  // AN, geht eine zur Aktivierung gebrachte Umfrage NICHT direkt live, sondern in
  // diesen Zwischenzustand — bis ein Betreiber sie anhand des öffentlichen Prompts
  // freigibt (→ aktiv) oder anhält (→ zurück auf entwurf). Bewusst am ENDE der
  // Enum-Liste ergänzt (additive `ADD VALUE`, Muster 0029/0030): alle Wähler-Guards
  // filtern hart `status='aktiv'` → `in_pruefung` ist automatisch fail-closed
  // unsichtbar/unwählbar. Die UI-Reihenfolge (entwurf→in_pruefung→aktiv→geschlossen)
  // regelt STATUS_TITLES, nicht die Enum-Deklaration.
  "in_pruefung",
]);

// Beteiligungsformate (ADR-025). ja_nein_enthaltung = binäres Stimmungsbild;
// dot_voting = Punkte-/Budget-Verteilung auf mehrere Optionen (Ergebnis =
// Verteilung, kein Einzelsieger); widerstandsabfrage = Systemisches Konsensieren
// (je Option ein Widerstandswert 0–10; es gewinnt der GERINGSTE Gesamtwiderstand
// — Konsens statt Mehrheitssieg). Bewusst erweiterbar (Statement-Voting folgt).
export const pollTypeEnum = pgEnum("poll_type", [
  "ja_nein_enthaltung",
  "dot_voting",
  "widerstandsabfrage",
]);

export const polls = pgTable(
  "polls",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Tenant-Löschung explizit blockieren (konsistent mit anliegen/digests)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // ADR-024 / GEBIETSMODELL §3.2: Gebietsknoten dieser Umfrage (contract: einzige
    // Ebenen-Quelle; scope_level/scope_code sind entfernt). Die geografische Ebene
    // ergibt sich aus regions.typ/path. RESTRICT: Knoten nicht löschbar. NOT NULL.
    regionId: uuid("region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "restrict" }),
    frage: text("frage").notNull(),
    typ: pollTypeEnum("typ").notNull().default("ja_nein_enthaltung"),
    // Nur dot_voting: Punktekontingent je Wähler (Budget), das auf die Optionen
    // verteilt wird. NULL für ja_nein_enthaltung UND widerstandsabfrage.
    // Validierung serverseitig.
    punkteBudget: integer("punkte_budget"),
    status: pollStatusEnum("status").notNull().default("entwurf"),
    // Verbindlich = nur Stufe≥2 dürfen abstimmen (sonst unverbindliches Stimmungsbild)
    verbindlich: boolean("verbindlich").notNull().default(false),
    // SET NULL: Ersteller kann gelöscht werden, Umfrage bleibt
    erstelltVon: uuid("erstellt_von").references(() => users.id, {
      onDelete: "set null",
    }),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_polls_tenant_status").on(t.tenantId, t.status),
    index("idx_polls_region_id").on(t.regionId),
  ]
);

export const votes = pgTable(
  "votes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Stimme gehört zur Umfrage — Umfrage-Löschung löscht ihre Stimmen
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    // Tenant-Redundanz für direkte Tenant-Isolation in JEDER Query
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Pseudonym: HMAC(SALT, domain) — kein User-FK (Secret Ballot, Datensparsamkeit)
    voterRef: text("voter_ref").notNull(),
    // 'ja' | 'nein' | 'enthaltung' — als Text (validiert serverseitig gegen poll.typ)
    choice: text("choice").notNull(),
    // Snapshot: war der Wähler bei Stimmabgabe Stufe≥2 (wohnsitz-verifiziert)?
    warVerifiziert: boolean("war_verifiziert").notNull().default(false),
    // KEIN ip_hash mehr: der frühere Wert war über denselben Salt mit dem
    // userId-tragenden Auth-Audit-ip_hash korrelierbar → Deanonymisierungs-Brücke
    // (Audit 2026-07-16 M1). Rate-Limiting läuft über separate rateLimitEvents,
    // die Stimme braucht kein IP-Merkmal. Spalte in Migration 0026 entfernt.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // Kein updatedAt — Stimmen sind immutable
  },
  (t) => [
    // Doppelstimmen-Schutz: pro Umfrage genau eine Stimme je voter_ref
    unique("votes_poll_voter_unique").on(t.pollId, t.voterRef),
    index("idx_votes_poll_id").on(t.pollId),
    // SIA Loop 5: Composite-Indizes für die realen, tenant-scoped Filter
    // (Ergebnis-Aggregation je Poll + „bereits abgestimmt?"/Teilnahmen je voter_ref).
    index("idx_votes_tenant_poll").on(t.tenantId, t.pollId),
    index("idx_votes_tenant_voter").on(t.tenantId, t.voterRef),
    // CHECK als letztes Sicherheitsnetz für gültige Auswahl
    check(
      "votes_choice_check",
      sql`${t.choice} IN ('ja', 'nein', 'enthaltung')`
    ),
  ]
);

// ---------------------------------------------------------------------------
// Dot-/Budget-Voting (ADR-025). Bewusst SEPARATE Tabellen, damit der bestehende
// Ja/Nein-Pfad (votes) unangetastet bleibt und das Secret-Ballot-Muster
// (voter_ref-Pseudonym, kein User-FK) 1:1 gespiegelt wird.
// ---------------------------------------------------------------------------

// Antwort-Optionen einer dot_voting-Umfrage (bei ja/nein sind die Optionen
// implizit → keine Zeilen). Löschung der Umfrage löscht ihre Optionen.
export const pollOptions = pgTable(
  "poll_options",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    // Tenant-Redundanz für direkte Tenant-Isolation in JEDER Query
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    // Anzeige-/Eingabereihenfolge (stabil, 0-basiert).
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    // Reihenfolge je Umfrage eindeutig → stabile, deterministische Anzeige.
    unique("poll_options_poll_position_unique").on(t.pollId, t.position),
    index("idx_poll_options_poll_id").on(t.pollId),
    index("idx_poll_options_tenant_poll").on(t.tenantId, t.pollId),
  ]
);

// Punkte-Verteilung eines Wählers auf eine Option (dot_voting). EINE Zeile je
// (Wähler, Option). Wie votes: voter_ref-Pseudonym (kein User-FK), Tenant-
// Redundanz, immutable. UNIQUE(poll, voter, option) → Doppelabgabe je Option
// über onConflictDoNothing idempotent (kein Ändern der abgegebenen Stimme).
export const voteAllocations = pgTable(
  "vote_allocations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => pollOptions.id, { onDelete: "cascade" }),
    // Pseudonym: HMAC(SALT, domain) — kein User-FK (Secret Ballot).
    voterRef: text("voter_ref").notNull(),
    // Zugeteilte Punkte auf diese Option (> 0; 0-Zuteilungen werden nicht gespeichert).
    punkte: integer("punkte").notNull(),
    // Snapshot Stufe≥2 bei Abgabe (wie votes.war_verifiziert).
    warVerifiziert: boolean("war_verifiziert").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    // Genau eine Zuteilung je (Umfrage, Wähler, Option).
    unique("vote_allocations_poll_voter_option_unique").on(t.pollId, t.voterRef, t.optionId),
    index("idx_vote_allocations_poll").on(t.pollId),
    index("idx_vote_allocations_tenant_poll").on(t.tenantId, t.pollId),
    index("idx_vote_allocations_tenant_voter").on(t.tenantId, t.voterRef),
    // Punkte müssen positiv sein (0-Zuteilungen gar nicht erst speichern).
    check("vote_allocations_punkte_positiv", sql`${t.punkte} > 0`),
  ]
);

// Widerstandswert eines Wählers für eine Option (widerstandsabfrage, ADR-025).
// EINE Zeile je (Wähler, Option) — und zwar für JEDE Option der Umfrage: die
// vollständige Abgabe ist die Invariante (sichert die Action), sonst wäre die
// Summen-Auswertung verzerrt. Deshalb WIRD wert=0 („keine Einwände") gespeichert
// — anders als bei vote_allocations, wo 0-Zuteilungen entfallen.
// Wie votes/vote_allocations: voter_ref-Pseudonym (kein User-FK, Secret Ballot),
// Tenant-Redundanz, immutable. UNIQUE(poll, voter, option) gegen Doppelabgaben.
export const voteResistances = pgTable(
  "vote_resistances",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    // Tenant-Redundanz für direkte Tenant-Isolation in JEDER Query
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => pollOptions.id, { onDelete: "cascade" }),
    // Pseudonym: HMAC(SALT, domain) — kein User-FK (Secret Ballot).
    voterRef: text("voter_ref").notNull(),
    // Widerstandswert 0–10 (0 = keine Einwände, 10 = starker Widerstand).
    // 0 WIRD gespeichert — vollständige Abgabe je Wähler ist die Invariante.
    wert: integer("wert").notNull(),
    // Snapshot Stufe≥2 bei Abgabe (wie votes.war_verifiziert).
    warVerifiziert: boolean("war_verifiziert").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    // Genau ein Widerstandswert je (Umfrage, Wähler, Option).
    unique("vote_resistances_poll_voter_option_unique").on(t.pollId, t.voterRef, t.optionId),
    index("idx_vote_resistances_poll").on(t.pollId),
    index("idx_vote_resistances_tenant_poll").on(t.tenantId, t.pollId),
    index("idx_vote_resistances_tenant_voter").on(t.tenantId, t.voterRef),
    // Wertebereich als letztes Sicherheitsnetz (serverseitig ohnehin validiert).
    check("vote_resistances_wert_bereich", sql`${t.wert} >= 0 AND ${t.wert} <= 10`),
  ]
);

// ---------------------------------------------------------------------------
// Block L (ADR-028): KI-Neutralitäts-Check — Transparenz-Log.
//
// Jede assisted Neutralitätsprüfung einer Umfrage (Flag AN) wird hier als Zeile
// festgehalten. Zwei Verdicts: `neutral` (Freigabe → Poll wird aktiv) oder
// `angehalten` (Poll geht zurück auf entwurf, mit Begründung an den Ersteller).
// Die KI lehnt NIE final ab — sie hält an; der Mensch bleibt letzte Instanz.
//
// ÖFFENTLICH vs. INTERN (Datensparsamkeit, Transparenz-Wahrheit):
//   - ÖFFENTLICH (Transparenz-Log): Verdict, Begründung, verletzte Regel,
//     prompt_version, modell, Zeitpunkt. Der frage_snapshot wird NUR bei
//     verdict='neutral' gezeigt (die Umfrage wurde ohnehin öffentlich); bei
//     'angehalten' NICHT (die Frage blieb entwurf/nie öffentlich — das Log darf
//     einen evtl. problematischen Wortlaut nicht doch publik machen).
//   - INTERN, NIE öffentlich: geprueft_von (welcher Betreiber). Die öffentliche
//     Sicht selektiert diese Spalte NICHT (Institutionsebene, keine Person).
// PII-frei: der frage_snapshot ist Betreiber-/Institutions-Inhalt (kein
// Personenbezug von Nutzern); geprueft_von ist eine User-UUID (kein Klarname/
// E-Mail) und bleibt der internen Sicht vorbehalten.
// MANIPULATIONSSICHER: poll_id ist ON DELETE SET NULL — Löschen des Entwurfs tilgt
// den öffentlichen „angehalten"-Nachweis NICHT (frage_snapshot bleibt erhalten).
// ---------------------------------------------------------------------------

export const kiPruefungen = pgTable(
  "ki_pruefungen",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Tenant-Redundanz für direkte Tenant-Isolation in JEDER Query (restrict:
    // Tenant-Löschung explizit blockieren, konsistent mit polls/digests).
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Prüfung gehört zur Umfrage. SET NULL statt CASCADE (nullable): löscht der
    // Betreiber den zurückgestellten Entwurf, BLEIBT die Prüf-Zeile bestehen —
    // Manipulationssicherheit, der öffentliche „angehalten"-Nachweis lässt sich
    // nicht durch Löschen des Entwurfs tilgen. Der Frage-Wortlaut steckt ohnehin im
    // frage_snapshot (kein Poll-Join mehr nötig).
    pollId: uuid("poll_id").references(() => polls.id, { onDelete: "set null" }),
    // Frage-Wortlaut ZUM PRÜFZEITPUNKT (Betreiber-/Institutions-Inhalt, kein
    // Wähler-PII → DSGVO-unkritisch). Macht das Log vom Poll unabhängig (überlebt
    // dessen Löschung) und ist der einzige Anzeige-Text. WICHTIG: Bei 'angehalten'
    // wird dieser Wortlaut BEWUSST NICHT öffentlich gerendert (eine angehaltene
    // Frage wurde nie öffentlich; das Log darf sie nicht doch publik machen).
    frageSnapshot: text("frage_snapshot").notNull(),
    // 'neutral' | 'angehalten' — CHECK als letztes Sicherheitsnetz (serverseitig
    // ohnehin per zod validiert).
    verdict: text("verdict").notNull(),
    // Kurzbegründung (max. 2 Sätze; Länge serverseitig per zod begrenzt, nicht DB).
    begruendung: text("begruendung").notNull(),
    // Nur bei 'angehalten' gesetzt — die konkret verletzte Prompt-Regel (nummeriert).
    verletzteRegel: text("verletzte_regel"),
    // Wortgleiche Nachvollziehbarkeit: Version des öffentlichen Prompts + Modell.
    promptVersion: text("prompt_version").notNull(),
    modell: text("modell").notNull(),
    // INTERN: welcher Betreiber die Prüfung eingetragen hat. SET NULL: Konto kann
    // gelöscht werden, die Prüf-Zeile bleibt. NIE im öffentlichen Log selektieren.
    geprueftVon: uuid("geprueft_von").references(() => users.id, {
      onDelete: "set null",
    }),
    // War die Freigabe ein menschlicher Override (Poll wiederholt eingereicht,
    // Prüfer setzt bewusst frei) — auditierbar, im Transparenz-Log neutral geführt.
    istOverride: boolean("ist_override").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("idx_ki_pruefungen_tenant_poll").on(t.tenantId, t.pollId),
    index("idx_ki_pruefungen_tenant_created").on(t.tenantId, t.createdAt.desc()),
    // Wertebereich des Verdicts als DB-Netz.
    check("ki_pruefungen_verdict_check", sql`${t.verdict} IN ('neutral', 'angehalten')`),
  ]
);

// ---------------------------------------------------------------------------
// D4 / ADR-016: Beleg-Code (verifizierbarer, receipt-freier Aufnahme-Beleg)
//
// Pro abgegebener Stimme ein zufälliger Beleg-Code. Der Code beweist, DASS eine
// Stimme im Ergebnis enthalten ist (nach Poll-Ende veröffentlichen wir die anonyme
// Liste aller Codes — der Bürger findet seinen Code wieder), verrät aber NIE, WIE
// abgestimmt wurde.
//
// SECRET BALLOT / DATENSPARSAMKEIT (nicht verhandelbar):
//   - BEWUSST KEINE Spalte voter_ref, choice oder user-FK: der Beleg ist mit
//     WEDER Person NOCH Wahl verkettbar. Die einzige Brücke zur votes-Zeile wäre
//     ein Zeitstempel — deshalb hat diese Tabelle BEWUSST KEIN created_at
//     (Insert-Zeit-Korrelation ausgeschlossen). 1 Beleg je Stimme, in DERSELBEN
//     Transaktion wie der votes-Insert erzeugt (Invariante: #Belege == #Stimmen).
//   - receipt-frei (ADR-016): der Code allein gegen die öffentliche Liste belegt
//     nur die Aufnahme, nie die Wahl → kein Stimmenkauf/Nötigung über den Beleg.
//   - Der Code wird dem Wähler GENAU EINMAL angezeigt und NIE pro Person
//     gespeichert (kein „meinen Beleg erneut zeigen"). Geht er verloren, ist das
//     by design — es entsteht keine dauerhafte Person↔Beleg-Verknüpfung.
//   - Tenant-Isolation: tenant_id-Redundanz; UNIQUE(poll_id, code) erlaubt den
//     kollisionssicheren Insert (onConflictDoNothing + Retry) und O(1)-Lookup.
// ---------------------------------------------------------------------------

export const voteReceipts = pgTable(
  "vote_receipts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Beleg gehört zur Umfrage — Umfrage-Löschung löscht ihre Belege (wie votes)
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    // Tenant-Redundanz für direkte Tenant-Isolation in JEDER Query
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Zufälliger Beleg-Code (Format BELEG-XXXX-XXXX, CSPRNG). KEIN Bezug zu Person/Wahl.
    code: text("code").notNull(),
    // KEIN created_at — siehe Kopfkommentar (Insert-Zeit-Korrelation vermeiden).
  },
  (t) => [
    // Eindeutig je Umfrage → kollisionssicherer Insert + schneller Listen-Lookup.
    unique("vote_receipts_poll_code_unique").on(t.pollId, t.code),
  ]
);

// ---------------------------------------------------------------------------
// ADR-014 Block 2: QR-Verifizierung (Wohnsitz-Verifizierung Stufe 2)
//
// Ein Verifier/Admin/Institution erzeugt einen QR-Code (kurze Gültigkeit +
// Nutzungs-Limit + scope-gebunden). Ein eingeloggter Bürger löst ihn ein und
// erhält die dauerhafte Wohnsitz-Verifizierung (Stufe 2) mit Ablauf.
//
// SICHERHEITS-KERN (Vertrauensprodukt):
//   - Token wie Magic-Link: raw Token (CSPRNG, base64url) verlässt nie den
//     Server; in der DB steht NUR sha256Hex(token) als token_hash (UNIQUE).
//     Der RAW-Token steht ausschließlich im QR-URL. Nicht erratbar.
//   - Cap-Atomarität: redemption_count wird per atomarem bedingten UPDATE erhöht
//     (WHERE redemption_count < max_redemptions) — kein Race-Überlauf.
//   - Idempotenz: UNIQUE(qr_code_id, user_id) → derselbe User kann nicht doppelt
//     einlösen (kein Cap-Verbrauch beim Zweitversuch).
//   - Ablauf/Widerruf: expires_at / revoked_at machen einen QR uneinlösbar.
//   - Tenant-Isolation: tenant_id-Redundanz auf beiden Tabellen.
// ---------------------------------------------------------------------------

export const qrCodes = pgTable(
  "qr_codes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Tenant-Löschung explizit blockieren (konsistent mit polls/anliegen/digests)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // ADR-024 / GEBIETSMODELL §3.2: Gebietsknoten dieses QR-Codes (contract: einzige
    // Ebenen-Quelle; scope_level/scope_code sind entfernt). Die geografische Ebene
    // ergibt sich aus regions.typ/path. RESTRICT: Knoten nicht löschbar. NOT NULL.
    regionId: uuid("region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "restrict" }),
    // SHA-256-Hex des Roh-Tokens — Roh-Token verlässt nie Server-Gedächtnis,
    // steht NUR im QR-URL. UNIQUE für O(1)-Lookup beim Einlösen.
    tokenHash: text("token_hash").notNull().unique(),
    // Freie Bezeichnung für die Admin-Übersicht (z. B. "Bürgerbüro Stand 1")
    label: text("label"),
    // Maximale Anzahl Einlösungen (>= 1, CHECK als letztes Sicherheitsnetz)
    maxRedemptions: integer("max_redemptions").notNull(),
    // Bisherige Einlösungen — atomar bedingt erhöht (kein Cap-Überlauf)
    redemptionCount: integer("redemption_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // SET NULL: Ersteller kann gelöscht werden, QR-Code bleibt (Audit-Spur via audit_events)
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // NULL = aktiv; gesetzt = widerrufen (uneinlösbar)
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("idx_qr_codes_tenant_id").on(t.tenantId),
    index("idx_qr_codes_region_id").on(t.regionId),
    // max_redemptions >= 1 — ein QR mit 0 wäre sinnlos und würde Cap-Logik brechen
    check("qr_codes_max_redemptions_check", sql`${t.maxRedemptions} >= 1`),
    // redemption_count darf das Limit nie überschreiten (DB-Sicherheitsnetz zur
    // atomaren Erhöhung in der Action)
    check(
      "qr_codes_redemption_count_check",
      sql`${t.redemptionCount} >= 0 AND ${t.redemptionCount} <= ${t.maxRedemptions}`
    ),
  ]
);

export const qrRedemptions = pgTable(
  "qr_redemptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Einlösung gehört zum QR-Code — QR-Löschung löscht ihre Einlösungen
    qrCodeId: uuid("qr_code_id")
      .notNull()
      .references(() => qrCodes.id, { onDelete: "cascade" }),
    // User-Löschung löscht dessen Einlösungen
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Tenant-Redundanz für direkte Tenant-Isolation in JEDER Query
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    // Idempotenz: pro QR-Code genau eine Einlösung je User (kein Doppel-Verbrauch)
    unique("qr_redemptions_qr_user_unique").on(t.qrCodeId, t.userId),
    index("idx_qr_redemptions_qr_code_id").on(t.qrCodeId),
  ]
);

// ---------------------------------------------------------------------------
// verification_proofs (Verifizierung 2.0 — V3, „QR-Richtung umdrehen")
//
// Umkehrung der QR-Verifizierung: NICHT der Verifizierer erzeugt einen QR, den
// der Bürger scannt — sondern der EINGELOGGTE Bürger erzeugt einen kurzlebigen,
// einmaligen „Konto-Beleg" (Proof), zeigt dessen QR/Code vor Ort, und der
// Verifizierer scannt/bestätigt ihn nach Ausweis-Prüfung. Der Verifizierer
// erfährt die Bürger-Identität NICHT über diese Tabelle (nur die user_id als
// interner Anker für grantResidency; die UI zeigt sie nie).
//
// SICHERHEITS-DESIGN (analog qr_codes / auth_tokens):
//   - token_hash = sha256Hex(rawToken): der RAW-Token verlässt nie den Server-
//     Speicher (steht nur im QR-Deep-Link/Klartext-Code, EINMALIG beim Erzeugen).
//   - Einmaligkeit + Ablauf: consumed_at (Single-Use) + expires_at (kurze TTL).
//     Der Konsum ist ein atomarer bedingter UPDATE (consumed_at IS NULL AND
//     expires_at > now()) — race-frei, kein Doppel-Grant.
//   - Ein aktiver Proof je Person: das Erzeugen invalidiert vorher offene Proofs.
//   - Tenant-Isolation: JEDE Query/jedes Update ist tenant-scoped.
// ---------------------------------------------------------------------------

export const verificationProofs = pgTable(
  "verification_proofs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Tenant-Löschung explizit blockieren (konsistent mit qr_codes).
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Der Bürger, dessen Konto-Beleg dies ist. User-Löschung löscht seine Belege.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256-Hex des Roh-Tokens — Roh-Token verlässt nie Server-Gedächtnis,
    // steht NUR im Deep-Link/Code. UNIQUE für O(1)-Lookup beim Bestätigen.
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // NULL = offen; gesetzt = eingelöst (Single-Use). Atomar bedingt gesetzt.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // Verifizierer, der den Beleg konsumiert hat (Audit-Spur). SET NULL: der
    // Verifizierer kann gelöscht werden, der Beleg bleibt (Audit via audit_events).
    consumedBy: uuid("consumed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    // Auffinden offener Belege einer Person (Invalidierung/Vorabprüfung).
    index("idx_verification_proofs_tenant_user").on(t.tenantId, t.userId),
  ]
);

// ---------------------------------------------------------------------------
// audit_events
//
// PII-FREI: niemals E-Mail, Name oder direkte User-Identifier in metadata.
// actor_ref ist UUID oder Pseudonym als Text — bewusst KEIN FK auf users,
// da Audit-Einträge bei User-Löschung erhalten bleiben müssen (Compliance).
// ip_hash: HMAC mit IP_HASH_SALT (hashIp). ua_hash: reserviert/aktuell ungenutzt
// (kein UA-Hashing implementiert; Spalte bleibt für künftige Nutzung leer).
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    actorType: actorTypeEnum("actor_type").notNull(),
    // Kein FK — UUID/Pseudonym als Text; bei User-Löschung bleibt Audit erhalten
    actorRef: text("actor_ref"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ipHash: text("ip_hash"),
    uaHash: text("ua_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("idx_audit_tenant_created_at").on(t.tenantId, t.createdAt),
  ]
);

// ---------------------------------------------------------------------------
// Block N — interessenten (B2G-„Mitmachen"-Leads)
//
// Bewusst TENANT-FREI: Ein Lead entsteht VOR der Existenz eines Tenants — eine
// Kommune/ein Verein hinterlässt Interesse (Formular) oder bucht einen Termin
// (Tymeslot-Webhook), lange bevor ein Mandant provisioniert ist. Deshalb KEIN
// tenant_id und KEINE FKs auf tenants/users (anders als jede andere Fach-Tabelle).
// Die Betreiber-Admin-Sicht ist super_admin-gated (kein scopedDb-Zwang, siehe
// admin/interessenten/page.tsx). Hard-Delete durch den Betreiber ist erlaubt
// (kein Konto, keine pseudonyme Verknüpfung).
//
// PII-DESIGN: ansprechpartner/email/nachricht sind Klartext-PII — sie erscheinen
// NIEMALS in audit_events/Logs (dort nur { quelle } bzw. die id). Rechtsgrundlage
// Art. 6 Abs. 1 lit. b/f DSGVO; Löschung auf Anfrage (Hard-Delete-Action).
// ---------------------------------------------------------------------------

export const interessentStatusEnum = pgEnum("interessent_status", [
  "neu",
  "kontaktiert",
  "pilot",
  "abgelehnt",
]);

export const interessenten = pgTable(
  "interessenten",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Organisation (Kommune/Kreis/Verein) — optional, Freitext.
    kommune: text("kommune"),
    // Name der Ansprechperson (Pflicht).
    ansprechpartner: text("ansprechpartner").notNull(),
    // Kontakt-Adresse — immer normalisiert (trim + lowercase) gespeichert.
    // Zweckbindung Kontaktaufnahme; NIEMALS in Logs/Audit.
    email: text("email").notNull(),
    rolle: text("rolle"),
    groesse: text("groesse"),
    nachricht: text("nachricht"),
    // Lead-Herkunft: 'formular' | 'tymeslot'. Bewusst text (kein Enum) — nur
    // zwei interne Werte, serverseitig gesetzt, kein Nutzer-Input.
    quelle: text("quelle").notNull(),
    // Idempotenz-Schlüssel des Tymeslot-Webhooks (nur bei quelle='tymeslot').
    tymeslotMeetingUid: text("tymeslot_meeting_uid"),
    // Terminzeitpunkt aus dem Webhook (start_time), nullable.
    terminAm: timestamp("termin_am", { withTimezone: true }),
    status: interessentStatusEnum("status").notNull().default("neu"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_interessenten_created_at").on(t.createdAt.desc()),
    // Webhook-Idempotenz: mehrfache Zustellung DESSELBEN Meetings erzeugt EINEN
    // Lead. Partiell — Formular-Leads (uid NULL) sind davon unberührt.
    uniqueIndex("interessenten_tymeslot_uid_unique")
      .on(t.tymeslotMeetingUid)
      .where(sql`${t.tymeslotMeetingUid} IS NOT NULL`),
  ]
);
