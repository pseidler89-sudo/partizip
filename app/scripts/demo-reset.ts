/**
 * demo-reset.ts — nächtlicher Reset der Akquise-Spielwiese (Demo-Mandant).
 *
 * Macht die Demo jeden Morgen frisch, OHNE den kuratierten Seed-Zustand zu
 * zerstören. Läuft STRIKT tenant-scoped und FAIL-CLOSED:
 *
 * SCHUTZ GEGEN ENV-FEHLBEDIENUNG (Gate-B MAJOR-1): Bevor irgendetwas gelöscht
 * wird, muss der Ziel-Tenant sich DOPPELT als der geseedete Demo-Mandant
 * ausweisen — (a) Tenant-Name ist exakt der Seed-Name „Musterstadt (Demo)" UND
 * (b) die deterministische Seed-Poll-ID (uuid5 aus seed-musterstadt.ts)
 * existiert bei diesem Tenant. Zeigt DEMO_TENANT_SLUG versehentlich auf einen
 * echten Mandanten (Staging/Prod-Verwechslung), bricht das Skript ab, ohne eine
 * Zeile anzufassen. DEMO_TENANT_SLUG ist PFLICHT (kein Default).
 *
 * Reset-Semantik (eine Transaktion — kein Teilzustand):
 *   1. Stimmen + Beleg-Codes aller AKTIVEN Fragen des Demo-Mandanten löschen
 *      (dort stimmen nur Demo-Besucher ab). Die GESCHLOSSENE Beispiel-Frage
 *      samt ihrer 7 Seed-Stimmen/Belege bleibt — sie IST der Prüf-Moment.
 *   2. Alle NICHT-Seed-Fragen des Demo-Mandanten löschen (Kaskade räumt
 *      Optionen/Stimmen/Belege/Zuteilungen/Widerstände): ephemere Demo-Admins
 *      (Verwaltungs-Perspektive, lib/demo/actions.ts) erstellen eigene Fragen —
 *      die Spielstände verschwinden vollständig; nur die drei kuratierten
 *      Seed-Fragen (deterministische IDs aus src/lib/demo/seed-ids.ts) bleiben.
 *   3. Alle QR-Codes des Demo-Mandanten löschen (qr_redemptions CASCADE) —
 *      auch die stammen nur von Demo-Admins, der Seed legt keine an.
 *   4. Ephemere Demo-Konten (@demo.invalid) löschen — Sessions/Rollen CASCADE.
 *   5. Anliegen des Demo-Mandanten löschen (Events/Follower CASCADE) — Seed
 *      legt keine an; alles dort ist Besucher-Content (Gate-B MINOR-5).
 *   6. rate_limit_events der Demo-Scopes (Bürger + Verwaltung) älter als 24 h
 *      aufräumen.
 *
 * Verwendung (Cron, täglich z. B. 03:30):
 *   DEMO_TENANT_SLUG=demo npm run demo:reset
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, like, lt, notInArray, sql } from "drizzle-orm";
import {
  tenants,
  polls,
  votes,
  voteReceipts,
  users,
  anliegen,
  qrCodes,
  rateLimitEvents,
  auditEvents,
} from "../src/db/schema.js";
import { SEED_NAMESPACE, uuidV5 } from "./seed-utils.js";
import { musterstadtSeedPollIds } from "../src/lib/demo/seed-ids.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";
const DEMO_EMAIL_DOMAIN = "demo.invalid"; // == src/lib/demo/config.ts
/** MUSS dem Seed-Namen in seed-musterstadt.ts entsprechen (Demo-Marker a). */
const DEMO_TENANT_NAME = "Musterstadt (Demo)";

async function main() {
  const SLUG = process.env.DEMO_TENANT_SLUG?.trim().toLowerCase();
  if (!SLUG) {
    throw new Error(
      "DEMO_TENANT_SLUG ist Pflicht (kein Default) — nichts gelöscht.",
    );
  }

  const sqlc = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sqlc);

  const tenantRows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, SLUG))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant) throw new Error(`Demo-Mandant '${SLUG}' nicht gefunden — nichts gelöscht.`);
  const tenantId = tenant.id;

  // --- Demo-Marker-Guard (fail-closed, Gate-B MAJOR-1) ----------------------
  if (tenant.name !== DEMO_TENANT_NAME) {
    throw new Error(
      `ABBRUCH: Tenant '${SLUG}' heißt '${tenant.name}', nicht '${DEMO_TENANT_NAME}' — ` +
        "das ist NICHT der geseedete Demo-Mandant. Nichts gelöscht.",
    );
  }
  const seedPollId = uuidV5(SEED_NAMESPACE, `musterstadt:${SLUG}:poll:offen`);
  const marker = await db
    .select({ id: polls.id })
    .from(polls)
    .where(and(eq(polls.id, seedPollId), eq(polls.tenantId, tenantId)))
    .limit(1);
  if (!marker[0]) {
    throw new Error(
      `ABBRUCH: Seed-Marker-Poll ${seedPollId} fehlt bei Tenant '${SLUG}' — ` +
        "kein von seed-musterstadt.ts angelegter Demo-Mandant. Nichts gelöscht.",
    );
  }

  // --- Reset in EINER Transaktion (kein Teilzustand) ------------------------
  const stats = await db.transaction(async (tx) => {
    const aktiveIds = (
      await tx
        .select({ id: polls.id })
        .from(polls)
        .where(and(eq(polls.tenantId, tenantId), eq(polls.status, "aktiv")))
    ).map((r: { id: string }) => r.id);

    let votesDeleted = 0;
    let receiptsDeleted = 0;
    if (aktiveIds.length > 0) {
      const v = await tx
        .delete(votes)
        .where(and(eq(votes.tenantId, tenantId), inArray(votes.pollId, aktiveIds)))
        .returning({ id: votes.id });
      votesDeleted = v.length;
      const r = await tx
        .delete(voteReceipts)
        .where(and(eq(voteReceipts.tenantId, tenantId), inArray(voteReceipts.pollId, aktiveIds)))
        .returning({ id: voteReceipts.id });
      receiptsDeleted = r.length;
    }

    // Nicht-Seed-Fragen der Demo-Admins (Verwaltungs-Perspektive) — VOR der
    // User-Löschung, damit der Spielstand komplett verschwindet (polls-Kaskade
    // räumt options/votes/receipts/allocations/resistances; erstelltVon wäre
    // nach der User-Löschung ohnehin nur SET NULL, die Frage bliebe sonst stehen).
    const seedPollIds = musterstadtSeedPollIds(SLUG);
    const p = await tx
      .delete(polls)
      .where(and(eq(polls.tenantId, tenantId), notInArray(polls.id, seedPollIds)))
      .returning({ id: polls.id });

    // QR-Codes der Demo-Admins (qr_redemptions CASCADE) — der Seed legt keine an.
    const q = await tx
      .delete(qrCodes)
      .where(eq(qrCodes.tenantId, tenantId))
      .returning({ id: qrCodes.id });

    const u = await tx
      .delete(users)
      .where(and(eq(users.tenantId, tenantId), like(users.email, `%@${DEMO_EMAIL_DOMAIN}`)))
      .returning({ id: users.id });

    // Besucher-Anliegen (Seed legt keine an; Events/Follower CASCADE).
    const a = await tx
      .delete(anliegen)
      .where(eq(anliegen.tenantId, tenantId))
      .returning({ id: anliegen.id });

    // Beide Demo-Scopes (Bürger-Session + Verwaltungs-Session) aufräumen.
    await tx
      .delete(rateLimitEvents)
      .where(
        and(
          inArray(rateLimitEvents.scope, ["demo_session", "demo_admin_session"]),
          lt(rateLimitEvents.createdAt, sql`now() - interval '24 hours'`),
        ),
      );

    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "system",
      actorRef: null,
      action: "demo.reset_completed",
      metadata: {
        tenant: SLUG,
        votesDeleted,
        receiptsDeleted,
        pollsDeleted: p.length,
        qrCodesDeleted: q.length,
        usersDeleted: u.length,
        anliegenDeleted: a.length,
      },
    });

    return {
      votesDeleted,
      receiptsDeleted,
      pollsDeleted: p.length,
      qrCodesDeleted: q.length,
      usersDeleted: u.length,
      anliegenDeleted: a.length,
    };
  });

  console.log(
    `Demo-Reset '${SLUG}': ${stats.votesDeleted} Stimmen, ${stats.receiptsDeleted} Belege, ` +
      `${stats.pollsDeleted} Demo-Fragen, ${stats.qrCodesDeleted} QR-Codes, ` +
      `${stats.usersDeleted} Demo-Konten, ${stats.anliegenDeleted} Anliegen entfernt.`,
  );
  await sqlc.end();
}

main().catch((err) => {
  console.error("Demo-Reset fehlgeschlagen:", err);
  process.exit(1);
});
