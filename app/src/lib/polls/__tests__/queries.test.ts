/**
 * queries.test.ts — DB-Integrationstests für die ECHTEN Lese-Queries
 * (getAktiveFeaturedPoll / getPollErgebnis / getAktivePolls / getMeineTeilnahmen).
 *
 * Regressionsschutz: getAktiveFeaturedPoll hatte ein JS-Date in einem Roh-`sql`-
 * Template → Treiber-Abbruch („Received an instance of Date") → 500 auf der
 * Landing. Diese Tests führen die echten Queries aus (nicht gespiegelt), damit
 * ein solcher Binding-Fehler sofort auffällt — und prüfen Scope-Filter +
 * Zeitfenster der Listing-Queries (ADR-014).
 *
 * next/headers wird gemockt, weil queries.ts (in anderen Funktionen) next/headers
 * importieren kann; die getesteten Funktionen lesen keine Cookies.
 *
 * ANLIEGEN_REF_SALT wird gesetzt, weil getMeineTeilnahmen den voter_ref über
 * computeVoterRefForUser (env-basiert) berechnet. Wir fügen Stimmen mit demselben
 * Helper ein, damit der Ref passt.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

process.env.ANLIEGEN_REF_SALT ??= "test-queries-salt-aaaaaaaaaaaaaaaaaaaaaa";

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
  getPollErgebnis,
  getAktivePolls,
  getMeineTeilnahmen,
  hatBereitsAbgestimmtBatch,
} from "@/lib/polls/queries";
import { computeVoterRefForUser } from "@/lib/polls/voter-ref";

const { tenants, polls, votes, users } = schema;

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

type DbType = ReturnType<typeof drizzle>;

describe("polls/queries (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;

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
      .values({ slug: `q-${Date.now()}`, name: "Query-Test" })
      .returning();
    tenantId = t.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("getPollErgebnis aggregiert Stimmen + verifizierte korrekt", async () => {
    const [p] = await db
      .insert(polls)
      .values({ tenantId, scopeLevel: "stadt", frage: "Ergebnis?", typ: "ja_nein_enthaltung", status: "aktiv" })
      .returning();
    await db.insert(votes).values([
      { pollId: p.id, tenantId, voterRef: "r1", choice: "ja", warVerifiziert: true },
      { pollId: p.id, tenantId, voterRef: "r2", choice: "ja", warVerifiziert: false },
      { pollId: p.id, tenantId, voterRef: "r3", choice: "nein", warVerifiziert: false },
    ]);
    const erg = await getPollErgebnis(db as never, tenantId, p.id);
    expect(erg).not.toBeNull();
    expect(erg!.gesamt).toBe(3);
    expect(erg!.verifiziert).toBe(1);
  });

  // -------------------------------------------------------------------------
  // getAktivePolls — Zeitfenster, Status, Reihenfolge (neu→alt), Scope-Filter
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)("getAktivePolls liefert nur offene aktive Polls, neu→alt; ignoriert entwurf/zu/künftig", async () => {
    // Eigener Tenant für saubere Isolation.
    const [t] = await db
      .insert(tenants)
      .values({ slug: `ap-${Date.now()}`, name: "Aktive-Polls" })
      .returning();
    const past = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 3_600_000);

    // Zwei offene Polls (unterschiedliche createdAt für Reihenfolge).
    const [alt] = await db
      .insert(polls)
      .values({
        tenantId: t.id, scopeLevel: "stadt", frage: "alt offen?",
        typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past,
        createdAt: new Date(Date.now() - 10_000),
      })
      .returning();
    const [neu] = await db
      .insert(polls)
      .values({
        tenantId: t.id, scopeLevel: "stadt", frage: "neu offen?",
        typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past,
        createdAt: new Date(),
      })
      .returning();
    // Nicht sichtbar: entwurf, schon geschlossen, noch nicht begonnen.
    await db.insert(polls).values([
      { tenantId: t.id, scopeLevel: "stadt", frage: "entwurf", typ: "ja_nein_enthaltung", status: "entwurf" },
      { tenantId: t.id, scopeLevel: "stadt", frage: "vorbei", typ: "ja_nein_enthaltung", status: "aktiv", closesAt: past },
      { tenantId: t.id, scopeLevel: "stadt", frage: "kommt erst", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: future },
    ]);

    const list = await getAktivePolls(db as never, t.id);
    expect(list.map((p) => p.id)).toEqual([neu.id, alt.id]); // neu→alt
  });

  it.skipIf(SKIP)("getAktivePolls: Ortsteil-Polls nur bei passendem userOrtsteilCode; stadt/kreis/land immer", async () => {
    const [t] = await db
      .insert(tenants)
      .values({ slug: `sc-${Date.now()}`, name: "Scope" })
      .returning();
    const past = new Date(Date.now() - 60_000);

    await db.insert(polls).values([
      { tenantId: t.id, scopeLevel: "stadt", scopeCode: null, frage: "stadtweit", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
      { tenantId: t.id, scopeLevel: "kreis", scopeCode: null, frage: "kreisweit", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
      { tenantId: t.id, scopeLevel: "ortsteil", scopeCode: "OT-A", frage: "ortsteil A", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
      { tenantId: t.id, scopeLevel: "ortsteil", scopeCode: "OT-B", frage: "ortsteil B", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
    ]);

    // Ohne Ortsteil: nur stadt + kreis (keine Ortsteil-Polls).
    const anon = await getAktivePolls(db as never, t.id);
    expect(anon.map((p) => p.frage).sort()).toEqual(["kreisweit", "stadtweit"]);

    // Mit Ortsteil OT-A: stadt + kreis + Ortsteil A (NICHT B).
    const ota = await getAktivePolls(db as never, t.id, { userOrtsteilCode: "OT-A" });
    expect(ota.map((p) => p.frage).sort()).toEqual(["kreisweit", "ortsteil A", "stadtweit"]);
    expect(ota.map((p) => p.frage)).not.toContain("ortsteil B");
  });

  it.skipIf(SKIP)("getAktivePolls ist tenant-scoped (fremde Polls unsichtbar)", async () => {
    const [tA] = await db.insert(tenants).values({ slug: `ti-a-${Date.now()}`, name: "TI-A" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: `ti-b-${Date.now()}`, name: "TI-B" }).returning();
    const past = new Date(Date.now() - 60_000);
    await db.insert(polls).values({ tenantId: tB.id, scopeLevel: "stadt", frage: "fremd", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past });
    const list = await getAktivePolls(db as never, tA.id);
    expect(list).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // getMeineTeilnahmen — nur eigene Stimmen, mit Ergebnis, status-unabhängig
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)("getMeineTeilnahmen liefert nur Polls mit eigener Stimme, inkl. Ergebnis, neu→alt", async () => {
    const [t] = await db.insert(tenants).values({ slug: `mt-${Date.now()}`, name: "MeineTeiln" }).returning();

    const [u] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `mt-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() })
      .returning();
    const [other] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `mt-other-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() })
      .returning();

    const myRef = computeVoterRefForUser(u.id);
    const otherRef = computeVoterRefForUser(other.id);

    // Poll A (älter, geschlossen) — User hat abgestimmt.
    const [pA] = await db
      .insert(polls)
      .values({ tenantId: t.id, scopeLevel: "stadt", frage: "A?", typ: "ja_nein_enthaltung", status: "geschlossen", createdAt: new Date(Date.now() - 20_000) })
      .returning();
    // Poll B (neuer, aktiv) — User hat abgestimmt.
    const [pB] = await db
      .insert(polls)
      .values({ tenantId: t.id, scopeLevel: "stadt", frage: "B?", typ: "ja_nein_enthaltung", status: "aktiv", createdAt: new Date() })
      .returning();
    // Poll C — NUR ein anderer User hat abgestimmt.
    const [pC] = await db
      .insert(polls)
      .values({ tenantId: t.id, scopeLevel: "stadt", frage: "C?", typ: "ja_nein_enthaltung", status: "aktiv" })
      .returning();

    await db.insert(votes).values([
      { pollId: pA.id, tenantId: t.id, voterRef: myRef, choice: "ja", warVerifiziert: true },
      { pollId: pB.id, tenantId: t.id, voterRef: myRef, choice: "nein", warVerifiziert: false },
      { pollId: pB.id, tenantId: t.id, voterRef: otherRef, choice: "ja", warVerifiziert: false },
      { pollId: pC.id, tenantId: t.id, voterRef: otherRef, choice: "ja", warVerifiziert: false },
    ]);

    const teiln = await getMeineTeilnahmen(db as never, t.id, u.id);
    // Nur A + B, neu→alt → [B, A]. C fehlt (keine eigene Stimme).
    expect(teiln.map((p) => p.id)).toEqual([pB.id, pA.id]);

    const b = teiln.find((p) => p.id === pB.id)!;
    expect(b.ergebnis.gesamt).toBe(2); // beide Stimmen aggregiert
    const a = teiln.find((p) => p.id === pA.id)!;
    expect(a.ergebnis.gesamt).toBe(1);
    expect(a.ergebnis.verifiziert).toBe(1);
  });

  it.skipIf(SKIP)("getMeineTeilnahmen ist tenant-scoped (Stimme im Fremd-Tenant zählt nicht)", async () => {
    const [tA] = await db.insert(tenants).values({ slug: `mti-a-${Date.now()}`, name: "MTI-A" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: `mti-b-${Date.now()}`, name: "MTI-B" }).returning();
    const [u] = await db
      .insert(users)
      .values({ tenantId: tA.id, email: `mti-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() })
      .returning();
    const ref = computeVoterRefForUser(u.id);

    const [pB] = await db
      .insert(polls)
      .values({ tenantId: tB.id, scopeLevel: "stadt", frage: "fremd?", typ: "ja_nein_enthaltung", status: "aktiv" })
      .returning();
    // Stimme im Fremd-Tenant (sollte über tenant-scope nie in tA auftauchen).
    await db.insert(votes).values({ pollId: pB.id, tenantId: tB.id, voterRef: ref, choice: "ja", warVerifiziert: false });

    const teiln = await getMeineTeilnahmen(db as never, tA.id, u.id);
    expect(teiln).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // hatBereitsAbgestimmtBatch — Teilnahme-Set (P1 §Empf. 4): nur OB, voter_ref-
  // und tenant-gebunden, eine Query statt N (Secret-Ballot-Chip-Quelle).
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)("hatBereitsAbgestimmtBatch: genau die eigenen abgestimmten poll_ids; fremde/ungestimmte nicht", async () => {
    const [t] = await db.insert(tenants).values({ slug: `bb-${Date.now()}`, name: "BatchAbg" }).returning();
    const [u] = await db.insert(users).values({ tenantId: t.id, email: `bb-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const [other] = await db.insert(users).values({ tenantId: t.id, email: `bb-o-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const myRef = computeVoterRefForUser(u.id);
    const otherRef = computeVoterRefForUser(other.id);

    const [p1] = await db.insert(polls).values({ tenantId: t.id, scopeLevel: "stadt", frage: "p1", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    const [p2] = await db.insert(polls).values({ tenantId: t.id, scopeLevel: "stadt", frage: "p2", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    const [p3] = await db.insert(polls).values({ tenantId: t.id, scopeLevel: "stadt", frage: "p3", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();

    await db.insert(votes).values([
      { pollId: p1.id, tenantId: t.id, voterRef: myRef, choice: "ja", warVerifiziert: false },
      { pollId: p2.id, tenantId: t.id, voterRef: otherRef, choice: "nein", warVerifiziert: false }, // anderer User
      // p3: niemand
    ]);

    const set = await hatBereitsAbgestimmtBatch(db as never, t as never, [p1.id, p2.id, p3.id], { userId: u.id });
    expect(set.has(p1.id)).toBe(true);   // eigene Stimme → abgestimmt
    expect(set.has(p2.id)).toBe(false);  // fremde Stimme → NICHT
    expect(set.has(p3.id)).toBe(false);  // keine Stimme
    expect(set.size).toBe(1);
  });

  it.skipIf(SKIP)("hatBereitsAbgestimmtBatch: tenant-scoped + ohne userId/leere Liste → leeres Set", async () => {
    const [tA] = await db.insert(tenants).values({ slug: `bba-${Date.now()}`, name: "BBA" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: `bbb-${Date.now()}`, name: "BBB" }).returning();
    const [u] = await db.insert(users).values({ tenantId: tA.id, email: `bbt-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const ref = computeVoterRefForUser(u.id);
    const [pB] = await db.insert(polls).values({ tenantId: tB.id, scopeLevel: "stadt", frage: "fremd", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    await db.insert(votes).values({ pollId: pB.id, tenantId: tB.id, voterRef: ref, choice: "ja", warVerifiziert: false });

    // Fremd-Tenant-Stimme existiert, Abfrage im Tenant A (mit Fremd-poll_id) → nichts.
    const crossTenant = await hatBereitsAbgestimmtBatch(db as never, tA as never, [pB.id], { userId: u.id });
    expect(crossTenant.size).toBe(0);

    // Kein userId bzw. leere pollIds → leeres Set (kein DB-Treffer).
    expect((await hatBereitsAbgestimmtBatch(db as never, tA as never, [pB.id], { userId: null })).size).toBe(0);
    expect((await hatBereitsAbgestimmtBatch(db as never, tA as never, [], { userId: u.id })).size).toBe(0);
  });
});
