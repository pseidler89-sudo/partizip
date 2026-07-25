/**
 * demo-reset.test.ts — DB-Integrationstest des nächtlichen Demo-Resets.
 *
 * Kernaussage (Block I, Defense-in-Depth): der Reset löscht ALLE User des
 * Demo-Mandanten — nicht mehr nur @demo.invalid. So verschwinden auch
 * persistente Fremdkonten, die vor dem api/auth/request-Fence angelegt wurden.
 * Die beiden fail-closed-Guards (Tenant-Name „Musterstadt (Demo)" UND
 * Seed-Marker-Poll) bleiben unverändert und schützen weiter vor Fehlbedienung.
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { musterstadtSeedId } from "@/lib/demo/seed-ids";
import { demoReset } from "../../../../scripts/demo-reset.js";

const { tenants, users, polls, pollOptions, votes, voteAllocations, voteReceipts } = schema;

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

const DEMO_TENANT_NAME = "Musterstadt (Demo)";
const DEMO_SLUG = "demo-reset-test";

describe("demo-reset (Integration)", () => {
  let sql_: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  let demoTenantId: string;

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

    // Demo-Mandant mit korrektem Namen (Guard a) + Seed-Marker-Poll (Guard b).
    const [t] = await db
      .insert(tenants)
      .values({ slug: DEMO_SLUG, name: DEMO_TENANT_NAME })
      .returning();
    demoTenantId = t.id;

    const regionId = await resolveRegionIdForScope(db as never, t.id, "stadt", null);
    await db.insert(polls).values({
      id: musterstadtSeedId(DEMO_SLUG, "poll:offen"), // Seed-Marker (Guard b)
      tenantId: t.id,
      regionId,
      frage: "Seed-Beispielfrage?",
      typ: "ja_nein_enthaltung",
      status: "aktiv",
    });
    // Besucher-Stimme + Beleg auf der AKTIVEN ja/nein-Seed-Frage — die MUSS der
    // Reset weiterhin wischen (Spielwiese jeden Morgen frisch).
    await db.insert(votes).values({
      pollId: musterstadtSeedId(DEMO_SLUG, "poll:offen"),
      tenantId: t.id,
      voterRef: "besucher-hmac-1",
      choice: "ja",
    });
    await db.insert(voteReceipts).values({
      pollId: musterstadtSeedId(DEMO_SLUG, "poll:offen"),
      tenantId: t.id,
      code: "BELEG-OFFEN-1",
    });

    // FORMAT-Seed-Frage (P1): aktives Dot-Voting mit kuratierter Seed-Abgabe +
    // Beleg — der Reset darf sie NICHT anfassen (Beleg-Invariante, s. Skript).
    const dotPollId = musterstadtSeedId(DEMO_SLUG, "poll:dot");
    await db.insert(polls).values({
      id: dotPollId,
      tenantId: t.id,
      regionId,
      frage: "Format-Seed-Frage (Dot)?",
      typ: "dot_voting",
      punkteBudget: 5,
      status: "aktiv",
    });
    const [opt] = await db
      .insert(pollOptions)
      .values({ pollId: dotPollId, tenantId: t.id, label: "Option A", position: 0 })
      .returning();
    await db.insert(voteAllocations).values({
      pollId: dotPollId,
      tenantId: t.id,
      optionId: opt.id,
      voterRef: "demo:dot:0",
      punkte: 5,
      warVerifiziert: true,
    });
    await db.insert(voteReceipts).values({
      pollId: dotPollId,
      tenantId: t.id,
      code: "BELEG-FORMAT-1",
    });

    // Zwei User: ein ephemeres @demo.invalid-Konto UND ein persistentes
    // Fremdkonto (vor dem Fence angelegt) — beide müssen verschwinden.
    await db.insert(users).values([
      { tenantId: t.id, email: "ghost@demo.invalid", minAgeConfirmedAt: new Date() },
      { tenantId: t.id, email: "evil@example.com", minAgeConfirmedAt: new Date() },
    ]);
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  it.skipIf(SKIP)("löscht ALLE User des Demo-Tenants (auch Nicht-@demo.invalid)", async () => {
    const vorher = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.tenantId, demoTenantId));
    expect(vorher.length).toBe(2);

    // demoReset erwartet eine schema-lose drizzle-Instanz auf dieselbe Verbindung.
    const stats = await demoReset(drizzle(sql_), DEMO_SLUG);
    expect(stats.usersDeleted).toBe(2); // ephemer + persistentes Fremdkonto

    const nachher = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.tenantId, demoTenantId));
    expect(nachher.length).toBe(0);

    // Der kuratierte Seed-Poll (Marker) überlebt den Reset unverändert.
    const seedPoll = await db
      .select({ id: polls.id })
      .from(polls)
      .where(
        and(
          eq(polls.id, musterstadtSeedId(DEMO_SLUG, "poll:offen")),
          eq(polls.tenantId, demoTenantId),
        ),
      );
    expect(seedPoll.length).toBe(1);
  });

  it.skipIf(SKIP)(
    "Format-Seed-Frage überlebt MIT Abgaben+Beleg; aktive ja/nein-Besucher-Stimmen sind gewischt",
    async () => {
      const offenId = musterstadtSeedId(DEMO_SLUG, "poll:offen");
      const dotId = musterstadtSeedId(DEMO_SLUG, "poll:dot");

      // Besucher-Stimme + Beleg der aktiven ja/nein-Frage: gewischt.
      const offenVotes = await db
        .select({ id: votes.id })
        .from(votes)
        .where(eq(votes.pollId, offenId));
      expect(offenVotes.length).toBe(0);
      const offenReceipts = await db
        .select({ id: voteReceipts.id })
        .from(voteReceipts)
        .where(eq(voteReceipts.pollId, offenId));
      expect(offenReceipts.length).toBe(0);

      // Format-Frage: Poll, kuratierte Abgabe UND Beleg bleiben (Invariante
      // #Belege == #Teilnehmende — 1 == 1).
      const dotPoll = await db
        .select({ id: polls.id })
        .from(polls)
        .where(and(eq(polls.id, dotId), eq(polls.tenantId, demoTenantId)));
      expect(dotPoll.length).toBe(1);
      const alloc = await db
        .select({ voterRef: voteAllocations.voterRef })
        .from(voteAllocations)
        .where(eq(voteAllocations.pollId, dotId));
      expect(alloc.length).toBe(1);
      expect(alloc[0].voterRef).toBe("demo:dot:0");
      const dotReceipts = await db
        .select({ id: voteReceipts.id })
        .from(voteReceipts)
        .where(eq(voteReceipts.pollId, dotId));
      expect(dotReceipts.length).toBe(1);
    },
  );

  it.skipIf(SKIP)("Guard: falscher Tenant-Name → Abbruch (nichts gelöscht)", async () => {
    const [fremd] = await db
      .insert(tenants)
      .values({ slug: "kein-demo-reset-test", name: "Echte Stadt" })
      .returning();
    await db.insert(users).values({
      tenantId: fremd.id,
      email: "buerger@example.com",
      minAgeConfirmedAt: new Date(),
    });

    await expect(demoReset(drizzle(sql_), "kein-demo-reset-test")).rejects.toThrow(
      /ABBRUCH/,
    );

    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.tenantId, fremd.id));
    expect(rows.length).toBe(1); // unangetastet
  });
});
