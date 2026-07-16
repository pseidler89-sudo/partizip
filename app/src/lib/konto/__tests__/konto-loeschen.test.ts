/**
 * konto-loeschen.test.ts — DB-Integrationstest für die Konto-Löschung (H3 DSGVO).
 *
 * Läuft NUR wenn DATABASE_URL_TEST gesetzt ist (sonst geskippt).
 *
 * Verifiziert nach Muster pruef-workflow.test.ts:
 *   - users-E-Mail anonymisiert (Tombstone) + UNIQUE(tenant,email) erfüllt
 *   - alle PII-Felder geleert, accountStatus='deleted', deletedAt gesetzt
 *   - sessions revoked, roles + anliegen_followers gelöscht
 *   - offene auth_tokens (per alter E-Mail) gelöscht
 *   - eigene Anliegen erhalten (pseudonymer Vorgang bleibt)
 *   - Audit konto.deleted geschrieben + PII-frei
 *   - „letzter Admin" wird verweigert; bei zweitem Admin erlaubt
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { resolveRegionIdForScope } from "@/lib/region/scope";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import { computeCreatorRefWithSalt } from "@/lib/anliegen/creator-ref";
import { deleteKontoCore, isLetzterAdmin } from "@/lib/konto/delete";

const {
  tenants, users, roles, sessions, authTokens,
  anliegen, anliegenEvents, anliegenFollowers, auditEvents,
  verificationLocations, verificationSlots, verificationBookings, invitations,
} = schema;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../../db/migrations");

const TEST_DB_URL = process.env.DATABASE_URL_TEST;
const TEST_SALT = "test-anliegen-ref-salt-0123456789abcdef";

if (TEST_DB_URL) {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`SICHERHEITS-ABBRUCH: "${dbName}" endet nicht auf "_test"`);
  }
}

const SKIP = !TEST_DB_URL;

type DbType = ReturnType<typeof drizzle>;

describe("Konto-Löschung (Integration)", () => {
  let sql_: postgres.Sql;
  let db: DbType;
  let tenantId: string;

  let counter = 0;
  function nextId() {
    return `konto-${Date.now()}-${++counter}`;
  }

  beforeAll(async () => {
    if (SKIP) return;
    // computeCreatorRef nutzt env-Salt; setzen für den DeleteCore-Pfad nicht nötig
    // (deleteKontoCore berührt keine Anliegen), aber für Seeding nutzen wir den
    // expliziten With-Salt-Helper.
    process.env.ANLIEGEN_REF_SALT = TEST_SALT;

    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_);
    await migrate(db, { migrationsFolder });

    const [tenant] = await db.insert(tenants).values({
      slug: `konto-${Date.now()}`,
      name: "Konto-Test-Tenant",
    }).returning();
    tenantId = tenant.id;
  });

  afterAll(async () => {
    if (SKIP || !sql_) return;
    await sql_.end();
  });

  /** Legt einen vollständigen User mit Rolle/Session/Token/Anliegen/Follower an. */
  async function seedFullUser(opts?: { roleType?: "user" | "kommune_admin" | "super_admin" }) {
    const email = `${nextId()}@konto-test.de`;
    const [user] = await db.insert(users).values({
      tenantId,
      email,
      birthYear: 1990,
      birthMonth: 4,
      verificationStatus: "verified",
      verificationMethod: "in_person",
      residencyVerifiedAt: new Date(),
      minAgeConfirmedAt: new Date(),
      accountStatus: "active",
    }).returning();

    await db.insert(roles).values({
      tenantId,
      userId: user.id,
      roleType: opts?.roleType ?? "user",
      regionId: await resolveRegionIdForScope(db as never, tenantId, "stadt", null),
    });

    await db.insert(sessions).values({
      tenantId,
      userId: user.id,
      tokenHash: `hash-${nextId()}`,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await db.insert(authTokens).values({
      tenantId,
      email,
      tokenHash: `token-${nextId()}`,
      expiresAt: new Date(Date.now() + 1000 * 60 * 15),
    });

    // Eigenes Anliegen (pseudonym) + Event + Follower
    const creatorRef = computeCreatorRefWithSalt(TEST_SALT, user.id);
    const [anl] = await db.insert(anliegen).values({
      tenantId,
      trackingCode: `TRK-${nextId()}`,
      creatorRef,
      titel: "Mein Anliegen",
      beschreibung: "Test",
      status: "eingegangen",
    }).returning();

    await db.insert(anliegenEvents).values({
      anliegenId: anl.id,
      status: "eingegangen",
    });

    await db.insert(anliegenFollowers).values({
      anliegenId: anl.id,
      userId: user.id,
    });

    return { user, email, anliegenId: anl.id };
  }

  it.skipIf(SKIP)("DATABASE_URL_TEST nicht gesetzt → Smoke", () => {
    expect(true).toBe(true);
  });

  it.skipIf(SKIP)("anonymisiert die E-Mail (Tombstone) und erfüllt UNIQUE(tenant,email)", async () => {
    const { user } = await seedFullUser();

    const result = await deleteKontoCore(db, tenantId, user.id);
    expect(result.ok).toBe(true);

    const [after] = await db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, user.id)));

    expect(after.email).toBe(`geloescht-${user.id}@deleted.invalid`);
    // Erneutes Lesen über die Tombstone-E-Mail liefert genau diese Zeile
    // (UNIQUE erfüllt — kein Insert-Konflikt).
    const byEmail = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, after.email)));
    expect(byEmail).toHaveLength(1);
  });

  it.skipIf(SKIP)("leert alle PII-Felder, setzt accountStatus='deleted' + deletedAt", async () => {
    const { user } = await seedFullUser();
    await deleteKontoCore(db, tenantId, user.id);

    const [after] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id));

    expect(after.birthYear).toBeNull();
    expect(after.birthMonth).toBeNull();
    expect(after.ortsteilId).toBeNull();
    expect(after.verificationMethod).toBeNull();
    expect(after.residencyVerifiedAt).toBeNull();
    expect(after.minAgeConfirmedAt).toBeNull();
    expect(after.verificationStatus).toBe("pending");
    expect(after.accountStatus).toBe("deleted");
    expect(after.deletedAt).not.toBeNull();
  });

  it.skipIf(SKIP)("revoked Sessions, löscht Rollen + Follower + auth_tokens", async () => {
    const { user, email } = await seedFullUser();
    await deleteKontoCore(db, tenantId, user.id);

    const sess = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(sess.length).toBeGreaterThan(0);
    for (const s of sess) {
      expect(s.revokedAt).not.toBeNull();
    }

    const rls = await db.select().from(roles).where(eq(roles.userId, user.id));
    expect(rls).toHaveLength(0);

    const fol = await db.select().from(anliegenFollowers).where(eq(anliegenFollowers.userId, user.id));
    expect(fol).toHaveLength(0);

    const tok = await db
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tenantId, tenantId), eq(authTokens.email, email)));
    expect(tok).toHaveLength(0);
  });

  it.skipIf(SKIP)("lässt eigene Anliegen erhalten (pseudonymer Vorgang bleibt)", async () => {
    const { user, anliegenId } = await seedFullUser();
    await deleteKontoCore(db, tenantId, user.id);

    const [anl] = await db.select().from(anliegen).where(eq(anliegen.id, anliegenId));
    expect(anl).toBeDefined();
    expect(anl.titel).toBe("Mein Anliegen");
    // creator_ref bleibt unverändert (kein User-FK, Pseudonymität gewahrt)
    expect(anl.creatorRef).toBe(computeCreatorRefWithSalt(TEST_SALT, user.id));
  });

  it.skipIf(SKIP)("löscht verification_bookings und gibt Slot-Kapazität frei (Audit M4)", async () => {
    const { user } = await seedFullUser();
    const regionId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    const [loc] = await db.insert(verificationLocations).values({
      tenantId, regionId, name: "Rathaus", address: "Markt 1",
    }).returning();
    const [slot] = await db.insert(verificationSlots).values({
      locationId: loc.id,
      startsAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      endsAt: new Date(Date.now() + 1000 * 60 * 60 * 25),
      capacity: 5, bookedCount: 1,
    }).returning();
    await db.insert(verificationBookings).values({
      tenantId, slotId: slot.id, userId: user.id,
      code: `TERMIN-${nextId()}`, status: "gebucht",
    });

    const result = await deleteKontoCore(db, tenantId, user.id);
    expect(result.ok).toBe(true);

    const bookings = await db.select().from(verificationBookings)
      .where(and(eq(verificationBookings.tenantId, tenantId), eq(verificationBookings.userId, user.id)));
    expect(bookings).toHaveLength(0);

    const [slotAfter] = await db.select().from(verificationSlots)
      .where(eq(verificationSlots.id, slot.id));
    expect(slotAfter.bookedCount).toBe(0);
  });

  it.skipIf(SKIP)("tombstoned invitations.email und nullt accepted_by (Audit M5)", async () => {
    const { user, email } = await seedFullUser();
    const regionId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    const [inv] = await db.insert(invitations).values({
      tenantId, email, roleType: "verifier", regionId,
      tokenHash: `inv-${nextId()}`, status: "accepted", acceptedBy: user.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    }).returning();

    await deleteKontoCore(db, tenantId, user.id);

    const [invAfter] = await db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(invAfter.email).toBe(`geloescht-${user.id}@deleted.invalid`);
    expect(invAfter.email).not.toContain("@konto-test.de");
    expect(invAfter.acceptedBy).toBeNull();
    // PII-freie Historie bleibt erhalten
    expect(invAfter.status).toBe("accepted");
    expect(invAfter.roleType).toBe("verifier");
  });

  it.skipIf(SKIP)("tombstoned auch eine PENDING-Einladung bei Mixed-Case-Konto-Mail (Gate-B M5)", async () => {
    // users.email wird NICHT normalisiert, invitations.email schon (lowercase).
    const regionId = await resolveRegionIdForScope(db as never, tenantId, "stadt", null);
    const mixed = `Max.${nextId()}@Konto-Test.de`;
    const [user] = await db.insert(users).values({
      tenantId, email: mixed, birthYear: 1990, birthMonth: 4,
      minAgeConfirmedAt: new Date(), accountStatus: "active",
    }).returning();
    // pending-Einladung mit normalisierter (lowercase) Mail, acceptedBy noch NULL
    const [inv] = await db.insert(invitations).values({
      tenantId, email: mixed.trim().toLowerCase(), roleType: "beobachter", regionId,
      tokenHash: `inv-${nextId()}`, status: "pending",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    }).returning();

    await deleteKontoCore(db, tenantId, user.id);

    const [invAfter] = await db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(invAfter.email).toBe(`geloescht-${user.id}@deleted.invalid`);
    expect(invAfter.email.toLowerCase()).not.toContain("konto-test.de");
  });

  it.skipIf(SKIP)("schreibt ein PII-freies Audit-Event konto.deleted", async () => {
    const { user } = await seedFullUser();
    await deleteKontoCore(db, tenantId, user.id);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "konto.deleted"), eq(auditEvents.targetId, user.id)));

    expect(audits).toHaveLength(1);
    expect(audits[0].actorRef).toBe(user.id);
    // PII-frei: keine E-Mail im Audit (weder actorRef noch metadata)
    expect(JSON.stringify(audits[0])).not.toContain("@");
  });

  it.skipIf(SKIP)("verweigert die Löschung des letzten Admins", async () => {
    const { user } = await seedFullUser({ roleType: "kommune_admin" });

    expect(await isLetzterAdmin(db, tenantId, user.id)).toBe(true);

    const result = await deleteKontoCore(db, tenantId, user.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/einzige/i);

    // Konto unverändert (nicht gelöscht)
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.accountStatus).toBe("active");
    expect(after.deletedAt).toBeNull();
  });

  it.skipIf(SKIP)("erlaubt die Löschung eines Admins, wenn ein weiterer Admin existiert", async () => {
    const adminA = await seedFullUser({ roleType: "kommune_admin" });
    const adminB = await seedFullUser({ roleType: "super_admin" });

    expect(await isLetzterAdmin(db, tenantId, adminA.user.id)).toBe(false);

    const result = await deleteKontoCore(db, tenantId, adminA.user.id);
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(users).where(eq(users.id, adminA.user.id));
    expect(after.accountStatus).toBe("deleted");

    // adminB unberührt
    const [b] = await db.select().from(users).where(eq(users.id, adminB.user.id));
    expect(b.accountStatus).toBe("active");
  });

  it.skipIf(SKIP)("Race: zwei letzte Admins parallel → genau einer gelöscht, Tenant behält einen Admin", async () => {
    // Eigener Tenant mit GENAU zwei Admins (kontrollierte Admin-Zahl).
    const [t2] = await db.insert(tenants).values({
      slug: `konto-race-${Date.now()}`,
      name: "Race-Tenant",
    }).returning();

    async function seedAdmin(role: "kommune_admin" | "super_admin") {
      const email = `${nextId()}@race-test.de`;
      const [u] = await db.insert(users).values({
        tenantId: t2.id, email, accountStatus: "active",
      }).returning();
      await db.insert(roles).values({
        tenantId: t2.id, userId: u.id, roleType: role, regionId: await resolveRegionIdForScope(db as never, t2.id, "stadt", null),
      });
      return u;
    }

    const a = await seedAdmin("kommune_admin");
    const b = await seedAdmin("super_admin");

    // Beide gleichzeitig löschen — Advisory-Lock muss serialisieren.
    const [ra, rb] = await Promise.all([
      deleteKontoCore(db, t2.id, a.id),
      deleteKontoCore(db, t2.id, b.id),
    ]);

    // Genau einer erfolgreich, einer als „letzter Admin" verweigert.
    const okCount = [ra.ok, rb.ok].filter(Boolean).length;
    expect(okCount).toBe(1);
    const refused = ra.ok ? rb : ra;
    expect(refused.error).toMatch(/einzige/i);

    // Der Tenant behält GENAU einen (aktiven) Admin — nicht verwaist.
    const remainingRoles = await db
      .select()
      .from(roles)
      .where(eq(roles.tenantId, t2.id));
    expect(remainingRoles).toHaveLength(1);
  });
});
