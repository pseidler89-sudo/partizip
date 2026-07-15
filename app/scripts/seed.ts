/**
 * Seed-Runner — idempotent (zweimaliges Ausführen erhöht Zeilenzahlen NICHT)
 *
 * Liest JSON-Seeds aus db/seeds/, upsertet alle Daten via ON CONFLICT,
 * schreibt am Ende ein audit_event "seed.completed" (actor_type: system, PII-frei).
 * audit_events wächst pro Lauf um genau 1 seed.completed — gewollt (Audit-Trail).
 *
 * Idempotenz-Strategie für anliegen_events + verification_slots:
 *   Deterministische UUIDs via uuid-v5 aus natürlichem Schlüssel:
 *   - anliegen_events: uuid5(NS, "anliegen:<trackingCode>:event:<index>")
 *   - verification_slots: uuid5(NS, "slot:<locationName>:<startsAtISO>")
 *   Insert mit explizitem onConflictDoNothing({ target: <tabelle>.id })
 *
 * Verwendung: npm run db:seed
 * Env: DATABASE_URL (default: postgres://partizip:partizip@127.0.0.1:5433/partizip)
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  tenants,
  ortsteile,
  plzRegionen,
  polls,
  verificationLocations,
  verificationSlots,
  anliegen,
  anliegenEvents,
  auditEvents,
  risBodies,
} from "../src/db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedsDir = path.resolve(__dirname, "../../db/seeds");

function readSeed<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(seedsDir, file), "utf-8")) as T;
}

// Deterministische UUID v5: geteilter Helfer (scripts/seed-utils.ts).
import { SEED_NAMESPACE, uuidV5, resolveRegionId } from "./seed-utils.js";
import { seedRegions } from "./seed-regions.js";

// ---------------------------------------------------------------------------
// Types matching seed JSONs
// ---------------------------------------------------------------------------

interface TenantSeed {
  slug: string;
  name: string;
  primaryColor?: string;
  welcomeText?: string;
}

interface OrtsteilSeed {
  tenantSlug: string;
  code: string;
  name: string;
}

interface SlotSeed {
  startsAt: string;
  endsAt: string;
  capacity: number;
}

interface LocationSeed {
  tenantSlug: string;
  name: string;
  address?: string;
  hinweise?: string;
  lat?: string;
  lon?: string;
  isActive: boolean;
  slots: SlotSeed[];
}

interface EventSeed {
  status: string;
  notiz?: string | null;
  quelle?: string | null;
}

interface AnliegenSeed {
  tenantSlug: string;
  trackingCode: string;
  creatorRef: string;
  titel: string;
  beschreibung?: string;
  ortsteilCode?: string;
  events: EventSeed[];
}

interface RisBodySeed {
  tenantSlug: string;
  key: string;
  name?: string;
  risType: string;
  baseUrl: string;
  isActive: boolean;
}

interface PlzRegionSeed {
  tenantSlug: string;
  plz: string;
  ortsteilCode?: string | null;
  lat?: string | null;
  lon?: string | null;
}

interface PollSeed {
  seedKey: string;
  tenantSlug: string;
  scopeLevel: "ortsteil" | "stadt" | "kreis" | "land";
  scopeCode?: string | null;
  frage: string;
  verbindlich?: boolean;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";

async function main() {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  // ----- 1. Tenants --------------------------------------------------------
  const tenantSeeds = readSeed<TenantSeed[]>("tenants.json");
  const tenantIdBySlug = new Map<string, string>();

  for (const t of tenantSeeds) {
    const [row] = await db
      .insert(tenants)
      .values({
        slug: t.slug,
        name: t.name,
        primaryColor: t.primaryColor ?? null,
        welcomeText: t.welcomeText ?? null,
      })
      .onConflictDoUpdate({
        target: tenants.slug,
        set: {
          name: t.name,
          primaryColor: t.primaryColor ?? null,
          welcomeText: t.welcomeText ?? null,
          updatedAt: new Date(), // M6: updatedAt explizit im onConflictDoUpdate
        },
      })
      .returning({ id: tenants.id });
    tenantIdBySlug.set(t.slug, row.id);
    console.log(`tenant: ${t.slug} → ${row.id}`);
  }

  // ----- 2. Ortsteile ------------------------------------------------------
  const ortsteilSeeds = readSeed<OrtsteilSeed[]>("ortsteile.json");
  const ortsteilIdByCode = new Map<string, string>(); // "tenantSlug:code" → id

  for (const o of ortsteilSeeds) {
    const tenantId = tenantIdBySlug.get(o.tenantSlug);
    if (!tenantId) throw new Error(`Unknown tenant slug: ${o.tenantSlug}`);

    const [row] = await db
      .insert(ortsteile)
      .values({ tenantId, code: o.code, name: o.name })
      .onConflictDoUpdate({
        target: [ortsteile.tenantId, ortsteile.code],
        set: {
          name: o.name,
          updatedAt: new Date(), // M6
        },
      })
      .returning({ id: ortsteile.id });
    ortsteilIdByCode.set(`${o.tenantSlug}:${o.code}`, row.id);
  }
  console.log(`ortsteile: ${ortsteilSeeds.length} upserted`);

  // ----- 4b. Gebietsbaum (ADR-024, ETAPPE 2) -------------------------------
  // VOR den Fachtabellen mit region_id (verification_locations/polls/roles/qr):
  // der Pilot-Baum + Backfill muss stehen, damit der region_id-Trigger die echten
  // Knoten trifft (statt via Sicherheitsnetz eine synthetische Gemeinde anzulegen).
  // Idempotent; die PLZ↔Region-Spiegelung ergänzt später `npm run db:seed:regions`.
  await seedRegions(db as never);
  console.log("regions: Pilot-Baum geseedet (ADR-024)");

  // ----- 3. Verification Locations + Slots ---------------------------------
  const locationSeeds = readSeed<LocationSeed[]>("verification_locations.json");

  for (const loc of locationSeeds) {
    const tenantId = tenantIdBySlug.get(loc.tenantSlug);
    if (!tenantId) throw new Error(`Unknown tenant slug: ${loc.tenantSlug}`);

    // Natural key: (tenant_id, name) — unique constraint in schema
    const [locRow] = await db
      .insert(verificationLocations)
      .values({
        tenantId,
        name: loc.name,
        address: loc.address ?? null,
        hinweise: loc.hinweise ?? null,
        lat: loc.lat ?? null,
        lon: loc.lon ?? null,
        isActive: loc.isActive,
      })
      .onConflictDoUpdate({
        target: [verificationLocations.tenantId, verificationLocations.name],
        set: {
          address: loc.address ?? null,
          hinweise: loc.hinweise ?? null,
          isActive: loc.isActive,
          updatedAt: new Date(), // M6
        },
      })
      .returning({ id: verificationLocations.id });

    const locationId = locRow.id;

    // Slots: Idempotenz allein über den natürlichen Schlüssel (location_id, starts_at).
    // BEWUSST KEINE deterministische uuid5(name:startsAt)-ID mehr: gleichnamige
    // Standorte (z. B. ein „taunusstein"- UND ein „taunusstein-staging"-Tenant mit je
    // „Rathaus Taunusstein (Beispiel)") erzeugten dieselbe uuid5 und kollidierten beim
    // Re-Seed auf dem PRIMARY KEY (der (location_id, starts_at)-ON-CONFLICT-Arbiter
    // greift bei unterschiedlicher location_id nicht). gen_random_uuid() + der
    // natürliche Unique-Key ist robust und bleibt voll idempotent.
    for (const slot of loc.slots) {
      await db
        .insert(verificationSlots)
        .values({
          locationId,
          startsAt: new Date(slot.startsAt),
          endsAt: new Date(slot.endsAt),
          capacity: slot.capacity,
        })
        .onConflictDoNothing({
          target: [verificationSlots.locationId, verificationSlots.startsAt],
        });
    }
    console.log(`location: "${loc.name}" → ${loc.slots.length} slots`);
  }

  // ----- 4. Anliegen + Events ----------------------------------------------
  // SEED_SKIP_DEMO_CONTENT=1 (Prod-Launch): Stammdaten (Tenant/Ortsteile/PLZ/
  // Verifizierungs-Standorte/RIS) ja — Beispiel-Anliegen und Demo-Polls NEIN.
  // Auf der echten Haupt-Domain dürfen keine geseedeten Beispiel-Inhalte als
  // echte kommunale Vorgänge erscheinen (Ehrlichkeits-Leitplanke); die erste
  // echte Frage legt der Admin im Composer an.
  const skipDemoContent = process.env.SEED_SKIP_DEMO_CONTENT === "1";

  const anliegenSeeds = skipDemoContent
    ? []
    : readSeed<AnliegenSeed[]>("anliegen.json");
  if (skipDemoContent) console.log("anliegen: übersprungen (SEED_SKIP_DEMO_CONTENT)");

  for (const a of anliegenSeeds) {
    const tenantId = tenantIdBySlug.get(a.tenantSlug);
    if (!tenantId) throw new Error(`Unknown tenant slug: ${a.tenantSlug}`);

    const ortsteilId = a.ortsteilCode
      ? (ortsteilIdByCode.get(`${a.tenantSlug}:${a.ortsteilCode}`) ?? null)
      : null;

    // N3: Status des Anliegen = Status des letzten Events
    const lastEventStatus = a.events.length > 0
      ? a.events[a.events.length - 1].status
      : "eingegangen";

    const [anlRow] = await db
      .insert(anliegen)
      .values({
        tenantId,
        trackingCode: a.trackingCode,
        creatorRef: a.creatorRef,
        titel: a.titel,
        beschreibung: a.beschreibung ?? null,
        ortsteilId: ortsteilId ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: lastEventStatus as any,
      })
      .onConflictDoUpdate({
        target: anliegen.trackingCode,
        set: {
          titel: a.titel,
          beschreibung: a.beschreibung ?? null,
          // N3: Status auch im Update auf letzten Event-Status setzen
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: lastEventStatus as any,
          updatedAt: new Date(), // M6
        },
      })
      .returning({ id: anliegen.id });

    // Events: deterministische UUID aus "anliegen:<trackingCode>:event:<index>"
    // B1: expliziter target auf id → onConflictDoNothing bei selbem UUID (idempotent)
    for (let i = 0; i < a.events.length; i++) {
      const ev = a.events[i];
      const eventId = uuidV5(
        SEED_NAMESPACE,
        `anliegen:${a.trackingCode}:event:${i}`
      );
      await db
        .insert(anliegenEvents)
        .values({
          id: eventId,
          anliegenId: anlRow.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: ev.status as any,
          notiz: ev.notiz ?? null,
          quelle: ev.quelle ?? null,
        })
        .onConflictDoNothing({ target: anliegenEvents.id });
    }
  }
  console.log(`anliegen: ${anliegenSeeds.length} upserted`);

  // ----- 5. RIS-Bodies (M7) ------------------------------------------------
  const risBodiesSeeds = readSeed<RisBodySeed[]>("ris_bodies.json");

  for (const rb of risBodiesSeeds) {
    const tenantId = tenantIdBySlug.get(rb.tenantSlug);
    if (!tenantId) throw new Error(`Unknown tenant slug: ${rb.tenantSlug}`);

    await db
      .insert(risBodies)
      .values({
        tenantId,
        key: rb.key,
        name: rb.name ?? null,
        risType: rb.risType,
        baseUrl: rb.baseUrl,
        isActive: rb.isActive,
      })
      .onConflictDoUpdate({
        target: [risBodies.tenantId, risBodies.key],
        set: {
          name: rb.name ?? null,
          risType: rb.risType,
          baseUrl: rb.baseUrl,
          isActive: rb.isActive,
        },
      });
    console.log(`ris_body: ${rb.tenantSlug}/${rb.key} → ${rb.risType}`);
  }

  // ----- 5b. PLZ-Regionen (ADR-015) ----------------------------------------
  const plzRegionSeeds = readSeed<PlzRegionSeed[]>("plz_regionen.json");

  for (const pr of plzRegionSeeds) {
    const tenantId = tenantIdBySlug.get(pr.tenantSlug);
    if (!tenantId) throw new Error(`Unknown tenant slug: ${pr.tenantSlug}`);

    await db
      .insert(plzRegionen)
      .values({
        tenantId,
        plz: pr.plz,
        ortsteilCode: pr.ortsteilCode ?? null,
        lat: pr.lat ?? null,
        lon: pr.lon ?? null,
      })
      .onConflictDoUpdate({
        // Natürlicher Schlüssel (plz, ortsteil_code), NULLS NOT DISTINCT.
        target: [plzRegionen.plz, plzRegionen.ortsteilCode],
        set: {
          tenantId,
          lat: pr.lat ?? null,
          lon: pr.lon ?? null,
          updatedAt: new Date(),
        },
      });
  }
  console.log(`plz_regionen: ${plzRegionSeeds.length} upserted`);

  // ----- 5c. Demo-Polls je Ebene (ADR-015) ---------------------------------
  // Deterministische UUID aus seedKey → idempotent (onConflictDoNothing).
  // Status 'aktiv' + opensAt jetzt, damit die nested-scope-Sicht demonstrierbar
  // ist. Vorhandene (ggf. vom Admin bearbeitete) Polls bleiben unangetastet.
  const pollSeeds = skipDemoContent ? [] : readSeed<PollSeed[]>("polls.json");
  if (skipDemoContent) console.log("polls: übersprungen (SEED_SKIP_DEMO_CONTENT)");

  for (const p of pollSeeds) {
    const tenantId = tenantIdBySlug.get(p.tenantSlug);
    if (!tenantId) throw new Error(`Unknown tenant slug: ${p.tenantSlug}`);

    const pollId = uuidV5(SEED_NAMESPACE, `poll:${p.seedKey}`);
    // ADR-024 contract: Scope-Eingabe → region_id (Trigger ist im contract entfernt).
    const regionId = await resolveRegionId(db, tenantId, p.scopeLevel, p.scopeCode ?? null);
    await db
      .insert(polls)
      .values({
        id: pollId,
        tenantId,
        regionId,
        frage: p.frage,
        typ: "ja_nein_enthaltung",
        status: "aktiv",
        verbindlich: p.verbindlich ?? false,
        opensAt: new Date(),
      })
      .onConflictDoNothing({ target: polls.id });
  }
  console.log(`polls: ${pollSeeds.length} demo polls upserted`);

  // ----- 6. Audit event ----------------------------------------------------
  // PII-frei: keine E-Mail, kein Name in metadata
  // Wächst pro Lauf um genau 1 seed.completed — gewollt (Audit-Trail)
  await db.insert(auditEvents).values({
    tenantId: null,
    actorType: "system",
    actorRef: null,
    action: "seed.completed",
    metadata: {
      source: "scripts/seed.ts",
      tenants: Array.from(tenantIdBySlug.keys()),
      ortsteile: ortsteilSeeds.length,
      locations: locationSeeds.length,
      anliegen: anliegenSeeds.length,
      risBodies: risBodiesSeeds.length,
      plzRegionen: plzRegionSeeds.length,
      polls: pollSeeds.length,
    },
  });

  console.log("Seeding completed.");
  await sql.end();
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
