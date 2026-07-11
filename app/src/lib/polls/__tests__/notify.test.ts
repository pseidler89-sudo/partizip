/**
 * notify.test.ts — DB-Integrationstests für den Benachrichtigungs-Motor
 * (getPollNotifyEmpfaenger / notifyNewPoll). Muster: queries.test.ts.
 *
 * Führt die ECHTEN Funktionen gegen eine ephemere PG aus (DATABASE_URL_TEST).
 * Der Mail-Transport wird injiziert (Spy) statt echt gesendet.
 *
 * Geprüfte Eigenschaften (Vertrauensprodukt / DSGVO):
 *   - Empfänger-Scope: stadt-Poll → alle opted-in aktiven Tenant-User;
 *     ortsteil-Poll → nur der passende Ortsteil.
 *   - Ausschluss: opted-out, deleted/@deleted.invalid, fremder Tenant.
 *   - notifyNewPoll: sendMail je Empfänger, sent/errors gezählt, ein
 *     fehlschlagender Send kippt den Rest NICHT, 0 Empfänger → 0/0.
 *   - KEINE E-Mail-Adresse im Versand-Pfad protokolliert (Audit hier nicht
 *     beteiligt — getestet in der Action; hier prüfen wir die reine Funktion).
 *
 * next/headers wird gemockt (notify.ts importiert es nicht direkt, aber der
 * Transitiv-Import-Graph über @/lib/anliegen/notify ist sauber — Mock zur
 * Sicherheit konsistent zu queries.test.ts).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
  getPollNotifyEmpfaenger,
  notifyNewPoll,
  type NotifyPoll,
} from "@/lib/polls/notify";
import type { TenantRow } from "@/lib/tenant";
import { buildTombstoneEmail } from "@/lib/konto/anonymize";

const { tenants, ortsteile, users } = schema;

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

/** Baut eine TenantRow für die Funktionen (nur id/slug/name werden genutzt). */
function tenantRow(id: string, slug: string, name: string): TenantRow {
  return {
    id,
    slug,
    name,
    primaryColor: null,
    logoUrl: null,
    welcomeText: null,
    isActive: true,
  };
}

describe("polls/notify (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let counter = 0;
  const nextSlug = (p: string) => `${p}-${Date.now()}-${++counter}`;

  beforeAll(async () => {
    if (SKIP) return;
    const reset = postgres(TEST_DB_URL!, { max: 1 });
    await reset`DROP SCHEMA IF EXISTS public CASCADE`;
    await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    sql_ = postgres(TEST_DB_URL!, { max: 4 });
    db = drizzle(sql_, { schema });
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  // -------------------------------------------------------------------------
  // getPollNotifyEmpfaenger — Scope + Ausschlüsse
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)(
    "stadt-Poll: alle opted-in aktiven Tenant-User; schließt opted-out, deleted/@deleted.invalid aus",
    async () => {
      const [t] = await db
        .insert(tenants)
        .values({ slug: nextSlug("nt"), name: "Notify-Stadt" })
        .returning();
      const tenant = tenantRow(t.id, t.slug, t.name);

      // 2 opted-in aktive User (erwartet).
      const [u1] = await db
        .insert(users)
        .values({ tenantId: t.id, email: `in1-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true })
        .returning();
      const [u2] = await db
        .insert(users)
        .values({ tenantId: t.id, email: `in2-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true })
        .returning();
      // opted-out → ausgeschlossen.
      await db
        .insert(users)
        .values({ tenantId: t.id, email: `out-${counter}@t.de`, accountStatus: "active", notifyNewPolls: false });
      // gelöscht/anonymisiert (Tombstone + deletedAt + notify false) → ausgeschlossen.
      const tombId = "00000000-0000-0000-0000-0000000000aa";
      await db.insert(users).values({
        tenantId: t.id,
        email: buildTombstoneEmail(tombId),
        accountStatus: "deleted",
        notifyNewPolls: false,
        deletedAt: new Date(),
      });
      // Grenzfall: @deleted.invalid + deletedAt IS NULL, aber notify true →
      // muss DENNOCH über den E-Mail-Filter ausgeschlossen werden.
      await db.insert(users).values({
        tenantId: t.id,
        email: `geloescht-edgecase@deleted.invalid`,
        accountStatus: "active",
        notifyNewPolls: true,
        deletedAt: null,
      });
      // locked → ausgeschlossen (nur 'active').
      await db
        .insert(users)
        .values({ tenantId: t.id, email: `locked-${counter}@t.de`, accountStatus: "locked", notifyNewPolls: true });

      const poll: NotifyPoll = { id: "p", frage: "F?", scopeLevel: "stadt", scopeCode: null };
      const emails = await getPollNotifyEmpfaenger(db as never, tenant, poll);

      expect(emails.sort()).toEqual([u1.email, u2.email].sort());
      expect(emails).not.toContain("geloescht-edgecase@deleted.invalid");
    },
  );

  it.skipIf(SKIP)(
    "ortsteil-Poll: nur User mit passendem Ortsteil; fremder Ortsteil ausgeschlossen",
    async () => {
      const [t] = await db
        .insert(tenants)
        .values({ slug: nextSlug("nt-ot"), name: "Notify-Ortsteil" })
        .returning();
      const tenant = tenantRow(t.id, t.slug, t.name);

      const [otA] = await db
        .insert(ortsteile)
        .values({ tenantId: t.id, code: "OT-A", name: "Ortsteil A" })
        .returning();
      const [otB] = await db
        .insert(ortsteile)
        .values({ tenantId: t.id, code: "OT-B", name: "Ortsteil B" })
        .returning();

      const [inA] = await db
        .insert(users)
        .values({ tenantId: t.id, email: `a-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true, ortsteilId: otA.id })
        .returning();
      // Ortsteil B + ohne Ortsteil → nicht im Scope.
      await db
        .insert(users)
        .values({ tenantId: t.id, email: `b-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true, ortsteilId: otB.id });
      await db
        .insert(users)
        .values({ tenantId: t.id, email: `none-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true, ortsteilId: null });

      const poll: NotifyPoll = { id: "p", frage: "F?", scopeLevel: "ortsteil", scopeCode: "OT-A" };
      const emails = await getPollNotifyEmpfaenger(db as never, tenant, poll);
      expect(emails).toEqual([inA.email]);
    },
  );

  it.skipIf(SKIP)(
    "ortsteil-Poll mit unbekanntem scopeCode: leere Empfängerliste (kein tenant-weiter Fallback)",
    async () => {
      const [t] = await db
        .insert(tenants)
        .values({ slug: nextSlug("nt-ot2"), name: "Notify-Ortsteil-Unbekannt" })
        .returning();
      const tenant = tenantRow(t.id, t.slug, t.name);
      await db
        .insert(users)
        .values({ tenantId: t.id, email: `x-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true });

      const poll: NotifyPoll = { id: "p", frage: "F?", scopeLevel: "ortsteil", scopeCode: "OT-UNKNOWN" };
      const emails = await getPollNotifyEmpfaenger(db as never, tenant, poll);
      expect(emails).toEqual([]);
    },
  );

  it.skipIf(SKIP)("ist tenant-scoped: User eines anderen Tenants werden NIE benachrichtigt", async () => {
    const [tA] = await db.insert(tenants).values({ slug: nextSlug("nt-iso-a"), name: "ISO-A" }).returning();
    const [tB] = await db.insert(tenants).values({ slug: nextSlug("nt-iso-b"), name: "ISO-B" }).returning();
    const tenantA = tenantRow(tA.id, tA.slug, tA.name);

    const [inA] = await db
      .insert(users)
      .values({ tenantId: tA.id, email: `iso-a-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true })
      .returning();
    // Gleicher Profiltyp im Fremd-Tenant — darf nicht auftauchen.
    await db
      .insert(users)
      .values({ tenantId: tB.id, email: `iso-b-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true });

    const poll: NotifyPoll = { id: "p", frage: "F?", scopeLevel: "stadt", scopeCode: null };
    const emails = await getPollNotifyEmpfaenger(db as never, tenantA, poll);
    expect(emails).toEqual([inA.email]);
  });

  // -------------------------------------------------------------------------
  // notifyNewPoll — Versand-Verhalten (Transport-Spy)
  // -------------------------------------------------------------------------

  it.skipIf(SKIP)("ruft transport.sendMail je Empfänger und zählt sent korrekt", async () => {
    const [t] = await db.insert(tenants).values({ slug: nextSlug("nt-send"), name: "Send-Test" }).returning();
    const tenant = tenantRow(t.id, t.slug, t.name);
    await db.insert(users).values([
      { tenantId: t.id, email: `s1-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true },
      { tenantId: t.id, email: `s2-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true },
    ]);

    const calls: Array<Record<string, unknown>> = [];
    const transport = { sendMail: async (opts: Record<string, unknown>) => { calls.push(opts); return {}; } };

    const poll: NotifyPoll = { id: "11111111-1111-1111-1111-111111111111", frage: "Mehr Bänke?", scopeLevel: "stadt", scopeCode: null };
    const res = await notifyNewPoll({ db: db as never, tenant, poll, host: `${t.slug}.partizip.online`, transport });

    expect(res).toEqual({ sent: 2, errors: 0 });
    expect(calls).toHaveLength(2);
    // Betreff + Link + Frage korrekt; Link folgt dem qr-actions-Muster (https).
    expect(calls[0].subject).toBe(`Neue Abstimmung in ${t.name}`);
    expect(String(calls[0].text)).toContain(`https://${t.slug}.partizip.online/${t.slug}/umfrage/${poll.id}`);
    expect(String(calls[0].text)).toContain("Mehr Bänke?");
  });

  it.skipIf(SKIP)("ein fehlschlagender Send kippt den Rest NICHT (best-effort, errors gezählt)", async () => {
    const [t] = await db.insert(tenants).values({ slug: nextSlug("nt-err"), name: "Err-Test" }).returning();
    const tenant = tenantRow(t.id, t.slug, t.name);
    await db.insert(users).values([
      { tenantId: t.id, email: `e1-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true },
      { tenantId: t.id, email: `e2-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true },
      { tenantId: t.id, email: `e3-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true },
    ]);

    let n = 0;
    const transport = {
      sendMail: async () => {
        n++;
        if (n === 2) throw new Error("SMTP down");
        return {};
      },
    };

    const poll: NotifyPoll = { id: "22222222-2222-2222-2222-222222222222", frage: "F?", scopeLevel: "stadt", scopeCode: null };
    const res = await notifyNewPoll({ db: db as never, tenant, poll, host: "localhost", transport });
    // 3 Empfänger: 1 Fehler, 2 Erfolge — der Fehler bricht die Schleife nicht ab.
    expect(res).toEqual({ sent: 2, errors: 1 });
  });

  it.skipIf(SKIP)("0 Empfänger → {sent:0, errors:0} und kein sendMail-Aufruf", async () => {
    const [t] = await db.insert(tenants).values({ slug: nextSlug("nt-zero"), name: "Zero-Test" }).returning();
    const tenant = tenantRow(t.id, t.slug, t.name);
    // Nur ein opted-out User → keine Empfänger.
    await db.insert(users).values({ tenantId: t.id, email: `z-${counter}@t.de`, accountStatus: "active", notifyNewPolls: false });

    let called = 0;
    const transport = { sendMail: async () => { called++; return {}; } };
    const poll: NotifyPoll = { id: "p", frage: "F?", scopeLevel: "stadt", scopeCode: null };
    const res = await notifyNewPoll({ db: db as never, tenant, poll, host: "localhost", transport });

    expect(res).toEqual({ sent: 0, errors: 0 });
    expect(called).toBe(0);
  });

  it.skipIf(SKIP)("localhost-Host → http-Link (proto-Ableitung exakt wie qr-actions)", async () => {
    const [t] = await db.insert(tenants).values({ slug: nextSlug("nt-local"), name: "Local-Test" }).returning();
    const tenant = tenantRow(t.id, t.slug, t.name);
    await db.insert(users).values({ tenantId: t.id, email: `l-${counter}@t.de`, accountStatus: "active", notifyNewPolls: true });

    const calls: Array<Record<string, unknown>> = [];
    const transport = { sendMail: async (opts: Record<string, unknown>) => { calls.push(opts); return {}; } };
    const poll: NotifyPoll = { id: "33333333-3333-3333-3333-333333333333", frage: "F?", scopeLevel: "stadt", scopeCode: null };
    // qr-actions-Regel: host.startsWith("localhost") || host.includes("127.0.0.1")
    // → http. Ein blanker localhost-Host (z. B. Test-Default) ergibt also http.
    await notifyNewPoll({ db: db as never, tenant, poll, host: "localhost", transport });

    expect(String(calls[0].text)).toContain(`http://localhost/${t.slug}/umfrage/${poll.id}`);
  });
});
