/**
 * seed-musterstadt.ts — Demo-Mandant „Musterstadt" für die Akquise-Spielwiese.
 *
 * Legt den kompletten, offensichtlich FIKTIVEN Demo-Mandanten an — IDEMPOTENT
 * (deterministische uuid5-IDs + Unique-Keys; zweimal laufen = gleicher Zustand):
 *
 *   - Tenant `DEMO_TENANT_SLUG` (Default "demo") „Musterstadt (Demo)" + 2 Ortsteile.
 *   - 3 Beispiel-Fragen: offenes Stimmungsbild (hier stimmen Demo-Besucher ab),
 *     verbindliche Abstimmung (zeigt das Stufe-2-Gate — Demo-Konten sind nie
 *     Stufe 2, das Gate ist Teil der Demo), geschlossene Frage mit 7 Seed-Stimmen
 *     + Belegen (öffentliche Beleg-Liste = der Prüf-Moment des Rundgangs).
 *   - 1 veröffentlichter Beispiel-Digest (Kette ris_body → meeting → documents →
 *     digest → statements). Alle Texte sind sichtbar als Beispiel gekennzeichnet;
 *     Quell-Links zeigen auf die fiktiven Beispiel-Dokumente des Demo-Mandanten
 *     (keine erfundenen externen Quellen). Importer-Schutz: der unbekannte
 *     risType "demo" lässt ris:import hart abbrechen (isActive wird vom
 *     Importer NICHT geprüft — Gate-B MINOR-4; isActive=false bleibt nur als
 *     ehrliche Zustandsbeschreibung gesetzt).
 *
 * EHRLICHKEITS-REGEL: Musterstadt ist bewusst fiktiv — KEIN echter Kommunalname
 * (kein Overclaiming, keine Stadt wird ungefragt als Referenz vereinnahmt).
 *
 * Verwendung: DEMO_TENANT_SLUG=demo npm run db:seed:musterstadt
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import {
  tenants,
  ortsteile,
  polls,
  votes,
  voteReceipts,
  risBodies,
  risMeetings,
  risDocuments,
  digests,
  digestStatements,
  auditEvents,
} from "../src/db/schema.js";
import { generateReadableCode } from "../src/lib/readable-code.js";
import { SEED_NAMESPACE, uuidV5 } from "./seed-utils.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://partizip:partizip@127.0.0.1:5433/partizip";
const SLUG = process.env.DEMO_TENANT_SLUG?.trim().toLowerCase() || "demo";

const now = new Date();
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

function id(key: string): string {
  return uuidV5(SEED_NAMESPACE, `musterstadt:${SLUG}:${key}`);
}

async function main() {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  // ----- 1. Tenant + Ortsteile ---------------------------------------------
  // Insert + Verify statt blindem Upsert (Gate-B MAJOR-1): Existiert unter dem
  // Slug bereits ein Tenant, der NICHT „Musterstadt (Demo)" heißt, wäre das ein
  // ECHTER Mandant — ein Upsert würde ihn umbenennen und ihm Demo-Inhalte
  // einpflanzen. Dann: harter Abbruch, nichts geschrieben.
  const DEMO_TENANT_NAME = "Musterstadt (Demo)"; // == scripts/demo-reset.ts (Demo-Marker)
  const vorhandenerTenant = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, SLUG))
    .limit(1);
  if (vorhandenerTenant[0] && vorhandenerTenant[0].name !== DEMO_TENANT_NAME) {
    throw new Error(
      `ABBRUCH: Unter Slug '${SLUG}' existiert bereits der Tenant '${vorhandenerTenant[0].name}' — ` +
        `das ist NICHT der Demo-Mandant. Nichts geschrieben.`,
    );
  }
  let tenantId: string;
  if (vorhandenerTenant[0]) {
    tenantId = vorhandenerTenant[0].id;
  } else {
    const [tenant] = await db
      .insert(tenants)
      .values({
        slug: SLUG,
        name: DEMO_TENANT_NAME,
        welcomeText:
          "Willkommen auf der Partizip-Spielwiese: Musterstadt ist fiktiv — probieren Sie alles gefahrlos aus.",
      })
      .returning({ id: tenants.id });
    tenantId = tenant.id;
  }
  console.log(`tenant: ${SLUG} → ${tenantId}`);

  for (const o of [
    { code: "mitte", name: "Stadtmitte" },
    { code: "sued", name: "Musterstadt-Süd" },
  ]) {
    await db
      .insert(ortsteile)
      .values({ tenantId, code: o.code, name: o.name })
      .onConflictDoUpdate({
        target: [ortsteile.tenantId, ortsteile.code],
        set: { name: o.name, updatedAt: new Date() },
      });
  }

  // ----- 2. Beispiel-Fragen --------------------------------------------------
  const offenId = id("poll:offen");
  const verbindlichId = id("poll:verbindlich");
  const geschlossenId = id("poll:geschlossen");

  // createdAt EXPLIZIT: die Startseite featured die neueste aktive Frage
  // (desc createdAt) — das direkt tappbare STIMMUNGSBILD muss die neueste sein,
  // sonst landet der Demo-Besucher als Hero auf der verbindlichen Frage, bei
  // der er (bewusst, Stufe-2-Gate) nicht abstimmen kann. onConflictDoUpdate
  // repariert die Reihenfolge auch auf bestehenden Demo-Beständen.
  const POLLS = [
    {
      id: offenId,
      frage: "Soll der Wochenmarkt auf dem Rathausplatz künftig auch samstags stattfinden?",
      status: "aktiv" as const,
      verbindlich: false,
      opensAt: addDays(now, -3),
      closesAt: null as Date | null,
      createdAt: addDays(now, -1), // neueste → featured auf der Startseite
    },
    {
      id: verbindlichId,
      frage: "Sollen die Mittel für die Sanierung des Freibads freigegeben werden?",
      status: "aktiv" as const,
      verbindlich: true,
      opensAt: addDays(now, -2),
      closesAt: addDays(now, 30),
      createdAt: addDays(now, -2),
    },
    {
      id: geschlossenId,
      frage: "Soll Musterstadt eine Tempo-30-Zone in der Innenstadt einrichten?",
      status: "geschlossen" as const,
      verbindlich: false,
      opensAt: addDays(now, -30),
      closesAt: addDays(now, -1),
      createdAt: addDays(now, -30),
    },
  ];
  for (const p of POLLS) {
    await db
      .insert(polls)
      .values({
        id: p.id,
        tenantId,
        scopeLevel: "stadt",
        scopeCode: null,
        frage: p.frage,
        typ: "ja_nein_enthaltung",
        status: p.status,
        verbindlich: p.verbindlich,
        opensAt: p.opensAt,
        closesAt: p.closesAt,
        createdAt: p.createdAt,
      })
      .onConflictDoUpdate({
        target: polls.id,
        set: { frage: p.frage, createdAt: p.createdAt },
      });
  }
  console.log("polls: offen (aktiv) · verbindlich (aktiv) · geschlossen");

  // ----- 3. Seed-Stimmen + Belege der GESCHLOSSENEN Frage --------------------
  // Feste Demo-voter_refs (UNIQUE poll,voter_ref) → idempotent; der nächtliche
  // Reset lässt diese Frage unangetastet (nur aktive Fragen werden geleert).
  // Verteilung BEWUSST mit jeder Option ≥ K_ANONYMITY_SCHWELLE (9/6/5): die
  // geschlossene Frage ist der Ergebnis-Moment des Demo-Rundgangs (ADR-022 —
  // laufende Fragen zeigen keine Aufschlüsselung mehr) und soll die volle
  // Balken-Aufschlüsselung zeigen, nicht den Suppressions-Fall.
  const CHOICES = [
    ...Array.from({ length: 9 }, () => "ja"),
    ...Array.from({ length: 6 }, () => "nein"),
    ...Array.from({ length: 5 }, () => "enthaltung"),
  ];
  const existing = await db
    .select({ id: votes.id })
    .from(votes)
    .where(and(eq(votes.pollId, geschlossenId), eq(votes.tenantId, tenantId)));
  if (existing.length === 0) {
    for (let i = 0; i < CHOICES.length; i++) {
      await db.insert(votes).values({
        pollId: geschlossenId,
        tenantId,
        voterRef: `demo:musterstadt:geschlossen:${i}`,
        choice: CHOICES[i],
        warVerifiziert: i % 2 === 0,
        ipHash: null,
      });
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
    console.log(`votes+belege: ${CHOICES.length} (geschlossene Frage)`);
  } else {
    console.log(`votes+belege: bereits vorhanden (${existing.length}) — unverändert`);
  }

  // ----- 4. Beispiel-Digest (veröffentlicht) ---------------------------------
  // Importer-Schutz: risType "demo" lässt ris:import hart abbrechen (siehe
  // Kopfkommentar); isActive=false ist nur ehrliche Zustandsbeschreibung.
  const bodyId = id("ris:body");
  await db
    .insert(risBodies)
    .values({
      id: bodyId,
      tenantId,
      key: "musterstadt-demo",
      name: "Stadtverordnetenversammlung Musterstadt (Beispiel)",
      risType: "demo",
      baseUrl: `/${SLUG}/digest`,
      isActive: false,
    })
    .onConflictDoNothing({ target: risBodies.id });

  const meetingId = id("ris:meeting");
  await db
    .insert(risMeetings)
    .values({
      id: meetingId,
      bodyId,
      externalId: "musterstadt-demo-sitzung-1",
      gremium: "Stadtverordnetenversammlung",
      title: "Beispielsitzung der Stadtverordnetenversammlung Musterstadt",
      meetingDate: addDays(now, -14),
      sourceUrl: `/${SLUG}/digest`,
      fetchedAt: now,
    })
    .onConflictDoNothing({ target: risMeetings.id });

  // Fiktive Beispiel-Dokumente — Quell-Links bleiben innerhalb des Demo-Mandanten.
  const DOCS = [
    {
      key: "ris:doc:buecherei",
      docType: "vorlage",
      title: "Beispiel-Vorlage: Erweiterte Öffnungszeiten der Stadtbücherei",
      bodyText:
        "Beispiel-Dokument der Demo: Die Verwaltung schlägt vor, die Stadtbücherei donnerstags bis 20 Uhr zu öffnen.",
    },
    {
      key: "ris:doc:radweg",
      docType: "beschluss",
      title: "Beispiel-Beschluss: Lückenschluss des Radwegs an der Hauptstraße",
      bodyText:
        "Beispiel-Dokument der Demo: Die Stadtverordnetenversammlung beschließt die Planung des Radweg-Lückenschlusses.",
    },
  ];
  const docIds: string[] = [];
  for (const d of DOCS) {
    const docId = id(d.key);
    docIds.push(docId);
    await db
      .insert(risDocuments)
      .values({
        id: docId,
        meetingId,
        docType: d.docType,
        externalId: d.key,
        title: d.title,
        bodyText: d.bodyText,
        sourceUrl: `/${SLUG}/digest`,
        fetchedAt: now,
      })
      .onConflictDoNothing({ target: risDocuments.id });
  }

  // Digest: veröffentlicht (CHECK-Constraints verlangen approvedAt + publishedAt).
  // generator "demo_seed" macht die Herkunft im Datensatz selbst transparent.
  const digestId = id("digest");
  await db
    .insert(digests)
    .values({
      id: digestId,
      tenantId,
      meetingId,
      title: "Musterstadt in 90 Sekunden — Beispielsitzung (Demo)",
      status: "veroeffentlicht",
      generator: "demo_seed",
      approvedAt: now,
      publishedAt: now,
    })
    .onConflictDoNothing({ target: digests.id });

  const STATEMENTS = [
    {
      pos: 1,
      text: "Beispiel: Die Stadtbücherei soll donnerstags künftig bis 20 Uhr öffnen — die Verwaltung hat eine entsprechende Vorlage eingebracht.",
      doc: 0,
      highlight: true,
    },
    {
      pos: 2,
      text: "Beispiel: Der Lückenschluss des Radwegs an der Hauptstraße wurde beschlossen; die Planung beginnt im kommenden Quartal.",
      doc: 1,
      highlight: false,
    },
    {
      pos: 3,
      text: "Beispiel: Zur Zukunft des Wochenmarkts läuft ein Stimmungsbild — Bürger:innen können direkt hier auf der Plattform mitstimmen.",
      doc: 0,
      highlight: false,
    },
  ];
  for (const s of STATEMENTS) {
    await db
      .insert(digestStatements)
      .values({
        id: id(`digest:stmt:${s.pos}`),
        digestId,
        position: s.pos,
        text: s.text,
        sourceDocumentId: docIds[s.doc],
        sourceUrl: `/${SLUG}/digest`,
        geprueftAt: now,
        istHighlight: s.highlight,
      })
      .onConflictDoNothing({ target: digestStatements.id });
  }
  console.log("digest: veröffentlichter Beispiel-Digest mit 3 Aussagen");

  await db.insert(auditEvents).values({
    tenantId,
    actorType: "system",
    actorRef: null,
    action: "seed.musterstadt_completed",
    metadata: { tenant: SLUG },
  });

  console.log("Musterstadt-Seed abgeschlossen.");
  await sql.end();
}

main().catch((err) => {
  console.error("Musterstadt-Seed fehlgeschlagen:", err);
  process.exit(1);
});
