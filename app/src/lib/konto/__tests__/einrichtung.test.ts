/**
 * einrichtung.test.ts — Einrichtungs-Checkliste (lib/konto/einrichtung.ts).
 *
 * Teil 1 (reine Unit-Tests, laufen immer): naechsterSchritt — exakte Priorität
 * wohnort → verifizierung → benachrichtigung → teilnahme, alles erledigt → null,
 * exhaustiv über alle 16 Status-Kombinationen.
 *
 * Teil 2 (DB-Integration, NUR mit DATABASE_URL_TEST — Muster
 * polls/__tests__/queries.test.ts): getEinrichtungsStatus gegen die echten
 * Tabellen. Teilnahme-Existenz je über votes, vote_allocations UND
 * vote_resistances (voter_ref via computeVoterRefForUser, ANLIEGEN_REF_SALT-Env
 * wie im Muster-Test) sowie Tenant-Isolation (Stimme im Fremd-Tenant zählt nicht).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

process.env.ANLIEGEN_REF_SALT ??= "test-einrichtung-salt-aaaaaaaaaaaaaaaa";

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, set: () => {} }),
  headers: () => ({ get: () => null }),
}));

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema.js";
import {
  getEinrichtungsStatus,
  naechsterSchritt,
  type EinrichtungsStatus,
} from "@/lib/konto/einrichtung";
import { computeVoterRefForUser } from "@/lib/polls/voter-ref";
import { resolveRegionIdForScope } from "@/lib/region/scope";

const { tenants, users, ortsteile, polls, pollOptions, votes, voteAllocations, voteResistances } = schema;

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
// naechsterSchritt — reine Unit-Tests (Priorität)
// ---------------------------------------------------------------------------

/** Status-Baukasten: alleErledigt konsistent aus den vier Schritten abgeleitet. */
function status(
  wohnortGesetzt: boolean,
  verifiziert: boolean,
  benachrichtigungAn: boolean,
  ersteTeilnahme: boolean,
): EinrichtungsStatus {
  return {
    wohnortGesetzt,
    verifiziert,
    benachrichtigungAn,
    ersteTeilnahme,
    teilnahmeErmittelbar: true,
    alleErledigt: wohnortGesetzt && verifiziert && benachrichtigungAn && ersteTeilnahme,
  };
}

describe("naechsterSchritt (Priorität)", () => {
  it("nichts erledigt → wohnort (erweitert zuerst die Sicht)", () => {
    expect(naechsterSchritt(status(false, false, false, false))).toBe("wohnort");
  });

  it("wohnort vor verifizierung: solange der Wohnort fehlt, gewinnt er — egal was sonst offen ist", () => {
    expect(naechsterSchritt(status(false, true, true, true))).toBe("wohnort");
    expect(naechsterSchritt(status(false, false, true, true))).toBe("wohnort");
    expect(naechsterSchritt(status(false, true, false, false))).toBe("wohnort");
  });

  it("verifizierung vor benachrichtigung: Wohnort da, Verifizierung offen", () => {
    expect(naechsterSchritt(status(true, false, false, false))).toBe("verifizierung");
    expect(naechsterSchritt(status(true, false, true, true))).toBe("verifizierung");
    expect(naechsterSchritt(status(true, false, false, true))).toBe("verifizierung");
  });

  it("benachrichtigung NUR wenn abbestellt — vor teilnahme", () => {
    expect(naechsterSchritt(status(true, true, false, false))).toBe("benachrichtigung");
    expect(naechsterSchritt(status(true, true, false, true))).toBe("benachrichtigung");
  });

  it("teilnahme zuletzt", () => {
    expect(naechsterSchritt(status(true, true, true, false))).toBe("teilnahme");
  });

  it("alles erledigt → null (Nudge verschwindet vollständig)", () => {
    expect(naechsterSchritt(status(true, true, true, true))).toBeNull();
  });

  it("exhaustiv (alle 16 Kombinationen): immer der erste offene Schritt in fester Reihenfolge", () => {
    for (const w of [false, true]) {
      for (const v of [false, true]) {
        for (const b of [false, true]) {
          for (const t of [false, true]) {
            const erwartet = !w
              ? "wohnort"
              : !v
                ? "verifizierung"
                : !b
                  ? "benachrichtigung"
                  : !t
                    ? "teilnahme"
                    : null;
            expect(naechsterSchritt(status(w, v, b, t))).toBe(erwartet);
          }
        }
      }
    }
  });

  it("Salt fehlt → teilnahmeErmittelbar=false, Teilnahme gilt als erledigt (ausblenden statt nörgeln)", async () => {
    // Salt-Fehler-Pfad (Gate-B MINOR): keine DB-Queries nötig — die Funktion
    // bricht die Teilnahme-Ermittlung vor jedem Query ab; db bleibt ungenutzt.
    const prevVote = process.env.VOTE_REF_SALT;
    const prevAnliegen = process.env.ANLIEGEN_REF_SALT;
    delete process.env.VOTE_REF_SALT;
    delete process.env.ANLIEGEN_REF_SALT;
    try {
      const s = await getEinrichtungsStatus(
        {} as never,
        { id: "00000000-0000-0000-0000-000000000000" } as never,
        {
          ortsteilId: null,
          homeRegionId: null,
          notifyNewPolls: true,
          verificationStatus: "pending",
          residencyVerifiedAt: null,
          residencyVerifiedUntil: null,
          accountStatus: "active",
          minAgeConfirmedAt: new Date(),
        },
        "11111111-1111-1111-1111-111111111111",
      );
      expect(s.teilnahmeErmittelbar).toBe(false);
      expect(s.ersteTeilnahme).toBe(true); // Nudge/alleErledigt nörgeln nicht
      expect(naechsterSchritt(s)).toBe("wohnort"); // übrige Schritte unberührt
    } finally {
      if (prevVote !== undefined) process.env.VOTE_REF_SALT = prevVote;
      if (prevAnliegen !== undefined) process.env.ANLIEGEN_REF_SALT = prevAnliegen;
    }
  });
});

// ---------------------------------------------------------------------------
// getEinrichtungsStatus — DB-Integration
// ---------------------------------------------------------------------------

type DbType = ReturnType<typeof drizzle>;

describe("konto/einrichtung (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenant: { id: string; slug: string; name: string };
  // Gemeinde-Knoten des Test-Tenants (für home_region_id + Poll-Inserts).
  let stadtRegion: string;

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 4 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [t] = await db
      .insert(tenants)
      .values({ slug: `ein-${Date.now()}`, name: "Einrichtung-Test" })
      .returning();
    tenant = t;
    stadtRegion = await resolveRegionIdForScope(db as never, tenant.id, "stadt", null);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  /** Frischer Test-User (Stufe 1); notifyNewPolls bewusst überschreibbar. */
  async function neuerUser(overrides: Partial<typeof users.$inferInsert> = {}) {
    const [u] = await db
      .insert(users)
      .values({
        tenantId: tenant.id,
        email: `ein-${Date.now()}-${Math.random().toString(36).slice(2)}@t.de`,
        minAgeConfirmedAt: new Date(),
        ...overrides,
      })
      .returning();
    return u;
  }

  /** Aktiver Poll im Test-Tenant (Ziel der Teilnahme-Einträge). */
  async function neuerPoll(typ: "ja_nein_enthaltung" | "dot_voting" | "widerstandsabfrage") {
    const [p] = await db
      .insert(polls)
      .values({
        tenantId: tenant.id,
        regionId: stadtRegion,
        frage: `Einrichtung ${typ}?`,
        typ,
        status: "aktiv",
        ...(typ === "dot_voting" ? { punkteBudget: 5 } : {}),
      })
      .returning();
    return p;
  }

  it.skipIf(SKIP)("User ohne alles → alle Schritte offen (notifyNewPolls explizit aus)", async () => {
    const u = await neuerUser({ notifyNewPolls: false });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s).toEqual({
      wohnortGesetzt: false,
      verifiziert: false,
      benachrichtigungAn: false,
      ersteTeilnahme: false,
      teilnahmeErmittelbar: true,
      alleErledigt: false,
    });
    expect(naechsterSchritt(s)).toBe("wohnort");
  });

  it.skipIf(SKIP)("notifyNewPolls-Default (true) → benachrichtigungAn erledigt", async () => {
    const u = await neuerUser();
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.benachrichtigungAn).toBe(true);
    expect(s.alleErledigt).toBe(false);
  });

  it.skipIf(SKIP)("home_region_id gesetzt → wohnortGesetzt", async () => {
    const u = await neuerUser({ homeRegionId: stadtRegion });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.wohnortGesetzt).toBe(true);
  });

  it.skipIf(SKIP)("nur Konto-Ortsteil gesetzt (Bestand vor ETAPPE 1) → wohnortGesetzt", async () => {
    const [ot] = await db
      .insert(ortsteile)
      .values({ tenantId: tenant.id, code: `OT-${Date.now()}`, name: "Testort" })
      .returning();
    const u = await neuerUser({ ortsteilId: ot.id });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.wohnortGesetzt).toBe(true);
  });

  it.skipIf(SKIP)("wohnsitz-verifiziert (Stufe 2 via getStufe) → verifiziert", async () => {
    const u = await neuerUser({
      verificationStatus: "verified",
      residencyVerifiedAt: new Date(),
    });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.verifiziert).toBe(true);
  });

  it.skipIf(SKIP)("abgelaufene Verifizierung (residencyVerifiedUntil < now) → NICHT verifiziert", async () => {
    const u = await neuerUser({
      verificationStatus: "verified",
      residencyVerifiedAt: new Date(Date.now() - 1000),
      residencyVerifiedUntil: new Date(Date.now() - 60_000),
    });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.verifiziert).toBe(false);
  });

  it.skipIf(SKIP)("Ja/Nein-Stimme (votes) → ersteTeilnahme", async () => {
    const u = await neuerUser();
    const p = await neuerPoll("ja_nein_enthaltung");
    await db.insert(votes).values({
      pollId: p.id,
      tenantId: tenant.id,
      voterRef: computeVoterRefForUser(u.id),
      choice: "ja",
      warVerifiziert: false,
    });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.ersteTeilnahme).toBe(true);
  });

  it.skipIf(SKIP)("Dot-Voting-Zuteilung (vote_allocations) → ersteTeilnahme", async () => {
    const u = await neuerUser();
    const p = await neuerPoll("dot_voting");
    const [opt] = await db
      .insert(pollOptions)
      .values({ pollId: p.id, tenantId: tenant.id, label: "A", position: 0 })
      .returning();
    await db.insert(voteAllocations).values({
      pollId: p.id,
      tenantId: tenant.id,
      optionId: opt.id,
      voterRef: computeVoterRefForUser(u.id),
      punkte: 3,
      warVerifiziert: false,
    });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.ersteTeilnahme).toBe(true);
  });

  it.skipIf(SKIP)("Widerstandswert (vote_resistances) → ersteTeilnahme (auch Wert 0)", async () => {
    const u = await neuerUser();
    const p = await neuerPoll("widerstandsabfrage");
    const [opt] = await db
      .insert(pollOptions)
      .values({ pollId: p.id, tenantId: tenant.id, label: "W", position: 0 })
      .returning();
    await db.insert(voteResistances).values({
      pollId: p.id,
      tenantId: tenant.id,
      optionId: opt.id,
      voterRef: computeVoterRefForUser(u.id),
      wert: 0,
      warVerifiziert: false,
    });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.ersteTeilnahme).toBe(true);
  });

  it.skipIf(SKIP)("tenant-scoped: Stimme im Fremd-Tenant zählt NICHT als Teilnahme", async () => {
    const [fremd] = await db
      .insert(tenants)
      .values({ slug: `ein-f-${Date.now()}`, name: "Fremd" })
      .returning();
    const fremdStadt = await resolveRegionIdForScope(db as never, fremd.id, "stadt", null);
    const u = await neuerUser();
    const [pF] = await db
      .insert(polls)
      .values({ tenantId: fremd.id, regionId: fremdStadt, frage: "fremd?", typ: "ja_nein_enthaltung", status: "aktiv" })
      .returning();
    await db.insert(votes).values({
      pollId: pF.id,
      tenantId: fremd.id,
      voterRef: computeVoterRefForUser(u.id),
      choice: "ja",
      warVerifiziert: false,
    });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.ersteTeilnahme).toBe(false);
  });

  it.skipIf(SKIP)("alle vier Schritte erledigt → alleErledigt + naechsterSchritt null", async () => {
    const u = await neuerUser({
      homeRegionId: stadtRegion,
      verificationStatus: "verified",
      residencyVerifiedAt: new Date(),
      // notifyNewPolls bleibt beim Default true.
    });
    const p = await neuerPoll("ja_nein_enthaltung");
    await db.insert(votes).values({
      pollId: p.id,
      tenantId: tenant.id,
      voterRef: computeVoterRefForUser(u.id),
      choice: "nein",
      warVerifiziert: true,
    });
    const s = await getEinrichtungsStatus(db as never, tenant as never, u, u.id);
    expect(s.alleErledigt).toBe(true);
    expect(naechsterSchritt(s)).toBeNull();
  });
});
