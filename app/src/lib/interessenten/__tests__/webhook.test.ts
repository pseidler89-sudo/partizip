/**
 * webhook.test.ts — DB-Integrationstests für den Tymeslot-Webhook-Kern (N2,
 * verarbeiteWebhookEvent). Läuft NUR mit DATABASE_URL_TEST (echte PG16).
 *
 * Deckt: meeting.created → Lead (quelle=tymeslot, uid, termin_am); doppelte
 * Zustellung desselben uid → EIN Lead (Idempotenz); anderes Event → kein Insert;
 * fehlende attendee.email → kein Insert. (Token-Vergleich: siehe core.test.ts.)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, count } from "drizzle-orm";
import * as schema from "@/db/schema.js";
import type { Db } from "@/db/client";
import { verarbeiteWebhookEvent } from "@/lib/interessenten/webhook";
import { TYMESLOT_FELD_MAX, TYMESLOT_MAX_BODY_BYTES } from "@/lib/interessenten/core";

const { interessenten, auditEvents } = schema;

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

function meetingCreated(uid: string, email = "buchung@beispiel.de") {
  return {
    event: "meeting.created",
    data: {
      meeting: {
        uid,
        start_time: "2026-09-15T09:30:00.000Z",
        attendee: {
          name: "Bea Bucher",
          email,
          company: "Kreis Beispiel",
          message: "Bis dann.",
        },
      },
    },
  };
}

describe.skipIf(SKIP)("verarbeiteWebhookEvent (Integration)", () => {
  let sql_: postgres.Sql;
  let db: Db;

  beforeAll(async () => {
    const resetSql = postgres(TEST_DB_URL!, { max: 1 });
    await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
    await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await resetSql`CREATE SCHEMA public`;
    await resetSql.end();

    sql_ = postgres(TEST_DB_URL!, { max: 5 });
    db = drizzle(sql_) as unknown as Db;
    await migrate(db as never, { migrationsFolder });
  });

  afterAll(async () => {
    if (sql_) await sql_.end();
  });

  it("meeting.created → Lead (quelle=tymeslot, uid, termin_am) + Mail", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await verarbeiteWebhookEvent(db, meetingCreated("uid-A"), { notify });
    expect(res.inserted).toBe(true);
    expect(notify).toHaveBeenCalledOnce();

    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.tymeslotMeetingUid, "uid-A"));
    expect(rows).toHaveLength(1);
    expect(rows[0].quelle).toBe("tymeslot");
    expect(rows[0].terminAm?.toISOString()).toBe("2026-09-15T09:30:00.000Z");

    // Audit tenant-frei + PII-frei.
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "interessent.created"));
    const meta = JSON.stringify(audits.map((a: { metadata: unknown }) => a.metadata));
    expect(meta).toContain("tymeslot");
    expect(meta).not.toContain("buchung@beispiel.de");
    expect(meta).not.toContain("Bea");
  });

  it("doppelte Zustellung desselben uid → EIN Lead (Idempotenz)", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const first = await verarbeiteWebhookEvent(db, meetingCreated("uid-DUP"), { notify });
    const second = await verarbeiteWebhookEvent(db, meetingCreated("uid-DUP"), { notify });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false); // onConflictDoNothing greift
    expect(notify).toHaveBeenCalledOnce(); // Mail nur beim echten Neu-Insert

    const rows = await db
      .select({ n: count() })
      .from(interessenten)
      .where(eq(interessenten.tymeslotMeetingUid, "uid-DUP"));
    expect(rows[0].n).toBe(1);
  });

  it("anderes Event → kein Insert", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await verarbeiteWebhookEvent(
      db,
      { event: "meeting.cancelled", data: { meeting: { uid: "uid-CANCEL", attendee: { email: "x@y.de" } } } },
      { notify }
    );
    expect(res.inserted).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.tymeslotMeetingUid, "uid-CANCEL"));
    expect(rows).toHaveLength(0);
  });

  it("überlanges message-Feld wird gekappt gespeichert (Gate-B FIX 4)", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const langeNachricht = "z".repeat(5000);
    const body = meetingCreated("uid-CAP");
    body.data.meeting.attendee.message = langeNachricht;
    const res = await verarbeiteWebhookEvent(db, body, { notify });
    expect(res.inserted).toBe(true);

    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.tymeslotMeetingUid, "uid-CAP"));
    expect(rows).toHaveLength(1);
    expect(rows[0].nachricht).toHaveLength(TYMESLOT_FELD_MAX.NACHRICHT);
  });

  it("Riesen-Payload → kein Insert (2xx-Fall, Größen-Guard)", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const body = meetingCreated("uid-HUGE");
    // Body deutlich über der Byte-Grenze aufblähen.
    body.data.meeting.attendee.message = "x".repeat(TYMESLOT_MAX_BODY_BYTES + 1000);
    const res = await verarbeiteWebhookEvent(db, body, { notify });
    expect(res.inserted).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.tymeslotMeetingUid, "uid-HUGE"));
    expect(rows).toHaveLength(0);
  });

  it("fehlende attendee.email → kein Insert (2xx-Fall)", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await verarbeiteWebhookEvent(
      db,
      { event: "meeting.created", data: { meeting: { uid: "uid-NOEMAIL", attendee: { name: "Ohne Mail" } } } },
      { notify }
    );
    expect(res.inserted).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(interessenten)
      .where(eq(interessenten.tymeslotMeetingUid, "uid-NOEMAIL"));
    expect(rows).toHaveLength(0);
  });
});
