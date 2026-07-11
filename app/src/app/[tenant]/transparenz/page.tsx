/**
 * [tenant]/transparenz/page.tsx — Öffentliches Freigabe-/Korrektur-Log (H1).
 *
 * Transparenz-Versprechen: Jede veröffentlichte Zusammenfassung wurde von einem
 * Menschen geprüft und freigegeben. Diese Seite macht das nachvollziehbar —
 * inkl. späterer Korrekturen (erneute Freigaben). Es wird KEINE Person genannt
 * (Institutionsebene), nur Zeitpunkt und Anzahl der Freigaben.
 */

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, eq, count, max, desc } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { digests, auditEvents } from "@/db/schema";
import { decodeHtmlEntities } from "@/lib/text/html-entities";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

export default async function TransparenzPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );

  // Veröffentlichte Digests dieses Tenants
  const veroeffentlicht = await db
    .select({
      id: digests.id,
      title: digests.title,
      approvedAt: digests.approvedAt,
      publishedAt: digests.publishedAt,
    })
    .from(digests)
    .where(and(eq(digests.tenantId, tenant.id), eq(digests.status, "veroeffentlicht")))
    .orderBy(desc(digests.publishedAt));

  // Anzahl + letzte Freigabe je Digest aus dem PII-freien Audit (action='digest.approved').
  // >1 Freigabe ⇒ nach Erst-Freigabe korrigiert und erneut freigegeben.
  const freigaben = await db
    .select({
      targetId: auditEvents.targetId,
      anzahl: count(),
      letzte: max(auditEvents.createdAt),
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.action, "digest.approved")))
    .groupBy(auditEvents.targetId);

  const freigabeMap = new Map<string | null, { anzahl: number; letzte: Date | null }>(
    freigaben.map(
      (f: { targetId: string | null; anzahl: number; letzte: Date | null }) =>
        [f.targetId, { anzahl: f.anzahl, letzte: f.letzte }] as const,
    ),
  );

  const fmt = (d: Date | null) =>
    d ? new Date(d).toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" }) : "—";

  return (
    <main className="min-h-screen px-6 py-10 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Transparenz: Freigaben &amp; Korrekturen</h1>
      <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
        Jede veröffentlichte Zusammenfassung wird vor der Veröffentlichung von einem Menschen
        gegen die amtlichen Quelldokumente geprüft und freigegeben. Diese Seite weist jede Freigabe
        nach. Wird eine Zusammenfassung nachträglich korrigiert, ist sie erneut freizugeben — auch
        das ist hier sichtbar.
      </p>
      <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        Hinweis: Im Pilotbetrieb erfolgt die Freigabe durch eine Person. Sobald eine
        Redakteur:innen-Rolle besetzt ist, kann das Vier-Augen-Prinzip (Freigeber ≠ Prüfer)
        aktiviert werden.
      </p>

      <section className="mt-8">
        {veroeffentlicht.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-8 text-center text-sm text-zinc-500">
            Es wurden noch keine Zusammenfassungen veröffentlicht. Sobald die erste
            Freigabe erfolgt, wird sie hier nachvollziehbar dokumentiert.
          </div>
        ) : (
          <ul className="space-y-3">
            {veroeffentlicht.map((d: { id: string; title: string; approvedAt: Date | null; publishedAt: Date | null }) => {
              const info = freigabeMap.get(d.id);
              const anzahlFreigaben = info?.anzahl ?? (d.approvedAt ? 1 : 0);
              const korrigiert = anzahlFreigaben > 1;
              return (
                <li key={d.id} className="pz-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={`/${slugFromPath}/digest/${d.id}`}
                      className="text-sm font-medium hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                      style={{ color: "var(--pz-brand-strong)" }}
                    >
                      {decodeHtmlEntities(d.title)}
                    </Link>
                    <span className="shrink-0 inline-flex items-center rounded-full pz-badge-success px-2.5 py-0.5 text-xs font-medium">
                      <span aria-hidden>✓</span> menschlich freigegeben
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                    Veröffentlicht am {fmt(d.publishedAt)} · Freigegeben am {fmt(d.approvedAt)}
                    {korrigiert && (
                      <span className="ml-1 text-amber-700">
                        · {anzahlFreigaben}× freigegeben (zuletzt korrigiert am {fmt(info?.letzte ?? null)})
                      </span>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
