/**
 * [tenant]/anliegen/neu/page.tsx — Anliegen erfassen (Stufe 1)
 *
 * Formular: Titel (Pflicht ≤ 200), Beschreibung (optional ≤ 5000),
 * Ortsteil-Auswahl (optional).
 *
 * Redirect zur Erfolgsseite mit Tracking-Code nach Einreichung.
 * Stufe-0-User: Redirect zur Login-Seite.
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions, users, ortsteile } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getStufe } from "@/lib/eligibility/stufe";
import { FEATURE_ANLIEGEN_EINREICHEN } from "@/lib/features";
import Link from "next/link";
import AnliegenNeuForm from "./AnliegenNeuForm";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

export default async function AnliegenNeuPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== slugFromPath) notFound();

  // Feature-Flag (ADR-014): Einreichen vorerst deaktiviert → freundliche
  // "kommt bald"-Seite statt Formular (kein Redirect-Loop). Code bleibt erhalten.
  if (!FEATURE_ANLIEGEN_EINREICHEN) {
    return (
      <main className="min-h-screen px-4 py-16 max-w-lg mx-auto text-center">
        <div className="text-4xl" aria-hidden>🛠️</div>
        <h1 className="mt-4 text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Diese Funktion kommt bald
        </h1>
        <p className="mt-3 text-sm" style={{ color: "var(--pz-body)" }}>
          Das Einreichen von Anliegen wird gerade vorbereitet und ist in Kürze
          verfügbar. Bis dahin können Sie sich bei lokalen Abstimmungen beteiligen
          und die Ratsinfos verfolgen.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={`/${slugFromPath}/umfragen`}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--tenant-primary)" }}
          >
            Zu den Abstimmungen
          </Link>
          <Link
            href={`/${slugFromPath}/digest`}
            className="pz-btn pz-btn-secondary"
            style={{ color: "var(--pz-ink)" }}
          >
            Ratsinfos lesen
          </Link>
        </div>
      </main>
    );
  }

  // Session prüfen
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!rawToken) {
    redirect("/");
  }

  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();

  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
    .limit(1);

  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) {
    redirect("/");
  }

  const userRows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
    .limit(1);

  const user = userRows[0];
  if (!user) {
    redirect("/");
  }

  const stufe = getStufe(user);
  if (stufe < 1) {
    redirect("/");
  }

  // Ortsteile für diesen Tenant laden
  const ortsteilRows = await db
    .select({ id: ortsteile.id, name: ortsteile.name, code: ortsteile.code })
    .from(ortsteile)
    .where(eq(ortsteile.tenantId, tenant.id))
    .orderBy(ortsteile.name);

  return (
    <main className="min-h-screen px-4 py-10 max-w-lg mx-auto">
      <Link
        href={`/${slugFromPath}/anliegen`}
        className="text-sm hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
        style={{ color: "var(--pz-muted)" }}
      >
        ← Alle Anliegen
      </Link>
      <div className="mt-2 mb-8">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Anliegen einreichen</h1>
        <p className="text-sm mt-2" style={{ color: "var(--pz-body)" }}>
          Beschreiben Sie Ihr Anliegen in eigenen Worten. Danach erhalten Sie einen
          persönlichen Tracking-Code (zusätzlich per E-Mail), mit dem Sie den
          Bearbeitungsstand verfolgen können. Ihr Anliegen wird <strong>pseudonym</strong>{" "}
          gespeichert — Ihr Name erscheint nirgends.
        </p>
      </div>

      <AnliegenNeuForm ortsteile={ortsteilRows} />
    </main>
  );
}
