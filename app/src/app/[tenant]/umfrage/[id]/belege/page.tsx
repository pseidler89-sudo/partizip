/**
 * [tenant]/umfrage/[id]/belege/page.tsx — Öffentliche Beleg-Liste (D4, ADR-016).
 *
 * Nach Ende einer Abstimmung veröffentlichen wir die anonyme Liste aller Beleg-
 * Codes. Bürger:innen prüfen damit selbst, dass ihre Stimme im Ergebnis enthalten
 * ist — die Liste verrät NICHT, wer wie abgestimmt hat (die vote_receipts-Tabelle
 * kennt weder Person noch Wahl). Erreichbar ohne Konto (Stufe 0).
 *
 * getBelegListe liefert null, solange die Umfrage NICHT geschlossen ist → vor
 * Poll-Ende kein Beleg-Leak (notFound).
 */

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { polls } from "@/db/schema";
import { getBelegListe } from "@/lib/polls/beleg";
import BelegListe from "./BelegListe";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string; id: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function BelegeSeite({ params }: PageProps) {
  const { tenant: slugFromPath, id } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const db = createDb(databaseUrl());

  // Frage tenant-scoped laden (für die Überschrift). Entwürfe sind nicht öffentlich.
  const pollRows = await db
    .select({ id: polls.id, frage: polls.frage, status: polls.status })
    .from(polls)
    .where(and(eq(polls.id, id), eq(polls.tenantId, tenant.id)))
    .limit(1);
  const poll = pollRows[0];
  if (!poll || poll.status === "entwurf") notFound();

  // null ⇒ Umfrage noch nicht geschlossen → Belege noch nicht öffentlich.
  const codes = await getBelegListe(db, tenant.id, poll.id);
  if (codes === null) notFound();

  return (
    <main className="mx-auto min-h-screen max-w-lg px-4 py-10">
      <Link
        href={`/${slugFromPath}/umfrage/${poll.id}`}
        className="rounded-sm text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
        style={{ color: "var(--pz-muted)" }}
      >
        ← Zur Abstimmung
      </Link>

      <h1 className="mt-3 text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Belege prüfen
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
        {poll.frage}
      </p>

      <div className="pz-card mt-6 p-6">
        <p className="text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Diese Liste enthält <strong>{codes.length}</strong>{" "}
          {codes.length === 1 ? "Beleg" : "Belege"} — einen je abgegebener Stimme.
          Suchen Sie Ihren Code, den Sie direkt nach dem Abstimmen erhalten haben.
          Finden Sie ihn, ist Ihre Stimme nachweislich im Ergebnis enthalten. Die
          Liste verrät nicht, wer wie abgestimmt hat.
        </p>

        <div className="mt-5">
          {codes.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
              Für diese Abstimmung liegen keine Belege zum Prüfen vor.
            </p>
          ) : (
            <BelegListe codes={codes} />
          )}
        </div>
      </div>
    </main>
  );
}
