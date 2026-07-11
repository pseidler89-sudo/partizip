/**
 * [tenant]/digest/page.tsx — Öffentliche Digest-Liste (M7, Stufe 0)
 *
 * Zeigt NUR veröffentlichte Digests (status='veroeffentlicht').
 * Kein Login erforderlich.
 * Mobile-first, Tenant-Branding via CSS-Variablen.
 */

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { eq, and, desc, sql } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { digests, risMeetings } from "@/db/schema";
import Link from "next/link";

async function getPublicDigests(tenantSlug: string) {
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== tenantSlug) return null;

  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );

  const digestRows = await db
    .select({
      id: digests.id,
      title: digests.title,
      publishedAt: digests.publishedAt,
    })
    .from(digests)
    .innerJoin(risMeetings, eq(digests.meetingId, risMeetings.id))
    .where(
      and(
        eq(digests.tenantId, tenant.id),
        eq(digests.status, "veroeffentlicht")
      )
    )
    // Neueste Sitzung oben: primär nach Sitzungsdatum (NULLS LAST), dann nach
    // Veröffentlichung als Tiebreaker.
    .orderBy(sql`${risMeetings.meetingDate} desc nulls last`, desc(digests.publishedAt));

  return { tenant, digests: digestRows };
}

interface PageProps {
  params: Promise<{ tenant: string }>;
}

export default async function DigestListPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const data = await getPublicDigests(slugFromPath);

  if (!data) notFound();

  const { tenant, digests: digestList } = data;

  return (
    <main className="min-h-screen px-4 py-8 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900">
          {tenant.name} in 90 Sekunden
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Zusammenfassungen der Ratssitzungen — mit Quellenangaben.
        </p>
      </div>

      {digestList.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-8 text-center">
          <div className="text-3xl" aria-hidden>📋</div>
          <p className="mt-3 font-medium text-zinc-700">Noch keine Zusammenfassungen veröffentlicht</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
            Sobald die nächste Sitzung aufbereitet, von der Redaktion gegen die
            Originalprotokolle geprüft und freigegeben ist, erscheint sie hier — mit
            Quellenangaben zu jeder Aussage.
          </p>
          <Link
            href={`/${slugFromPath}/umfragen`}
            className="mt-4 inline-block text-sm font-medium hover:underline"
            style={{ color: "var(--pz-brand-strong)" }}
          >
            In der Zwischenzeit bei einer Abstimmung mitmachen →
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {digestList.map((d: typeof digestList[number]) => (
            <li key={d.id}>
              <Link
                href={`/${slugFromPath}/digest/${d.id}`}
                className="pz-card pz-card-hover block px-5 py-4"
              >
                <p className="font-medium" style={{ color: "var(--pz-ink)" }}>{d.title}</p>
                {d.publishedAt && (
                  <p className="text-sm text-zinc-500 mt-0.5">
                    Veröffentlicht: {d.publishedAt.toLocaleDateString("de-DE")}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-xs text-zinc-400 text-center">
        RSS-Feed:{" "}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/digest/rss" rel="noopener" className="underline">
          /api/digest/rss
        </a>
      </p>
    </main>
  );
}
