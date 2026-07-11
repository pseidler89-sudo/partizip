/**
 * [tenant]/anmelden/page.tsx — eigenständige Anmelde-Seite.
 *
 * Robuste Alternative zum bisherigen `#anmelden`-Anker: ein Nav-Link auf einen
 * Seiten-Anker scrollt im App-Router nicht zuverlässig (v. a. seitengleich oder
 * nach Navigation) → der „Anmelden"-Button wirkte tot. Diese Seite ist von
 * überall erreichbar und zeigt das Login-Formular direkt.
 *
 * Bereits eingeloggt → weiter zum Konto (kein erneutes Anmelden nötig).
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions, users } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { LoginForm } from "../LoginForm";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function AnmeldenPage({ params }: PageProps) {
  const { tenant: slug } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== slug) notFound();

  const db = createDb(databaseUrl());

  // Bereits eingeloggt? → zum Konto weiterleiten.
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    const tokenHash = sha256Hex(rawToken);
    const now = new Date();
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
      .limit(1);
    const session = sessionRows[0];
    if (session && !session.revokedAt && session.expiresAt >= now) {
      const userRows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
        .limit(1);
      if (userRows[0]) redirect(`/${slug}/konto`);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-14">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Anmelden
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Per E-Mail-Link, ohne Passwort, ab 16 Jahren. Mit Konto stimmen Sie bei
          Abstimmungen mit; Frage und Ergebnis sehen Sie auch ohne Anmeldung.
        </p>
      </div>
      <div className="pz-card p-8">
        <LoginForm tenantSlug={slug} />
      </div>
    </main>
  );
}
