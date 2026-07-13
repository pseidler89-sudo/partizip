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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

export const scopeLevelEnum = pgEnum("scope_level", [
  "ortsteil",
  "stadt",
  "kreis",
  "land",
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
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    unique("users_tenant_email_unique").on(t.tenantId, t.email),
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
    scopeLevel: scopeLevelEnum("scope_level").notNull(),
    scopeCode: text("scope_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // M1: NULLS NOT DISTINCT — NULL scope_code gilt als eindeutiger Wert im Constraint
    unique("roles_tenant_user_role_scope_unique")
      .on(t.tenantId, t.userId, t.roleType, t.scopeLevel, t.scopeCode)
      .nullsNotDistinct(),
  ]
);

// ---------------------------------------------------------------------------
// verification_locations
// ---------------------------------------------------------------------------

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
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // M6: $onUpdate
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`).$onUpdate(() => new Date()),
  },
  (t) => [
    // Natürlicher Key für Idempotenz beim Seeding: Standort-Name ist pro Tenant eindeutig
    unique("verification_locations_tenant_name_unique").on(t.tenantId, t.name),
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
    // Konto-Löschung (DSGVO) entfernt die Buchung mit.
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
    scopeLevel: scopeLevelEnum("scope_level").notNull(),
    scopeCode: text("scope_code"),
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
]);

// Vorerst nur ja/nein/enthaltung — Enum bewusst erweiterbar gehalten.
export const pollTypeEnum = pgEnum("poll_type", [
  "ja_nein_enthaltung",
]);

export const polls = pgTable(
  "polls",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Tenant-Löschung explizit blockieren (konsistent mit anliegen/digests)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Geografische Ebene der Frage (bestehender scope_level-Enum wiederverwendet)
    scopeLevel: scopeLevelEnum("scope_level").notNull(),
    // Optionaler Scope-Code (z. B. Ortsteil-Code) — analog roles.scope_code
    scopeCode: text("scope_code"),
    frage: text("frage").notNull(),
    typ: pollTypeEnum("typ").notNull().default("ja_nein_enthaltung"),
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
    // Gehashte IP (HMAC) — optional, nur für Missbrauchsanalyse; PII-frei
    ipHash: text("ip_hash"),
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
    // Geografische Ebene der Verifizierung (bestehender scope_level-Enum)
    scopeLevel: scopeLevelEnum("scope_level").notNull(),
    // Optionaler Scope-Code (z. B. Ortsteil-Code) — analog roles.scope_code
    scopeCode: text("scope_code"),
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
