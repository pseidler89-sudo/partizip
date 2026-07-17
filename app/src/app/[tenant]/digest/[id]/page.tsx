/**
 * [tenant]/digest/[id]/page.tsx — Öffentliche Digest-Detailseite (M7, Stufe 0)
 *
 * Zeigt Aussagen mit Fundstellen-Links.
 * NUR für status='veroeffentlicht' — andere Status → 404.
 * Teilen-Button (Permalink) — die Seite selbst ist der Kanal (ADR-021).
 *
 * Wenn Highlights vorhanden: zuerst „Das Wichtigste in Kürze" (nur Highlights),
 * dann „Alle Punkte" (vollständige Liste). Ohne Highlights: eine Liste wie bisher.
 */

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { digests, digestStatements, risDocuments } from "@/db/schema";
import { TeilenButton } from "../../TeilenButton";
import Link from "next/link";
import { decodeHtmlEntities } from "@/lib/text/html-entities";
import type { Metadata } from "next";
import { digestPermalink } from "@/lib/channels/types";

async function getPublicDigest(tenantSlug: string, digestId: string) {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== tenantSlug) return null;

  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );

  // NUR veröffentlichte Digests
  const digestRows = await db
    .select()
    .from(digests)
    .where(
      and(
        eq(digests.id, digestId),
        eq(digests.tenantId, tenant.id),
        eq(digests.status, "veroeffentlicht")
      )
    )
    .limit(1);

  if (digestRows.length === 0) return null;

  const digest = digestRows[0];

  const stmtRows = await db
    .select({
      id: digestStatements.id,
      position: digestStatements.position,
      text: digestStatements.text,
      sourceUrl: digestStatements.sourceUrl,
      docTitle: risDocuments.title,
      docType: risDocuments.docType,
      istHighlight: digestStatements.istHighlight,
    })
    .from(digestStatements)
    .leftJoin(risDocuments, eq(digestStatements.sourceDocumentId, risDocuments.id))
    .where(eq(digestStatements.digestId, digestId))
    .orderBy(digestStatements.position);

  return { tenant, digest, statements: stmtRows };
}

interface PageProps {
  params: Promise<{ tenant: string; id: string }>;
}

/**
 * OpenGraph-Metadaten (ADR-021): Ein geteilter Permalink soll überall — Mastodon,
 * Bluesky, Messenger, Mail — mit Titel, Anreißer und eigenem Vorschaubild
 * (opengraph-image.tsx, serverseitig erzeugt) erscheinen. Die eigene Seite ist
 * der Kanal; alles andere ist nur Verlinkung.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tenant: tenantSlug, id } = await params;
  const data = await getPublicDigest(tenantSlug, id);
  if (!data) return { title: "Sitzungszusammenfassung — Partizip" };

  const { digest, statements } = data;
  const beschreibung =
    statements[0]?.text?.slice(0, 200) ??
    "Verständliche Zusammenfassung einer Ratssitzung — jede Aussage mit Quellenlink.";
  const url = digestPermalink(tenantSlug, id);

  return {
    title: `${digest.title} — Partizip`,
    description: beschreibung,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      locale: "de_DE",
      url,
      siteName: "Partizip",
      title: digest.title,
      description: beschreibung,
      publishedTime: digest.publishedAt?.toISOString(),
    },
    twitter: { card: "summary_large_image", title: digest.title, description: beschreibung },
  };
}

// Aussagen-Listenelement (wiederverwendet für Highlights und Vollständige Liste)
function StatementListItem({
  stmt,
  showPosition,
}: {
  stmt: {
    id: string;
    position: number;
    text: string;
    sourceUrl: string;
    docTitle: string | null;
    docType: string | null;
    istHighlight: boolean;
  };
  showPosition: boolean;
}) {
  return (
    <li className="flex gap-3">
      {showPosition && (
        <span className="pz-badge-neutral shrink-0 flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium mt-0.5">
          {stmt.position}
        </span>
      )}
      {!showPosition && (
        <span className="pz-badge-warning shrink-0 flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium mt-0.5">
          ★
        </span>
      )}
      <div>
        <p className="leading-relaxed" style={{ color: "var(--pz-body)" }}>{stmt.text}</p>
        <a
          href={stmt.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-1 text-xs text-zinc-400 hover:text-zinc-600 underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
        >
          Quelle: {stmt.docType ?? "Dokument"}{stmt.docTitle ? ` – ${decodeHtmlEntities(stmt.docTitle)}` : ""}
        </a>
      </div>
    </li>
  );
}

export default async function DigestDetailPage({ params }: PageProps) {
  const { tenant: slugFromPath, id: digestId } = await params;
  const data = await getPublicDigest(slugFromPath, digestId);

  if (!data) notFound();

  const { digest, statements } = data;

  type StmtRow = typeof statements[number];
  const highlights = statements.filter((s: StmtRow) => s.istHighlight);
  const hatHighlights = highlights.length > 0;

  return (
    <main className="min-h-screen px-4 py-8 max-w-2xl mx-auto">
      <div className="mb-2">
        <Link href={`/${slugFromPath}/digest`} className="text-sm hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]" style={{ color: "var(--pz-muted)" }}>
          ← Alle Zusammenfassungen
        </Link>
      </div>

      <h1 className="text-2xl font-semibold mt-4 mb-2" style={{ color: "var(--pz-ink)" }}>
        {digest.title}
      </h1>

      {digest.publishedAt && (
        <p className="text-sm mb-6" style={{ color: "var(--pz-muted)" }}>
          Veröffentlicht: {digest.publishedAt.toLocaleDateString("de-DE")}
        </p>
      )}

      {statements.length === 0 ? (
        <p style={{ color: "var(--pz-muted)" }}>Keine Aussagen verfügbar.</p>
      ) : hatHighlights ? (
        <>
          {/* Highlights-Abschnitt: „Das Wichtigste in Kürze" */}
          <section className="mb-8">
            <h2 className="text-base font-semibold mb-3 flex items-center gap-2" style={{ color: "var(--pz-ink)" }}>
              <span className="text-amber-500" aria-hidden>★</span> Das Wichtigste in Kürze
            </h2>
            <ol className="space-y-4">
              {highlights.map((stmt: StmtRow) => (
                <StatementListItem key={stmt.id} stmt={stmt} showPosition={false} />
              ))}
            </ol>
          </section>

          {/* Vollständige Liste */}
          <section className="mb-8">
            <h2 className="text-base font-semibold mb-3" style={{ color: "var(--pz-ink)" }}>Alle Punkte</h2>
            <ol className="space-y-4">
              {statements.map((stmt: StmtRow) => (
                <StatementListItem key={stmt.id} stmt={stmt} showPosition={true} />
              ))}
            </ol>
          </section>
        </>
      ) : (
        /* Kein Highlight: unveränderte einzige Liste */
        <ol className="space-y-4 mb-8">
          {statements.map((stmt: StmtRow) => (
            <StatementListItem key={stmt.id} stmt={stmt} showPosition={true} />
          ))}
        </ol>
      )}

      {/* Teilen (ADR-021): generischer Link-Teiler statt WhatsApp-Copy — diese
          Seite IST der Kanal; geteilt wird der Permalink, nicht der Volltext. */}
      {statements.length > 0 && (
        <div className="mb-6">
          <TeilenButton
            title={digest.title}
            path={`/${slugFromPath}/digest/${digestId}`}
          />
        </div>
      )}

      {/* Hinweis Neutralitätskodex */}
      <div className="pz-card p-4 text-xs" style={{ color: "var(--pz-muted)" }}>
        <strong className="font-medium" style={{ color: "var(--pz-body)" }}>Hinweis:</strong>{" "}
        Alle Angaben basieren auf den verlinkten amtlichen Quellen.
        Korrekturen oder Hinweise bitte an die Gemeinde richten.
      </div>
    </main>
  );
}
