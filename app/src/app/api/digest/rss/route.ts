/**
 * /api/digest/rss — RSS 2.0 Feed der veröffentlichten Digests (M7)
 *
 * Host-Tenant-basiert (wie alle API-Routen).
 * NUR status='veroeffentlicht' erscheint im Feed.
 * force-dynamic: kein statisches Caching.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { digests, digestStatements } from "@/db/schema";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const host = request.headers.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant) {
    return new NextResponse("Tenant nicht gefunden", { status: 404 });
  }

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
    .where(
      and(
        eq(digests.tenantId, tenant.id),
        eq(digests.status, "veroeffentlicht")
      )
    )
    .orderBy(desc(digests.publishedAt))
    .limit(20);

  const baseUrl = host.includes("localhost")
    ? `http://${host}`
    : `https://${host}`;

  // Für jeden Digest die ersten paar Aussagen laden (Beschreibung)
  const items: string[] = [];

  for (const digest of digestRows) {
    const stmts = await db
      .select({ text: digestStatements.text })
      .from(digestStatements)
      .where(eq(digestStatements.digestId, digest.id))
      .orderBy(digestStatements.position)
      .limit(3);

    const description = stmts.map((s: { text: string }) => s.text).join(" • ") || digest.title;
    const link = `${baseUrl}/${tenant.slug}/digest/${digest.id}`;
    const pubDate = digest.publishedAt
      ? digest.publishedAt.toUTCString()
      : new Date().toUTCString();

    items.push(`    <item>
      <title>${escapeXml(digest.title)}</title>
      <link>${escapeXml(link)}</link>
      <description>${escapeXml(description)}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
    </item>`);
  }

  const feedLink = `${baseUrl}/${tenant.slug}/digest`;
  const feedTitle = `${escapeXml(tenant.name)} – Sitzungszusammenfassungen`;
  const lastBuild = digestRows[0]?.publishedAt?.toUTCString() ?? new Date().toUTCString();

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${feedTitle}</title>
    <link>${escapeXml(feedLink)}</link>
    <description>Zusammenfassungen der Ratssitzungen von ${escapeXml(tenant.name)} mit Quellenangaben.</description>
    <language>de</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${escapeXml(`${baseUrl}/api/digest/rss`)}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`;

  return new NextResponse(rss, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
