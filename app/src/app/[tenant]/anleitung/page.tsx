/**
 * [tenant]/anleitung/page.tsx — die Abholseite.
 *
 * Drei Karten, die nach der SITUATION fragen, nicht nach dem Rollennamen:
 * Bürger denken nicht in Rollen („bin ich ein ‚user'?"), und `redakteur` oder
 * `beobachter` sind interne Begriffe. Wer eine Aufgabe hat, weiß das dagegen.
 *
 * PERSÖNLICHER HINWEIS BEI ANGEMELDETEN: Trägt die angemeldete Person eine
 * Rolle, steht über den Karten ein direkter Sprung in ihren Abschnitt. Die
 * Rollen werden über getUserRoleTypes geladen — denselben Weg wie /admin und
 * /aufgaben, der gesperrte/gelöschte Konten ausfiltert (innerer JOIN auf
 * account_status='active'). Der Hinweis ist reiner KOMFORT: Er schaltet nichts
 * frei, die Anleitung selbst ist ohnehin öffentlich lesbar.
 *
 * AUSGELOGGT ⇒ KEIN DB-ZUGRIFF: ohne Session-Cookie wird gar keine Verbindung
 * aufgebaut, die Seite ist dann reine Textausspielung.
 *
 * KEINE Weiterleitungen: Die Abholseite ist für jede Besucherin erreichbar —
 * anders als /aufgaben, das Nicht-Rollenträger wegleitet.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes } from "@/lib/auth/roles";
import { isDemoTenant } from "@/lib/demo/config";
import { EINSTIEG_KARTEN, abschnitteFuerRollen } from "./anleitung-daten";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Anleitung — Partizip",
  description:
    "Die Anleitung zu Partizip: fürs Mitmachen, für Rollen in der Kommune und " +
    "für die Vorstellung der Plattform.",
};

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

/**
 * Rollen der angemeldeten Person — oder [] (nicht angemeldet, Sitzung abgelaufen
 * oder widerrufen). Fehlertolerant gedacht: Diese Seite darf am Rollen-Hinweis
 * nicht scheitern, sie ist in erster Linie eine öffentliche Textseite.
 */
async function rollenDerSitzung(tenantId: string): Promise<string[]> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return [];

  const db = createDb(databaseUrl());
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha256Hex(rawToken)), eq(sessions.tenantId, tenantId)))
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < new Date()) return [];

  return getUserRoleTypes(db, tenantId, session.userId);
}

export default async function AnleitungPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slug) notFound();

  // Demo-Mandant: dort führt der eigene Rundgang, und die Rollen sind ephemer
  // (Wegwerf-Admin des Demo-Resets). Ein „Sie sind als … eingetragen" wäre dort
  // irreführend — die drei Karten genügen.
  const roleTypes = isDemoTenant(tenant.slug) ? [] : await rollenDerSitzung(tenant.id);
  const meineAbschnitte = abschnitteFuerRollen(roleTypes);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Anleitung
        </h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Wählen Sie, was auf Sie zutrifft. Jede Anleitung erklärt Bedeutung und
          Reihenfolge und verlinkt dann an die passende Stelle — sie ersetzt keinen
          Kurs und braucht kein Vorwissen.
        </p>
      </header>

      {/* Vorwegnahme für Rollenträger: direkter Sprung in den eigenen Abschnitt.
          Ohne Rolle (oder ausgeloggt) entfällt der Block ersatzlos. */}
      {meineAbschnitte.length > 0 && (
        <section
          className="pz-card mt-8 p-5"
          aria-labelledby="anleitung-ihre-rolle"
        >
          <h2
            id="anleitung-ihre-rolle"
            className="text-lg font-semibold"
            style={{ color: "var(--pz-ink)" }}
          >
            Für Sie hinterlegt
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
            Sie sind bei {tenant.name} für{" "}
            {meineAbschnitte.length === 1 ? "diese Aufgabe" : "diese Aufgaben"}{" "}
            eingetragen:
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {meineAbschnitte.map((a) => (
              <li key={a.spurId}>
                <Link
                  href={`/${slug}/anleitung/aufgaben#${a.spurId}`}
                  className="font-medium underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                  style={{ color: "var(--pz-brand-strong)" }}
                >
                  {a.titel} <span aria-hidden>→</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="mt-10 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
        Was trifft auf Sie zu?
      </h2>
      <ul className="mt-4 grid gap-4">
        {EINSTIEG_KARTEN.map((karte) => (
          <li key={karte.key}>
            <KarteInhalt karte={karte} slug={slug} />
          </li>
        ))}
      </ul>

      <p className="mt-10 text-sm leading-relaxed" style={{ color: "var(--pz-muted)" }}>
        Sie suchen nur eine schnelle Antwort? Die{" "}
        <Link
          href={`/${slug}/faq`}
          className="font-medium underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          häufigen Fragen
        </Link>{" "}
        fassen die wichtigsten Punkte in je zwei Sätzen zusammen.
      </p>
    </main>
  );
}

/**
 * Eine Einstiegs-Karte. Die ganze Karte ist EIN Link (eine Aktion je Karte,
 * UX-Leitbild); der Titel bleibt trotzdem eine echte Überschrift, damit die
 * Sprungmarken-Liste eines Screenreaders die drei Wege abbildet.
 */
function KarteInhalt({
  karte,
  slug,
}: {
  karte: (typeof EINSTIEG_KARTEN)[number];
  slug: string;
}) {
  const href = karte.link.absolut ? karte.link.href : `/${slug}${karte.link.href}`;
  const klassen =
    "pz-card pz-card-hover group flex h-full flex-col p-6 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]";
  const inhalt = (
    <>
      <h3 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
        {karte.titel}
      </h3>
      <p className="mt-2 flex-1 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
        {karte.text}
      </p>
      <p
        className="mt-4 text-sm font-medium group-hover:underline"
        style={{ color: "var(--pz-brand-strong)" }}
      >
        {karte.link.label} <span aria-hidden>→</span>
      </p>
    </>
  );

  // Das statische Präsentations-Deck liegt außerhalb des Next-Routings
  // (middleware.ts nimmt /praesentation vom Tenant-Rewrite aus) — dorthin führt
  // ein normales <a>, kein next/link.
  if (karte.link.absolut) {
    return (
      <a href={href} className={klassen}>
        {inhalt}
      </a>
    );
  }
  return (
    <Link href={href} className={klassen}>
      {inhalt}
    </Link>
  );
}
