/**
 * queries.test.ts — DB-Integrationstests für die ECHTEN Lese-Queries
 * (getAktiveFeaturedPoll / getPollErgebnis / getAktivePolls / getMeineTeilnahmen).
 *
 * Regressionsschutz: getAktiveFeaturedPoll hatte ein JS-Date in einem Roh-`sql`-
 * Template → Treiber-Abbruch („Received an instance of Date") → 500 auf der
 * Landing. Diese Tests führen die echten Queries aus (nicht gespiegelt), damit
 * ein solcher Binding-Fehler sofort auffällt — und prüfen Scope-Filter +
 * Zeitfenster der Listing-Queries (ADR-014) sowie ADR-022 (Aufschlüsselung
 * erst nach Abstimmungsende: laufend = keine Options-Zahlen im Payload;
 * beendet via status ODER closesAt = volle Aufschlüsselung mit k-Suppression).
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
  getAllPollsForAdmin,
  getMeineTeilnahmen,
  hatBereitsAbgestimmtBatch,
  mitErgebnissen,
} from "@/lib/polls/queries";
import { computeVoterRefForUser } from "@/lib/polls/voter-ref";
import { resolveOrtsteilRegionId, resolveRegionIdForScope } from "@/lib/region/scope";
import { and, eq } from "drizzle-orm";

const { tenants, polls, votes, users, roles, regions, pollOptions, voteAllocations, voteResistances } = schema;

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
  // ADR-024 contract: Fach-Inserts setzen region_id explizit (Trigger entfernt).
  // Der Gemeinde-Knoten des Test-Tenants, via Scope→region_id (provisioniert im Test).
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
      .values({ slug: `q-${Date.now()}`, name: "Query-Test" })
      .returning();
    tenantId = t.id;
    stadtRegion = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("getPollErgebnis (LAUFEND): Poll-Ebene korrekt, aber KEINE Options-Zahlen im Payload (ADR-022)", async () => {
    const [p] = await db
      .insert(polls)
      .values({ tenantId, regionId: stadtRegion, frage: "Ergebnis?", typ: "ja_nein_enthaltung", status: "aktiv" })
      .returning();
    await db.insert(votes).values([
      { pollId: p.id, tenantId, voterRef: "r1", choice: "ja", warVerifiziert: true },
      { pollId: p.id, tenantId, voterRef: "r2", choice: "ja", warVerifiziert: false },
      { pollId: p.id, tenantId, voterRef: "r3", choice: "nein", warVerifiziert: false },
    ]);
    const erg = await getPollErgebnis(db as never, tenantId, p.id);
    expect(erg).not.toBeNull();
    // Poll-Ebene (ADR-014) bleibt sichtbar …
    expect(erg!.gesamt).toBe(3);
    expect(erg!.verifiziert).toBe(1);
    // … aber die Aufschlüsselung verlässt den Server erst nach Schluss.
    expect(erg!.aufschluesselungNachSchluss).toBe(true);
    expect(erg!.optionen).toHaveLength(3);
    for (const o of erg!.optionen) {
      expect(o.count).toBeNull();
      expect(o.verifiziert).toBeNull();
      expect(o.prozent).toBeNull();
      expect(o.maskiert).toBe(false); // auch das Masken-Muster leakt nicht
    }
  });

  it.skipIf(SKIP)("getPollErgebnis (BEENDET via status='geschlossen'): volle Aufschlüsselung", async () => {
    const [p] = await db
      .insert(polls)
      .values({ tenantId, regionId: stadtRegion, frage: "Zu?", typ: "ja_nein_enthaltung", status: "geschlossen" })
      .returning();
    // ja=5 (≥ k), nein/enthaltung=0 → nichts maskiert, alles sichtbar.
    await db.insert(votes).values(
      Array.from({ length: 5 }, (_, i) => ({
        pollId: p.id, tenantId, voterRef: `zu-${i}`, choice: "ja", warVerifiziert: i < 2,
      }))
    );
    const erg = await getPollErgebnis(db as never, tenantId, p.id);
    expect(erg).not.toBeNull();
    expect(erg!.aufschluesselungNachSchluss).toBe(false);
    expect(erg!.gesamt).toBe(5);
    expect(erg!.verifiziert).toBe(2);
    const ja = erg!.optionen.find((o) => o.choice === "ja")!;
    expect(ja.count).toBe(5);
    expect(ja.verifiziert).toBe(2);
    expect(ja.prozent).toBe(100);
    expect(ja.maskiert).toBe(false);
  });

  it.skipIf(SKIP)("getPollErgebnis (BEENDET via closesAt in der Vergangenheit): Aufschlüsselung da, k-Suppression greift weiter", async () => {
    const [p] = await db
      .insert(polls)
      .values({
        tenantId, regionId: stadtRegion, frage: "Abgelaufen?", typ: "ja_nein_enthaltung",
        status: "aktiv", closesAt: new Date(Date.now() - 60_000),
      })
      .returning();
    // Kleingruppen-Fall: ja=6, nein=2 → nein primär maskiert; komplementäre
    // Suppression eskaliert hier zur vollen Maskierung (maskierte Summe < k).
    await db.insert(votes).values([
      ...Array.from({ length: 6 }, (_, i) => ({
        pollId: p.id, tenantId, voterRef: `ab-ja-${i}`, choice: "ja", warVerifiziert: false,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        pollId: p.id, tenantId, voterRef: `ab-nein-${i}`, choice: "nein", warVerifiziert: false,
      })),
    ]);
    const erg = await getPollErgebnis(db as never, tenantId, p.id);
    expect(erg).not.toBeNull();
    // Beendet (closesAt erreicht) → Endergebnis-Sicht, kein Zurückhalte-Flag.
    expect(erg!.aufschluesselungNachSchluss).toBe(false);
    expect(erg!.gesamt).toBe(8);
    // k-Suppression bleibt NACH Poll-Ende unverändert wirksam: die Kleingruppe
    // (nein=2) und — komplementär/Rekonstruktions-Schutz — alle Optionen sind
    // maskiert; keine Kleingruppen-Zahl verlässt den Server.
    for (const o of erg!.optionen) {
      expect(o.maskiert).toBe(true);
      expect(o.count).toBeNull();
      expect(o.verifiziert).toBeNull();
      expect(o.prozent).toBeNull();
    }
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
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    // Zwei offene Polls (unterschiedliche createdAt für Reihenfolge).
    const [alt] = await db
      .insert(polls)
      .values({
        tenantId: t.id, regionId: stadtT, frage: "alt offen?",
        typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past,
        createdAt: new Date(Date.now() - 10_000),
      })
      .returning();
    const [neu] = await db
      .insert(polls)
      .values({
        tenantId: t.id, regionId: stadtT, frage: "neu offen?",
        typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past,
        createdAt: new Date(),
      })
      .returning();
    // Nicht sichtbar: entwurf, schon geschlossen, noch nicht begonnen.
    await db.insert(polls).values([
      { tenantId: t.id, regionId: stadtT, frage: "entwurf", typ: "ja_nein_enthaltung", status: "entwurf" },
      { tenantId: t.id, regionId: stadtT, frage: "vorbei", typ: "ja_nein_enthaltung", status: "aktiv", closesAt: past },
      { tenantId: t.id, regionId: stadtT, frage: "kommt erst", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: future },
    ]);

    const list = await getAktivePolls(db as never, t.id);
    expect(list.map((p) => p.id)).toEqual([neu.id, alt.id]); // neu→alt
  });

  it.skipIf(SKIP)("getAktivePolls: vertikale Scheibe (ADR-024) — eigener Ortsteil + Vorfahren + BUND, keine Nachbarorte", async () => {
    const [t] = await db
      .insert(tenants)
      .values({ slug: `sc-${Date.now()}`, name: "Scope" })
      .returning();
    const past = new Date(Date.now() - 60_000);

    // ADR-024 contract: Scope→region_id explizit auflösen (Trigger entfernt). Die
    // Auflösung provisioniert im Test Gemeinde/Kreis/Land-Vorfahren + die Ortsteil-
    // Knoten OT-A/OT-B unter der Gemeinde (dieselbe SQL-Funktion wie früher der Trigger).
    const rStadt = await resolveRegionIdForScope(db as never, t.id, "stadt", null);
    const rKreis = await resolveRegionIdForScope(db as never, t.id, "kreis", null);
    const rLand = await resolveRegionIdForScope(db as never, t.id, "land", null);
    const rOtA = await resolveRegionIdForScope(db as never, t.id, "ortsteil", "OT-A");
    const rOtB = await resolveRegionIdForScope(db as never, t.id, "ortsteil", "OT-B");
    await db.insert(polls).values([
      { tenantId: t.id, regionId: rStadt, frage: "stadtweit", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
      { tenantId: t.id, regionId: rKreis, frage: "kreisweit", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
      { tenantId: t.id, regionId: rLand, frage: "landweit", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
      { tenantId: t.id, regionId: rOtA, frage: "ortsteil A", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
      { tenantId: t.id, regionId: rOtB, frage: "ortsteil B", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past },
    ]);

    // BUND-Ebene aktivieren: Poll direkt auf den Wurzel-Knoten (region_id explizit).
    const [bund] = await db.select({ id: regions.id }).from(regions).where(eq(regions.typ, "bund")).limit(1);
    await db.insert(polls).values({
      tenantId: t.id, regionId: bund.id,
      frage: "bundesweit", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past,
    });

    // Nicht verortet (viewerRegionId null): obere Ebenen tenant-weit inkl. Bund,
    // OHNE Ortsteil-Kinder — deckungsgleich mit dem alten Default „stadt/kreis/land".
    const anon = await getAktivePolls(db as never, t.id);
    expect(anon.map((p) => p.frage).sort()).toEqual(["bundesweit", "kreisweit", "landweit", "stadtweit"]);

    // Verortet in OT-A: eigene Ortsteil-Frage + alle Vorfahren (Stadt/Kreis/Land/BUND),
    // NICHT den Nachbarort OT-B.
    const otaId = await resolveOrtsteilRegionId(db as never, t.id, "OT-A");
    expect(otaId).not.toBeNull();
    const ota = await getAktivePolls(db as never, t.id, { viewerRegionId: otaId });
    expect(ota.map((p) => p.frage).sort()).toEqual(
      ["bundesweit", "kreisweit", "landweit", "ortsteil A", "stadtweit"]
    );
    expect(ota.map((p) => p.frage)).not.toContain("ortsteil B");

    // Gate-B MAJOR: Wohnknoten = GEMEINDE (Nutzer OHNE gewählten Ortsteil). Trotz
    // gesetzter viewerRegionId darf die Nachfahren-Scheibe NICHT greifen → obere
    // Ebenen inkl. Bund, aber KEIN Ortsteil-Poll (weder eigener noch Nachbarort) —
    // deckungsgleich mit der nicht-verorteten Sicht.
    const [gem] = await db
      .select({ id: regions.id })
      .from(regions)
      .where(and(eq(regions.typ, "gemeinde"), eq(regions.tenantId, t.id)))
      .limit(1);
    expect(gem).toBeTruthy();
    const gemView = await getAktivePolls(db as never, t.id, { viewerRegionId: gem.id });
    expect(gemView.map((p) => p.frage).sort()).toEqual(
      ["bundesweit", "kreisweit", "landweit", "stadtweit"]
    );
    expect(gemView.map((p) => p.frage)).not.toContain("ortsteil A");
    expect(gemView.map((p) => p.frage)).not.toContain("ortsteil B");
  });

  it.skipIf(SKIP)("getAktivePolls ist tenant-scoped (fremde Polls unsichtbar)", async () => {
    const [tA] = await db.insert(tenants).values({ slug: `ti-a-${Date.now()}`, name: "TI-A" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: `ti-b-${Date.now()}`, name: "TI-B" }).returning();
    const past = new Date(Date.now() - 60_000);
    const stadtB = await resolveRegionIdForScope(db as never, tB.id, "stadt", null);
    await db.insert(polls).values({ tenantId: tB.id, regionId: stadtB, frage: "fremd", typ: "ja_nein_enthaltung", status: "aktiv", opensAt: past });
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
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    // Poll A (älter, geschlossen) — User hat abgestimmt.
    const [pA] = await db
      .insert(polls)
      .values({ tenantId: t.id, regionId: stadtT, frage: "A?", typ: "ja_nein_enthaltung", status: "geschlossen", createdAt: new Date(Date.now() - 20_000) })
      .returning();
    // Poll B (neuer, aktiv) — User hat abgestimmt.
    const [pB] = await db
      .insert(polls)
      .values({ tenantId: t.id, regionId: stadtT, frage: "B?", typ: "ja_nein_enthaltung", status: "aktiv", createdAt: new Date() })
      .returning();
    // Poll C — NUR ein anderer User hat abgestimmt.
    const [pC] = await db
      .insert(polls)
      .values({ tenantId: t.id, regionId: stadtT, frage: "C?", typ: "ja_nein_enthaltung", status: "aktiv" })
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
    // ADR-022: B läuft noch → keine Options-Zahlen im Payload.
    expect(b.ergebnis.aufschluesselungNachSchluss).toBe(true);
    for (const o of b.ergebnis.optionen) {
      expect(o.count).toBeNull();
      expect(o.verifiziert).toBeNull();
      expect(o.prozent).toBeNull();
    }
    const a = teiln.find((p) => p.id === pA.id)!;
    expect(a.ergebnis.gesamt).toBe(1);
    expect(a.ergebnis.verifiziert).toBe(1);
    // A ist geschlossen → Endergebnis-Sicht (hier greift die k-Suppression,
    // 1 Stimme < k → maskiert, aber ohne Zurückhalte-Flag).
    expect(a.ergebnis.aufschluesselungNachSchluss).toBe(false);
  });

  it.skipIf(SKIP)("getMeineTeilnahmen ist tenant-scoped (Stimme im Fremd-Tenant zählt nicht)", async () => {
    const [tA] = await db.insert(tenants).values({ slug: `mti-a-${Date.now()}`, name: "MTI-A" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: `mti-b-${Date.now()}`, name: "MTI-B" }).returning();
    const [u] = await db
      .insert(users)
      .values({ tenantId: tA.id, email: `mti-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() })
      .returning();
    const ref = computeVoterRefForUser(u.id);
    const stadtB = await resolveRegionIdForScope(db as never, tB.id, "stadt", null);

    const [pB] = await db
      .insert(polls)
      .values({ tenantId: tB.id, regionId: stadtB, frage: "fremd?", typ: "ja_nein_enthaltung", status: "aktiv" })
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
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    const [p1] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "p1", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    const [p2] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "p2", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    const [p3] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "p3", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();

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
    const stadtB = await resolveRegionIdForScope(db as never, tB.id, "stadt", null);
    const [pB] = await db.insert(polls).values({ tenantId: tB.id, regionId: stadtB, frage: "fremd", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    await db.insert(votes).values({ pollId: pB.id, tenantId: tB.id, voterRef: ref, choice: "ja", warVerifiziert: false });

    // Fremd-Tenant-Stimme existiert, Abfrage im Tenant A (mit Fremd-poll_id) → nichts.
    const crossTenant = await hatBereitsAbgestimmtBatch(db as never, tA as never, [pB.id], { userId: u.id });
    expect(crossTenant.size).toBe(0);

    // Kein userId bzw. leere pollIds → leeres Set (kein DB-Treffer).
    expect((await hatBereitsAbgestimmtBatch(db as never, tA as never, [pB.id], { userId: null })).size).toBe(0);
    expect((await hatBereitsAbgestimmtBatch(db as never, tA as never, [], { userId: u.id })).size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Dot-Voting-Teilnahmen (M1-Nachzug Block F): Dot-Teilnahmen liegen NUR in
  // vote_allocations — Batch-Chip und „Bereits teilgenommen" müssen sie sehen.
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)("hatBereitsAbgestimmtBatch erkennt Dot-Voting-Teilnahmen (vote_allocations)", async () => {
    const [t] = await db.insert(tenants).values({ slug: `bd-${Date.now()}`, name: "BatchDot" }).returning();
    const [u] = await db.insert(users).values({ tenantId: t.id, email: `bd-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const [other] = await db.insert(users).values({ tenantId: t.id, email: `bd-o-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const myRef = computeVoterRefForUser(u.id);
    const otherRef = computeVoterRefForUser(other.id);
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    const [pDot] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "dot?", typ: "dot_voting", status: "aktiv", punkteBudget: 5 }).returning();
    const [pDot2] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "dot2?", typ: "dot_voting", status: "aktiv", punkteBudget: 5 }).returning();
    const [optA] = await db.insert(pollOptions).values({ pollId: pDot.id, tenantId: t.id, label: "A", position: 0 }).returning();
    const [optB] = await db.insert(pollOptions).values({ pollId: pDot2.id, tenantId: t.id, label: "B", position: 0 }).returning();

    await db.insert(voteAllocations).values([
      { pollId: pDot.id, tenantId: t.id, optionId: optA.id, voterRef: myRef, punkte: 3, warVerifiziert: false },
      { pollId: pDot2.id, tenantId: t.id, optionId: optB.id, voterRef: otherRef, punkte: 2, warVerifiziert: false },
    ]);

    const set = await hatBereitsAbgestimmtBatch(db as never, t as never, [pDot.id, pDot2.id], { userId: u.id });
    expect(set.has(pDot.id)).toBe(true);   // eigene Zuteilung → teilgenommen
    expect(set.has(pDot2.id)).toBe(false); // fremde Zuteilung → NICHT
    expect(set.size).toBe(1);
  });

  it.skipIf(SKIP)("getMeineTeilnahmen enthält Dot-Voting-Teilnahmen mit Dot-Aggregat (dot-Feld)", async () => {
    const [t] = await db.insert(tenants).values({ slug: `md-${Date.now()}`, name: "MeineDot" }).returning();
    const [u] = await db.insert(users).values({ tenantId: t.id, email: `md-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const myRef = computeVoterRefForUser(u.id);
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    const [pDot] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "Budget?", typ: "dot_voting", status: "aktiv", punkteBudget: 5 }).returning();
    const [optA] = await db.insert(pollOptions).values({ pollId: pDot.id, tenantId: t.id, label: "A", position: 0 }).returning();
    await db.insert(voteAllocations).values([
      { pollId: pDot.id, tenantId: t.id, optionId: optA.id, voterRef: myRef, punkte: 3, warVerifiziert: true },
      { pollId: pDot.id, tenantId: t.id, optionId: optA.id, voterRef: "fremd-1", punkte: 5, warVerifiziert: false },
    ]);

    const teiln = await getMeineTeilnahmen(db as never, t.id, u.id);
    expect(teiln.map((p) => p.id)).toContain(pDot.id);
    const dotPoll = teiln.find((p) => p.id === pDot.id)!;
    // Dot-Aggregat für die Karten-Teilnahmezeile: Teilnehmende immer sichtbar …
    expect(dotPoll.dot?.gesamtWaehler).toBe(2);
    expect(dotPoll.dot?.verifizierteWaehler).toBe(1);
    // … per-Option-Aufschlüsselung läuft-noch-zurückgehalten (ADR-025/-022).
    expect(dotPoll.dot?.aufschluesselungZurueckgehalten).toBe(true);
    expect(dotPoll.dot?.zurueckhaltungsGrund).toBe("laeuft_noch");
    for (const o of dotPoll.dot!.optionen) {
      expect(o.punkteSumme).toBeNull();
      expect(o.prozent).toBeNull();
    }
  });

  it.skipIf(SKIP)("mitErgebnissen reichert dot_voting-Polls um das Dot-Aggregat an (Ja/Nein ohne dot)", async () => {
    const [t] = await db.insert(tenants).values({ slug: `me-${Date.now()}`, name: "MitErg" }).returning();
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    const [pJa] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "ja/nein?", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    const [pDot] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "dot?", typ: "dot_voting", status: "aktiv", punkteBudget: 5 }).returning();
    const [optA] = await db.insert(pollOptions).values({ pollId: pDot.id, tenantId: t.id, label: "A", position: 0 }).returning();
    await db.insert(voteAllocations).values({ pollId: pDot.id, tenantId: t.id, optionId: optA.id, voterRef: "me-1", punkte: 4, warVerifiziert: false });

    const items = await getAktivePolls(db as never, t.id);
    const enriched = await mitErgebnissen(db as never, t.id, items);

    const dot = enriched.find((p) => p.id === pDot.id)!;
    expect(dot.dot?.gesamtWaehler).toBe(1); // Teilnahme sichtbar statt „Noch keine Stimmen"
    expect(dot.ergebnis.gesamt).toBe(0);    // Ja/Nein-Aggregat bleibt leer (kein votes-Eintrag)

    const ja = enriched.find((p) => p.id === pJa.id)!;
    expect(ja.dot).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Widerstandsabfrage-Teilnahmen (Block G): Widerstands-Teilnahmen liegen NUR
  // in vote_resistances — Batch-Chip und „Bereits teilgenommen" müssen sie sehen.
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)("hatBereitsAbgestimmtBatch erkennt Widerstands-Teilnahmen (vote_resistances)", async () => {
    const [t] = await db.insert(tenants).values({ slug: `bw-${Date.now()}`, name: "BatchWid" }).returning();
    const [u] = await db.insert(users).values({ tenantId: t.id, email: `bw-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const [other] = await db.insert(users).values({ tenantId: t.id, email: `bw-o-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const myRef = computeVoterRefForUser(u.id);
    const otherRef = computeVoterRefForUser(other.id);
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    const [pW] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "wid?", typ: "widerstandsabfrage", status: "aktiv" }).returning();
    const [pW2] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "wid2?", typ: "widerstandsabfrage", status: "aktiv" }).returning();
    const [optA] = await db.insert(pollOptions).values({ pollId: pW.id, tenantId: t.id, label: "A", position: 0 }).returning();
    const [optB] = await db.insert(pollOptions).values({ pollId: pW2.id, tenantId: t.id, label: "B", position: 0 }).returning();

    await db.insert(voteResistances).values([
      // wert=0 zählt als Teilnahme (vollständige Abgabe speichert auch 0).
      { pollId: pW.id, tenantId: t.id, optionId: optA.id, voterRef: myRef, wert: 0, warVerifiziert: false },
      { pollId: pW2.id, tenantId: t.id, optionId: optB.id, voterRef: otherRef, wert: 5, warVerifiziert: false },
    ]);

    const set = await hatBereitsAbgestimmtBatch(db as never, t as never, [pW.id, pW2.id], { userId: u.id });
    expect(set.has(pW.id)).toBe(true);   // eigener Widerstandswert → teilgenommen
    expect(set.has(pW2.id)).toBe(false); // fremder Wert → NICHT
    expect(set.size).toBe(1);
  });

  it.skipIf(SKIP)("getMeineTeilnahmen enthält Widerstands-Teilnahmen mit Widerstands-Aggregat (widerstand-Feld)", async () => {
    const [t] = await db.insert(tenants).values({ slug: `mw-${Date.now()}`, name: "MeineWid" }).returning();
    const [u] = await db.insert(users).values({ tenantId: t.id, email: `mw-${Date.now()}@t.de`, minAgeConfirmedAt: new Date() }).returning();
    const myRef = computeVoterRefForUser(u.id);
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    const [pW] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "Konsens?", typ: "widerstandsabfrage", status: "aktiv" }).returning();
    const [optA] = await db.insert(pollOptions).values({ pollId: pW.id, tenantId: t.id, label: "A", position: 0 }).returning();
    await db.insert(voteResistances).values([
      { pollId: pW.id, tenantId: t.id, optionId: optA.id, voterRef: myRef, wert: 3, warVerifiziert: true },
      { pollId: pW.id, tenantId: t.id, optionId: optA.id, voterRef: "fremd-1", wert: 7, warVerifiziert: false },
    ]);

    const teiln = await getMeineTeilnahmen(db as never, t.id, u.id);
    expect(teiln.map((p) => p.id)).toContain(pW.id);
    const widPoll = teiln.find((p) => p.id === pW.id)!;
    // Widerstands-Aggregat für die Karten-Teilnahmezeile: Teilnehmende immer sichtbar …
    expect(widPoll.widerstand?.gesamtWaehler).toBe(2);
    expect(widPoll.widerstand?.verifizierteWaehler).toBe(1);
    // … per-Option-Aufschlüsselung läuft-noch-zurückgehalten (ADR-025/-022).
    expect(widPoll.widerstand?.aufschluesselungZurueckgehalten).toBe(true);
    expect(widPoll.widerstand?.zurueckhaltungsGrund).toBe("laeuft_noch");
    for (const o of widPoll.widerstand!.optionen) {
      expect(o.widerstandsSumme).toBeNull();
      expect(o.mittelwert).toBeNull();
    }
  });

  it.skipIf(SKIP)("mitErgebnissen reichert widerstandsabfrage-Polls um das Widerstands-Aggregat an", async () => {
    const [t] = await db.insert(tenants).values({ slug: `mew-${Date.now()}`, name: "MitErgWid" }).returning();
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    const [pJa] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "ja/nein?", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    const [pW] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "wid?", typ: "widerstandsabfrage", status: "aktiv" }).returning();
    const [optA] = await db.insert(pollOptions).values({ pollId: pW.id, tenantId: t.id, label: "A", position: 0 }).returning();
    await db.insert(voteResistances).values({ pollId: pW.id, tenantId: t.id, optionId: optA.id, voterRef: "mew-1", wert: 4, warVerifiziert: false });

    const items = await getAktivePolls(db as never, t.id);
    const enriched = await mitErgebnissen(db as never, t.id, items);

    const wid = enriched.find((p) => p.id === pW.id)!;
    expect(wid.widerstand?.gesamtWaehler).toBe(1); // Teilnahme sichtbar statt „Noch keine Stimmen"
    expect(wid.dot).toBeUndefined();               // kein Dot-Aggregat für Widerstands-Polls
    expect(wid.ergebnis.gesamt).toBe(0);           // Ja/Nein-Aggregat bleibt leer

    const ja = enriched.find((p) => p.id === pJa.id)!;
    expect(ja.widerstand).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getAllPollsForAdmin — Teilnahme-Zähler über ALLE Formate (Gate-B MAJOR
  // Block G: zählte vorher nur votes → Dot/Widerstand zeigten „0 Stimmen").
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)("getAllPollsForAdmin zählt Dot-/Widerstands-Teilnehmende (distinct), nicht nur votes", async () => {
    const [t] = await db.insert(tenants).values({ slug: `adm-${Date.now()}`, name: "AdminAgg" }).returning();
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    // Ja/Nein: 3 Stimmen (davon 1 verifiziert).
    const [pJa] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "ja?", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();
    await db.insert(votes).values([
      { pollId: pJa.id, tenantId: t.id, voterRef: "aj1", choice: "ja", warVerifiziert: true },
      { pollId: pJa.id, tenantId: t.id, voterRef: "aj2", choice: "nein", warVerifiziert: false },
      { pollId: pJa.id, tenantId: t.id, voterRef: "aj3", choice: "ja", warVerifiziert: false },
    ]);

    // Dot: 2 Teilnehmende (einer verteilt auf 2 Optionen → 3 Zeilen, aber 2 Personen).
    const [pDot] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "dot?", typ: "dot_voting", status: "aktiv", punkteBudget: 5 }).returning();
    const [dA] = await db.insert(pollOptions).values({ pollId: pDot.id, tenantId: t.id, label: "A", position: 0 }).returning();
    const [dB] = await db.insert(pollOptions).values({ pollId: pDot.id, tenantId: t.id, label: "B", position: 1 }).returning();
    await db.insert(voteAllocations).values([
      { pollId: pDot.id, tenantId: t.id, optionId: dA.id, voterRef: "ad1", punkte: 2, warVerifiziert: true },
      { pollId: pDot.id, tenantId: t.id, optionId: dB.id, voterRef: "ad1", punkte: 3, warVerifiziert: true },
      { pollId: pDot.id, tenantId: t.id, optionId: dA.id, voterRef: "ad2", punkte: 5, warVerifiziert: false },
    ]);

    // Widerstand: 1 Teilnehmende:r über 2 Optionen (2 Zeilen, 1 Person).
    const [pW] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "wid?", typ: "widerstandsabfrage", status: "aktiv" }).returning();
    const [wA] = await db.insert(pollOptions).values({ pollId: pW.id, tenantId: t.id, label: "WA", position: 0 }).returning();
    const [wB] = await db.insert(pollOptions).values({ pollId: pW.id, tenantId: t.id, label: "WB", position: 1 }).returning();
    await db.insert(voteResistances).values([
      { pollId: pW.id, tenantId: t.id, optionId: wA.id, voterRef: "aw1", wert: 0, warVerifiziert: true },
      { pollId: pW.id, tenantId: t.id, optionId: wB.id, voterRef: "aw1", wert: 7, warVerifiziert: true },
    ]);

    const items = await getAllPollsForAdmin(db as never, t.id);
    const ja = items.find((p) => p.id === pJa.id)!;
    expect([ja.stimmenGesamt, ja.stimmenVerifiziert, ja.typ]).toEqual([3, 1, "ja_nein_enthaltung"]);
    const dot = items.find((p) => p.id === pDot.id)!;
    expect([dot.stimmenGesamt, dot.stimmenVerifiziert, dot.typ]).toEqual([2, 1, "dot_voting"]);
    const wid = items.find((p) => p.id === pW.id)!;
    expect([wid.stimmenGesamt, wid.stimmenVerifiziert, wid.typ]).toEqual([1, 1, "widerstandsabfrage"]);
  });

  // -------------------------------------------------------------------------
  // Block J1 (Gate-B 3): Fragesteller-Identität in getAktivePolls — Defense-in-
  // Depth. Die VM trägt den Klarnamen NUR bei aktivem Rollenträger; Ex-
  // Rollenträger (herabgestuft/gesperrt) → ersteller.displayName === null.
  // -------------------------------------------------------------------------
  it.skipIf(SKIP)("getAktivePolls: ersteller-Klarname nur bei aktivem Rollenträger (demoted/gesperrt → null)", async () => {
    const [t] = await db.insert(tenants).values({ slug: `q-j1-${Date.now()}`, name: "J1-Ersteller" }).returning();
    const stadtT = await resolveRegionIdForScope(db as never, t.id, "stadt", null);

    // (1) Aktiver Rollenträger MIT Klarnamen.
    const [rt] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `rt-${Date.now()}@q.de`, displayName: "Rita Rolle", funktion: "Amt" })
      .returning();
    await db.insert(roles).values({ tenantId: t.id, userId: rt.id, roleType: "redakteur", regionId: stadtT });

    // (2) Ex-Rollenträger: Klarname in der DB, aber KEINE Rolle mehr (Bestandsfall,
    //     falls die Datenminimierung mal nicht lief).
    const [demoted] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `dem-${Date.now()}@q.de`, displayName: "Egon Ex", funktion: "Früher" })
      .returning();

    // (3) Gesperrter Rollenträger: hat eine Rolle, aber account_status='locked'
    //     → getUserRoleTypes/EXISTS zählt ihn nicht als aktiven Rollenträger.
    const [locked] = await db
      .insert(users)
      .values({ tenantId: t.id, email: `lck-${Date.now()}@q.de`, displayName: "Lea Locked", funktion: "Gesperrt", accountStatus: "locked" })
      .returning();
    await db.insert(roles).values({ tenantId: t.id, userId: locked.id, roleType: "redakteur", regionId: stadtT });

    const [pRt] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "von-rt", typ: "ja_nein_enthaltung", status: "aktiv", erstelltVon: rt.id }).returning();
    const [pDem] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "von-demoted", typ: "ja_nein_enthaltung", status: "aktiv", erstelltVon: demoted.id }).returning();
    const [pLck] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "von-locked", typ: "ja_nein_enthaltung", status: "aktiv", erstelltVon: locked.id }).returning();
    const [pNull] = await db.insert(polls).values({ tenantId: t.id, regionId: stadtT, frage: "ohne-ersteller", typ: "ja_nein_enthaltung", status: "aktiv" }).returning();

    const list = await getAktivePolls(db as never, t.id);

    const vonRt = list.find((p) => p.id === pRt.id)!;
    expect(vonRt.ersteller?.istRollentraeger).toBe(true);
    expect(vonRt.ersteller?.displayName).toBe("Rita Rolle");
    expect(vonRt.ersteller?.funktion).toBe("Amt");

    // Ex-Rollenträger: VM trägt KEINEN Namen mehr (Defense-in-Depth an der Quelle).
    const vonDem = list.find((p) => p.id === pDem.id)!;
    expect(vonDem.ersteller).not.toBeNull();
    expect(vonDem.ersteller?.istRollentraeger).toBe(false);
    expect(vonDem.ersteller?.displayName).toBeNull();
    expect(vonDem.ersteller?.funktion).toBeNull();

    // Gesperrter Rollenträger: ebenfalls unterdrückt.
    const vonLck = list.find((p) => p.id === pLck.id)!;
    expect(vonLck.ersteller?.istRollentraeger).toBe(false);
    expect(vonLck.ersteller?.displayName).toBeNull();

    // erstellt_von NULL → ersteller === null.
    const vonNull = list.find((p) => p.id === pNull.id)!;
    expect(vonNull.ersteller).toBeNull();
  });
});
