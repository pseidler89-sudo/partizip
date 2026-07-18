/**
 * composer-autoritaet.test.ts — Gebiets-Autorität der Poll-Erstellung/-Verwaltung
 * (Block H). Zwei Ebenen:
 *
 *   1. REINE Funktion `pollGebietErlaubt` (kein DB) — der Autoritäts-Kern.
 *   2. INTEGRATION gegen echte PG16 (Muster lifecycle.test.ts): `erlaubteZielGebiete`
 *      (Picker-Feed) + die ECHTEN Actions `pollErstellen`/`pollAktivieren`/
 *      `pollSchliessen`/`pollEntwurfLoeschen` mit gemockten Request-Kontext.
 *
 * Kern-Eigenschaften (Vertrauensprodukt):
 *   - kommune_admin ist an sein roles.region_id-Gebiet gebunden (Scheibe abwärts).
 *   - Die bestehende Lücke ist geschlossen: ein Gemeinde-Admin kann per direktem
 *     Action-Aufruf mit scopeLevel:"kreis" KEINE Poll erstellen.
 *   - Symmetrie: aktivieren/schließen/löschen außerhalb des Gebiets abgelehnt.
 *   - super_admin bypasst die Gebietsbindung; der Feed bleibt die Gemeinde-Scheibe.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (die reinen Tests laufen immer).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

process.env.ANLIEGEN_REF_SALT ??= "test-composer-h-salt-aaaaaaaaaaaaaaaaaaaa";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { sha256Hex } from "@/lib/auth/crypto";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { getUserRolesMitScope, type RoleScopeRow } from "@/lib/auth/roles";
import {
  pollGebietErlaubt,
  erlaubteZielGebiete,
} from "@/lib/polls/composer-autoritaet";

const { tenants, users, roles, sessions, ortsteile, polls, auditEvents } = schema;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");

const TEST_DB_URL = process.env.DATABASE_URL_TEST;
if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test"`);
  }
}
const SKIP = !TEST_DB_URL;

// ---------------------------------------------------------------------------
// 1) REINE Funktion pollGebietErlaubt — läuft immer (kein DB)
// ---------------------------------------------------------------------------

describe("pollGebietErlaubt (reine Funktion)", () => {
  const GEMEINDE = "de.hessen.rtk.taunusstein";
  const OT_A = "de.hessen.rtk.taunusstein.ot_a";
  const OT_B = "de.hessen.rtk.taunusstein.ot_b";
  const KREIS = "de.hessen.rtk";

  const rolle = (roleType: string, regionPath: string): RoleScopeRow => ({
    roleType,
    regionTyp: "gemeinde",
    regionPath,
  });

  it("super_admin bypasst die Gebietsbindung (jedes Ziel erlaubt)", () => {
    expect(pollGebietErlaubt([], true, KREIS)).toBe(true);
    expect(pollGebietErlaubt([rolle("super_admin", OT_A)], true, KREIS)).toBe(true);
  });

  it("Gemeinde-Admin: deckt stadt + eigene Ortsteile, NICHT kreis/land", () => {
    const scopes = [rolle("kommune_admin", GEMEINDE)];
    expect(pollGebietErlaubt(scopes, false, GEMEINDE)).toBe(true); // stadt
    expect(pollGebietErlaubt(scopes, false, OT_A)).toBe(true); // Ortsteil (Nachfahr)
    expect(pollGebietErlaubt(scopes, false, OT_B)).toBe(true);
    expect(pollGebietErlaubt(scopes, false, KREIS)).toBe(false); // Vorfahr → NICHT
  });

  it("Ortsteil-gebundener Admin: nur eigener Ortsteil (nicht Gemeinde, nicht Nachbar)", () => {
    const scopes = [rolle("kommune_admin", OT_A)];
    expect(pollGebietErlaubt(scopes, false, OT_A)).toBe(true);
    expect(pollGebietErlaubt(scopes, false, OT_B)).toBe(false);
    expect(pollGebietErlaubt(scopes, false, GEMEINDE)).toBe(false);
  });

  it("Nicht-Autoritäts-Rollen zählen nicht (fail-closed)", () => {
    expect(pollGebietErlaubt([rolle("redakteur", GEMEINDE)], false, GEMEINDE)).toBe(false);
    expect(pollGebietErlaubt([rolle("verifier", GEMEINDE)], false, GEMEINDE)).toBe(false);
    expect(pollGebietErlaubt([rolle("beobachter", GEMEINDE)], false, GEMEINDE)).toBe(false);
    expect(pollGebietErlaubt([], false, GEMEINDE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2) INTEGRATION — Feed + echte Actions (gemockter Request-Kontext)
// ---------------------------------------------------------------------------

const mockHost = "test.localhost";
let mockSessionToken: string | null = null;
let mockTenantRow: { id: string; slug: string; name: string } | null = null;
let mockDbForActions: ReturnType<typeof drizzle> | null = null;

vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => (k === "host" ? mockHost : null) }),
  cookies: () => ({
    get: (name: string) =>
      name === "partizip_session" && mockSessionToken
        ? { value: mockSessionToken }
        : undefined,
    set: () => {},
  }),
}));

vi.mock("@/lib/tenant", () => ({
  getTenantFromHost: async () => mockTenantRow,
}));

vi.mock("@/db/client", () => ({
  createDb: () => mockDbForActions,
}));

describe("composer-autoritaet (Integration, echte Actions)", () => {
  let sql_: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  let tenantId: string;

  let gemeindeAdminId: string;
  let ortsteilAdminId: string; // kommune_admin, aber Rolle NUR auf OT-A
  let superAdminId: string;

  let gemeindeId: string;
  let otAId: string;
  let otBId: string;
  let kreisId: string;

  const tokens: Record<string, string> = {};

  let pollErstellen: typeof import("@/lib/polls/actions").pollErstellen;
  let pollAktivieren: typeof import("@/lib/polls/actions").pollAktivieren;
  let pollSchliessen: typeof import("@/lib/polls/actions").pollSchliessen;
  let pollEntwurfLoeschen: typeof import("@/lib/polls/actions").pollEntwurfLoeschen;

  let counter = 0;
  const nextSlug = (p: string) => `${p}-${Date.now()}-${++counter}`;

  /** Legt einen Admin (roleType @ regionId) + Session an; merkt sich den Token. */
  async function makeAdmin(
    key: string,
    roleType: "kommune_admin" | "super_admin",
    regionId: string,
  ) {
    const [u] = await db
      .insert(users)
      .values({ tenantId, email: `${key}-${Date.now()}@h.de`, minAgeConfirmedAt: new Date() })
      .returning();
    await db.insert(roles).values({ tenantId, userId: u.id, roleType, regionId });
    const raw = `tok-${key}-${Date.now()}-${++counter}`;
    await db.insert(sessions).values({
      tenantId,
      userId: u.id,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    tokens[key] = raw;
    return u.id;
  }

  const loginAls = (key: string) => {
    mockSessionToken = tokens[key];
  };

  async function scopesOf(userId: string): Promise<RoleScopeRow[]> {
    return getUserRolesMitScope(db as never, tenantId, userId);
  }

  async function createPollAt(regionId: string, status: "entwurf" | "aktiv" | "geschlossen") {
    const [p] = await db
      .insert(polls)
      .values({
        tenantId,
        regionId,
        frage: `Frage ${++counter}?`,
        typ: "ja_nein_enthaltung",
        status,
      })
      .returning();
    return p;
  }

  beforeAll(async () => {
    if (SKIP) return;

    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_, { schema });
    await migrate(db, { migrationsFolder });
    mockDbForActions = db;

    const [t] = await db
      .insert(tenants)
      .values({ slug: nextSlug("h"), name: "Block-H-Test" })
      .returning();
    tenantId = t.id;
    mockTenantRow = { id: t.id, slug: t.slug, name: t.name };

    // Ortsteile (Reverse-Lookup für den Feed braucht die ortsteile-Tabelle).
    await db.insert(ortsteile).values([
      { tenantId, code: "OT-A", name: "Ortsteil A" },
      { tenantId, code: "OT-B", name: "Ortsteil B" },
    ]);

    // Baum-Knoten via Scope→region_id provisionieren (GUC in der Test-DB an).
    gemeindeId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    otAId = await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "OT-A");
    otBId = await resolveRegionIdForScope(db as never, tenantId, "ortsteil", "OT-B");
    kreisId = await resolveRegionIdForScope(db as never, tenantId, "kreis", null);

    gemeindeAdminId = await makeAdmin("gem", "kommune_admin", gemeindeId);
    ortsteilAdminId = await makeAdmin("ota", "kommune_admin", otAId);
    superAdminId = await makeAdmin("sup", "super_admin", gemeindeId);

    const actions = await import("@/lib/polls/actions");
    pollErstellen = actions.pollErstellen;
    pollAktivieren = actions.pollAktivieren;
    pollSchliessen = actions.pollSchliessen;
    pollEntwurfLoeschen = actions.pollEntwurfLoeschen;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  // --- Picker-Feed ----------------------------------------------------------

  it.skipIf(SKIP)("erlaubteZielGebiete: Gemeinde-Admin → Gemeinde + beide Ortsteile, kein kreis/land", async () => {
    const feed = await erlaubteZielGebiete(db as never, tenantId, await scopesOf(gemeindeAdminId), false);
    const stadt = feed.filter((g) => g.scopeLevel === "stadt");
    const orts = feed.filter((g) => g.scopeLevel === "ortsteil");
    expect(stadt).toHaveLength(1);
    expect(stadt[0].typ).toBe("gemeinde");
    expect(stadt[0].scopeCode).toBeNull();
    expect(orts.map((g) => g.scopeCode).sort()).toEqual(["OT-A", "OT-B"]);
    expect(orts.every((g) => g.typ === "ortsteil")).toBe(true);
    // Niemals kreis/land im Feed.
    expect(feed.every((g) => g.scopeLevel === "stadt" || g.scopeLevel === "ortsteil")).toBe(true);
    // Gemeinde zuerst (stabile Sortierung).
    expect(feed[0].typ).toBe("gemeinde");
  });

  it.skipIf(SKIP)("erlaubteZielGebiete: Ortsteil-gebundener Admin → nur eigener Ortsteil", async () => {
    const feed = await erlaubteZielGebiete(db as never, tenantId, await scopesOf(ortsteilAdminId), false);
    expect(feed).toHaveLength(1);
    expect(feed[0].scopeLevel).toBe("ortsteil");
    expect(feed[0].scopeCode).toBe("OT-A");
  });

  it.skipIf(SKIP)("erlaubteZielGebiete: super_admin → volle Gemeinde-Scheibe, kein kreis/land", async () => {
    const feed = await erlaubteZielGebiete(db as never, tenantId, await scopesOf(superAdminId), true);
    expect(feed.filter((g) => g.scopeLevel === "stadt")).toHaveLength(1);
    expect(feed.filter((g) => g.scopeLevel === "ortsteil")).toHaveLength(2);
    expect(feed.every((g) => g.scopeLevel === "stadt" || g.scopeLevel === "ortsteil")).toBe(true);
  });

  it.skipIf(SKIP)("Demo-Fence: der Feed gemeinde-only gefiltert (wie page.tsx) hat keinen Ortsteil", async () => {
    const feed = await erlaubteZielGebiete(db as never, tenantId, await scopesOf(gemeindeAdminId), false);
    const demoFeed = feed.filter((g) => g.typ === "gemeinde");
    expect(demoFeed.every((g) => g.scopeLevel === "stadt")).toBe(true);
    expect(demoFeed.some((g) => g.scopeLevel === "ortsteil")).toBe(false);
  });

  // --- pollErstellen: Durchsetzung + Lücken-Fix -----------------------------

  it.skipIf(SKIP)("pollErstellen: Gemeinde-Admin darf stadt UND eigenen Ortsteil", async () => {
    loginAls("gem");
    const rStadt = await pollErstellen({ frage: "Marktplatz autofrei?", scopeLevel: "stadt" });
    expect(rStadt.ok).toBe(true);
    const rOrt = await pollErstellen({ frage: "Spielplatz im Ortsteil A?", scopeLevel: "ortsteil", scopeCode: "OT-A" });
    expect(rOrt.ok).toBe(true);
  });

  it.skipIf(SKIP)("pollErstellen: Gemeinde-Admin darf NICHT kreis (bestehende Lücke geschlossen)", async () => {
    loginAls("gem");
    const before = (await db.select().from(polls).where(eq(polls.tenantId, tenantId))).length;
    const res = await pollErstellen({ frage: "Kreisweite Frage?", scopeLevel: "kreis" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/berechtigt/i);
    // Keine Poll angelegt.
    const after = (await db.select().from(polls).where(eq(polls.tenantId, tenantId))).length;
    expect(after).toBe(before);
    // Verstoß PII-frei protokolliert.
    const denied = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "poll.create_denied"), eq(auditEvents.tenantId, tenantId)));
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(denied[denied.length - 1].metadata)).not.toContain("@");
  });

  it.skipIf(SKIP)("pollErstellen: Ortsteil-Admin darf eigenen Ortsteil, NICHT Nachbar-Ortsteil, NICHT stadt", async () => {
    loginAls("ota");
    expect((await pollErstellen({ frage: "OT-A eigene Frage?", scopeLevel: "ortsteil", scopeCode: "OT-A" })).ok).toBe(true);
    const fremd = await pollErstellen({ frage: "OT-B fremde Frage?", scopeLevel: "ortsteil", scopeCode: "OT-B" });
    expect(fremd.ok).toBe(false);
    expect(fremd.error).toMatch(/berechtigt/i);
    const stadt = await pollErstellen({ frage: "Stadtweite Frage?", scopeLevel: "stadt" });
    expect(stadt.ok).toBe(false);
  });

  it.skipIf(SKIP)("pollErstellen: super_admin darf die Gemeinde-Scheibe (bypass)", async () => {
    loginAls("sup");
    expect((await pollErstellen({ frage: "Super stadtweite Frage?", scopeLevel: "stadt" })).ok).toBe(true);
    expect((await pollErstellen({ frage: "Super Ortsteil-Frage?", scopeLevel: "ortsteil", scopeCode: "OT-B" })).ok).toBe(true);
  });

  it.skipIf(SKIP)("pollErstellen: auch super_admin darf per Action KEINE kreis/land-Poll anlegen (Ebenen-Grenze hart)", async () => {
    // H bleibt bewusst abwärts: der super_admin-Bypass gilt der Gebiets-Bindung,
    // NICHT der Ebenen-Grenze. kreis/land = Separate-Tenant-Modell (PR #49).
    loginAls("sup");
    const before = (await db.select().from(polls).where(eq(polls.tenantId, tenantId))).length;
    const res = await pollErstellen({ frage: "Super kreisweite Frage?", scopeLevel: "kreis" });
    expect(res.ok).toBe(false);
    const after = (await db.select().from(polls).where(eq(polls.tenantId, tenantId))).length;
    expect(after).toBe(before);
  });

  // --- Symmetrie: aktivieren/schließen/löschen außerhalb des Gebiets --------

  it.skipIf(SKIP)("Symmetrie: Gemeinde-Admin kann kreis-Poll NICHT aktivieren/schließen/löschen", async () => {
    loginAls("gem");
    const entwurf = await createPollAt(kreisId, "entwurf");
    expect((await pollAktivieren(entwurf.id)).ok).toBe(false);
    expect((await pollEntwurfLoeschen(entwurf.id)).ok).toBe(false);
    const aktiv = await createPollAt(kreisId, "aktiv");
    const zu = await pollSchliessen(aktiv.id);
    expect(zu.ok).toBe(false);
    expect(zu.error).toMatch(/berechtigt/i);
    // Unverändert.
    const [row] = await db.select().from(polls).where(eq(polls.id, aktiv.id));
    expect(row.status).toBe("aktiv");
  });

  it.skipIf(SKIP)("Symmetrie: Ortsteil-Admin (OT-A) kann OT-B-Poll nicht schließen; Gemeinde-Admin schon", async () => {
    const p = await createPollAt(otBId, "aktiv");
    loginAls("ota");
    expect((await pollSchliessen(p.id)).ok).toBe(false);
    loginAls("gem");
    expect((await pollSchliessen(p.id)).ok).toBe(true); // Gemeinde deckt Ortsteil ab
  });

  it.skipIf(SKIP)("Symmetrie: super_admin schließt auch eine kreis-Poll (bypass)", async () => {
    const p = await createPollAt(kreisId, "aktiv");
    loginAls("sup");
    expect((await pollSchliessen(p.id)).ok).toBe(true);
  });
});
