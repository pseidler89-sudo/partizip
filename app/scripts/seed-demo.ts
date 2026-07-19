/**
 * seed-demo.ts — Vorführ-Demodaten für den Pilot-Tenant (Launch-Kit, Phase 2).
 *
 * Legt auf EINEM Tenant (Default `taunusstein-staging`, via DEMO_TENANT_SLUG) die
 * komplette vorführbare Kette an — IDEMPOTENT (zweimal laufen lassen = gleicher
 * Zustand) und repeatable (der Verifier-Flow lässt sich nach einer Demo erneut
 * zeigen, weil die Termin-Persona bei jedem Lauf auf Stufe 1 zurückgesetzt wird).
 *
 * Enthält:
 *   - 5 Personas (deterministische uuid5-IDs): Bürger Stufe 1, Bürger Stufe 2
 *     (wohnsitz-verifiziert vorgeseedet), Verifier, kommune_admin, Termin-Persona
 *     (Stufe 1 mit OFFENEM Termin für den Verifier-Flow).
 *   - 3 Demo-Umfragen: offenes Stimmungsbild (aktiv), verbindliche Abstimmung
 *     (aktiv), GESCHLOSSENE Frage mit veröffentlichter Beleg-Liste (Stimmen+Belege).
 *   - 1 Demo-Standort mit buchbarem Zukunfts-Slot + 1 heute fälligem Slot, auf dem
 *     die Termin-Persona einen offenen Termin (status 'gebucht') hat.
 *
 * DATENSCHUTZ/SECRET-BALLOT: Demo-Stimmen tragen klar erkennbare Demo-voter_refs
 * (kein echter HMAC), Belege sind echte CSPRNG-Codes (gemeinsamer Generator). Keine
 * echten Personendaten. Magic-Link liefert nur an Patricks Adressen → die Demo-
 * Personas sind reine Anschauungs-Zustände (vorgeseedet, kein Live-Login nötig).
 *
 * Verwendung (Staging, via tools-Profil, OHNE .env zu lesen):
 *   docker compose --profile tools run --rm -e DEMO_TENANT_SLUG=taunusstein-staging tools npm run db:seed:demo
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql as drSql } from "drizzle-orm";
import {
  tenants,
  users,
  roles,
  polls,
  votes,
  voteReceipts,
  verificationLocations,
  verificationSlots,
  verificationBookings,
  auditEvents,
} from "../src/db/schema.js";
import { generateReadableCode } from "../src/lib/readable-code.js";
import { normalizeEmail } from "../src/lib/auth/email.js";
import { SEED_NAMESPACE, uuidV5, resolveRegionId } from "./seed-utils.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";
const TENANT_SLUG = process.env.DEMO_TENANT_SLUG ?? "taunusstein-staging";

// Hilfen für relative Zeiten (als gebundene JS-Date-Parameter — nie in Roh-SQL).
const now = new Date();
function addHours(d: Date, h: number) {
  return new Date(d.getTime() + h * 3600_000);
}
function addDays(d: Date, days: number) {
  return new Date(d.getTime() + days * 86_400_000);
}
function addMonths(d: Date, m: number) {
  const r = new Date(d.getTime());
  r.setMonth(r.getMonth() + m);
  if (r.getDate() !== d.getDate()) r.setDate(0);
  return r;
}

interface PersonaSpec {
  key: string;
  email: string;
  stufe2?: boolean;
  role?: "verifier" | "kommune_admin";
  /** Termin-Persona: bei jedem Lauf auf Stufe 1 zurücksetzen (repeatable Demo). */
  resetToStufe1?: boolean;
}

const PERSONAS: PersonaSpec[] = [
  { key: "buerger1", email: "buerger1@demo.partizip.online" },
  { key: "buerger2", email: "buerger2@demo.partizip.online", stufe2: true },
  { key: "verifier", email: "verifier@demo.partizip.online", role: "verifier" },
  { key: "admin", email: "admin@demo.partizip.online", role: "kommune_admin" },
  { key: "termin", email: "termin@demo.partizip.online", resetToStufe1: true },
];

async function main() {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  const tenantRows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, TENANT_SLUG))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant) throw new Error(`Tenant '${TENANT_SLUG}' nicht gefunden — erst db:seed.`);
  const tenantId = tenant.id;
  console.log(`Demo-Seed für Tenant '${TENANT_SLUG}' (${tenantId})`);

  // ADR-024 contract: alle Demo-Rollen/-Umfragen sind stadtweit (Gemeinde-Knoten).
  // Scope-Eingabe → region_id (der Dual-Write-Trigger ist im contract entfernt).
  const stadtRegionId = await resolveRegionId(db, tenantId, "stadt", null);

  // ----- 1. Personas -------------------------------------------------------
  const userIdByKey = new Map<string, string>();
  for (const p of PERSONAS) {
    const id = uuidV5(SEED_NAMESPACE, `demo-user:${TENANT_SLUG}:${p.email}`);
    userIdByKey.set(p.key, id);

    const stufe2 = !!p.stufe2;
    // J2a: users.email wird kanonisch (trim+lowercase) gespeichert — dieselbe
    // Wahrheit wie an den App-Boundaries (lib/auth/email.normalizeEmail).
    const email = normalizeEmail(p.email);
    const base = {
      id,
      tenantId,
      email,
      birthYear: 1985,
      birthMonth: 6,
      accountStatus: "active" as const,
      minAgeConfirmedAt: now,
      notifyNewPolls: true,
    };
    const verifyFields = stufe2
      ? {
          verificationStatus: "verified" as const,
          verificationMethod: "in_person" as const,
          residencyVerifiedAt: now,
          residencyVerifiedUntil: addMonths(now, 24),
        }
      : {
          verificationStatus: "pending" as const,
          verificationMethod: null,
          residencyVerifiedAt: null,
          residencyVerifiedUntil: null,
        };

    // Termin-Persona: bei jedem Lauf hart auf Stufe 1 zurücksetzen (repeatable).
    const setOnConflict = p.resetToStufe1
      ? {
          verificationStatus: "pending" as const,
          verificationMethod: null,
          residencyVerifiedAt: null,
          residencyVerifiedUntil: null,
          accountStatus: "active" as const,
          minAgeConfirmedAt: now,
        }
      : {
          ...verifyFields,
          accountStatus: "active" as const,
          minAgeConfirmedAt: now,
        };

    // J2a (Gate-B): Idempotenter Upsert auf den funktionalen Unique-Index
    // (tenant_id, lower(btrim(email))). drizzle 0.44 kann in onConflict-`target`
    // KEINE Ausdrucks-Ziele abbilden (es escaped jedes Element als Spaltennamen),
    // und ein funktionaler Index verlangt exakt ON CONFLICT (tenant_id,
    // lower(btrim(email))) — `(tenant_id, email)` löste 42P10 aus. Darum
    // expliziter Select→Update/Insert (Seed, nicht perf-kritisch). Match über
    // lower(email) auf die kanonisch (bereits getrimmt) gespeicherte Adresse,
    // damit Alt-Bestand in gemischter Schreibweise weiterhin adoptiert wird.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), drSql`lower(${users.email}) = ${email}`))
      .limit(1);
    if (existing[0]) {
      await db
        .update(users)
        .set(setOnConflict)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, existing[0].id)));
    } else {
      await db.insert(users).values({ ...base, ...verifyFields });
    }

    if (p.role) {
      await db
        .insert(roles)
        .values({
          tenantId,
          userId: id,
          roleType: p.role,
          regionId: stadtRegionId,
        })
        .onConflictDoNothing();
    }
    console.log(`  user: ${p.email} (${stufe2 ? "Stufe 2" : "Stufe 1"}${p.role ? ", " + p.role : ""})`);
  }

  // ----- 2. Demo-Umfragen --------------------------------------------------
  const offenId = uuidV5(SEED_NAMESPACE, `demo-poll:${TENANT_SLUG}:offen`);
  const verbindlichId = uuidV5(SEED_NAMESPACE, `demo-poll:${TENANT_SLUG}:verbindlich`);
  const geschlossenId = uuidV5(SEED_NAMESPACE, `demo-poll:${TENANT_SLUG}:geschlossen`);
  const adminId = userIdByKey.get("admin")!;

  await db
    .insert(polls)
    .values({
      id: offenId,
      tenantId,
      regionId: stadtRegionId,
      frage: "Soll der Wochenmarkt auf dem Rathausplatz künftig auch samstags stattfinden?",
      typ: "ja_nein_enthaltung",
      status: "aktiv",
      verbindlich: false,
      erstelltVon: adminId,
      opensAt: addDays(now, -3),
    })
    .onConflictDoNothing({ target: polls.id });

  // Frage ohne „Verbindliche Abstimmung:"-Präfix — die Verbindlichkeit zeigt das
  // UI bereits als eigenes Badge in der Überschrift (PollTypBadge). onConflictDoUpdate
  // auf die Frage, damit ein Re-Seed den Text auf vorhandenen Demo-Polls aktualisiert.
  const verbindlichFrage =
    "Sollen die Mittel für das Sanierungsbudget Schwimmbad freigegeben werden?";
  await db
    .insert(polls)
    .values({
      id: verbindlichId,
      tenantId,
      regionId: stadtRegionId,
      frage: verbindlichFrage,
      typ: "ja_nein_enthaltung",
      status: "aktiv",
      verbindlich: true,
      erstelltVon: adminId,
      opensAt: addDays(now, -2),
      closesAt: addDays(now, 14),
    })
    .onConflictDoUpdate({ target: polls.id, set: { frage: verbindlichFrage } });

  await db
    .insert(polls)
    .values({
      id: geschlossenId,
      tenantId,
      regionId: stadtRegionId,
      frage: "Soll die Stadt eine dauerhafte Tempo-30-Zone in der Innenstadt einrichten?",
      typ: "ja_nein_enthaltung",
      status: "geschlossen",
      verbindlich: false,
      erstelltVon: adminId,
      opensAt: addDays(now, -30),
      closesAt: addDays(now, -1),
    })
    .onConflictDoNothing({ target: polls.id });
  console.log("  polls: offen (aktiv), verbindlich (aktiv), geschlossen");

  // ----- 3. Stimmen + Belege für die GESCHLOSSENE Frage --------------------
  // Idempotenz: feste Demo-voter_refs (UNIQUE poll,voter_ref). Belege werden EINMAL
  // erzeugt; bei erneutem Lauf vorhandene Anzahl beibehalten (kein Doppel-Insert).
  // Verteilung mit jeder Option ≥ K_ANONYMITY_SCHWELLE (9/6/5): die geschlossene
  // Frage trägt den Ergebnis-Moment der Demo (ADR-022) und soll die volle
  // Aufschlüsselung zeigen, nicht den Suppressions-Fall.
  const DEMO_CHOICES = [
    ...Array.from({ length: 9 }, () => "ja"),
    ...Array.from({ length: 6 }, () => "nein"),
    ...Array.from({ length: 5 }, () => "enthaltung"),
  ];
  const existingVotes = await db
    .select({ id: votes.id })
    .from(votes)
    .where(and(eq(votes.pollId, geschlossenId), eq(votes.tenantId, tenantId)));
  if (existingVotes.length === 0) {
    for (let i = 0; i < DEMO_CHOICES.length; i++) {
      await db.insert(votes).values({
        pollId: geschlossenId,
        tenantId,
        voterRef: `demo:geschlossen:${i}`,
        choice: DEMO_CHOICES[i],
        warVerifiziert: i % 2 === 0,
      });
      // 1 Beleg je Stimme (Invariante #Belege == #Stimmen). Echter CSPRNG-Code.
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const res = await db
          .insert(voteReceipts)
          .values({ pollId: geschlossenId, tenantId, code: generateReadableCode("BELEG") })
          .onConflictDoNothing({ target: [voteReceipts.pollId, voteReceipts.code] })
          .returning({ id: voteReceipts.id });
        inserted = res.length > 0;
      }
      if (!inserted) throw new Error("Beleg-Code konnte nicht kollisionsfrei erzeugt werden.");
    }
    console.log(`  votes+belege: ${DEMO_CHOICES.length} (geschlossene Frage)`);
  } else {
    console.log(`  votes+belege: bereits vorhanden (${existingVotes.length}) — unverändert`);
  }

  // ----- 4. Demo-Standort + Slots + offener Termin -------------------------
  // Verifizierung 2.0 / V2: Koordinaten + strukturierte Öffnungszeiten, damit die
  // Bürger-Liste „Stellen in Ihrer Nähe" im Demo etwas zeigt (Walk-in + Distanz).
  // Als Beispiel gekennzeichnet („(Demo)"); Koordinaten ungefähr Taunusstein.
  const rathausFelder = {
    address: "Aarstraße 150, 65232 Taunusstein",
    hinweise: "Bitte einen amtlichen Lichtbildausweis mitbringen.",
    isActive: true,
    lat: "50.1470",
    lon: "8.1510",
    oeffnungszeiten: [
      { tag: 1, von: "08:00", bis: "16:00" },
      { tag: 2, von: "08:00", bis: "16:00" },
      { tag: 3, von: "08:00", bis: "16:00" },
      { tag: 4, von: "08:00", bis: "18:00" },
      { tag: 5, von: "08:00", bis: "12:00" },
    ],
    terminErforderlich: false,
    barrierefrei: true,
    kontakt: "06128 000-0",
  };
  const [loc] = await db
    .insert(verificationLocations)
    .values({
      tenantId,
      name: "Bürgerbüro Rathaus (Demo)",
      ...rathausFelder,
    })
    .onConflictDoUpdate({
      target: [verificationLocations.tenantId, verificationLocations.name],
      set: { ...rathausFelder, updatedAt: now },
    })
    .returning({ id: verificationLocations.id });
  const locationId = loc.id;

  // Zweiter Beispiel-Standort (Walk-in, andere Koordinaten) — zeigt die
  // Distanz-Sortierung der Nähe-Liste. Ohne Slots (reiner Walk-in).
  const wehenFelder = {
    address: "Kirchgasse 5, 65232 Taunusstein-Wehen",
    hinweise: "Kleinere Außenstelle — an Markttagen kann es voller werden.",
    isActive: true,
    lat: "50.1680",
    lon: "8.1420",
    oeffnungszeiten: [
      { tag: 2, von: "09:00", bis: "12:00" },
      { tag: 4, von: "14:00", bis: "18:00" },
    ],
    terminErforderlich: false,
    barrierefrei: false,
    kontakt: null,
  };
  await db
    .insert(verificationLocations)
    .values({
      tenantId,
      name: "Ortsverwaltung Wehen (Demo)",
      ...wehenFelder,
    })
    .onConflictDoUpdate({
      target: [verificationLocations.tenantId, verificationLocations.name],
      set: { ...wehenFelder, updatedAt: now },
    });

  // Slot-Zeiten DETERMINISTISCH am UTC-Tag verankert (nicht an der exakten Uhrzeit),
  // damit ein erneuter Lauf am selben Tag dieselben Slots trifft (Idempotenz über
  // den (location_id, starts_at)-Unique) statt neue Slots anzulegen.
  const dayAnchor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // Heute fälliger Slot (09:00 UTC) — liegt innerhalb der letzten 24 h ⇒ erscheint
  // in der Verifier-Liste und ist wahrnehmbar (deckungsgleich mit dem Zeit-Guard).
  const faelligStart = addHours(dayAnchor, 9);
  // Buchbarer Zukunfts-Slot (in 7 Tagen, 09:00 UTC) — strikt in der Zukunft ⇒ buchbar.
  const zukunftStart = addHours(addDays(dayAnchor, 7), 9);
  for (const s of [
    { start: faelligStart, end: addHours(faelligStart, 1), cap: 5 },
    { start: zukunftStart, end: addHours(zukunftStart, 1), cap: 5 },
  ]) {
    await db
      .insert(verificationSlots)
      .values({ locationId, startsAt: s.start, endsAt: s.end, capacity: s.cap })
      .onConflictDoNothing({ target: [verificationSlots.locationId, verificationSlots.startsAt] });
  }
  const faelligSlotRows = await db
    .select({ id: verificationSlots.id })
    .from(verificationSlots)
    .where(and(eq(verificationSlots.locationId, locationId), eq(verificationSlots.startsAt, faelligStart)))
    .limit(1);
  const faelligSlotId = faelligSlotRows[0].id;

  // Offenen Termin der Termin-Persona repeatable neu anlegen: erst deren Demo-
  // Buchungen entfernen (eng auf die Persona begrenzt), dann frisch 'gebucht'.
  const terminUserId = userIdByKey.get("termin")!;
  await db
    .delete(verificationBookings)
    .where(and(eq(verificationBookings.tenantId, tenantId), eq(verificationBookings.userId, terminUserId)));
  await db
    .insert(verificationBookings)
    .values({
      tenantId,
      slotId: faelligSlotId,
      userId: terminUserId,
      code: generateReadableCode("TERMIN"),
      status: "gebucht",
    });
  // booked_count des fälligen Slots konsistent zur Anzahl offener Buchungen setzen.
  const openOnSlot = await db
    .select({ id: verificationBookings.id })
    .from(verificationBookings)
    .where(and(eq(verificationBookings.slotId, faelligSlotId), eq(verificationBookings.status, "gebucht")));
  await db
    .update(verificationSlots)
    .set({ bookedCount: openOnSlot.length })
    .where(eq(verificationSlots.id, faelligSlotId));
  console.log(`  termin: offener Termin (status 'gebucht') auf heute fälligem Slot`);

  await db.insert(auditEvents).values({
    tenantId,
    actorType: "system",
    actorRef: null,
    action: "seed.demo_completed",
    metadata: { tenant: TENANT_SLUG, personas: PERSONAS.length },
  });

  console.log("Demo-Seed abgeschlossen.");
  await sql.end();
}

main().catch((err) => {
  console.error("Demo-Seed fehlgeschlagen:", err);
  process.exit(1);
});
