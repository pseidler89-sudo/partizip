/**
 * [tenant]/aufgaben/page.tsx — Aufgaben-Ansicht v1 (Rollenträger-Einstieg).
 *
 * Prominenter Einstieg für ECHTE Rollenträger nach Login (Perspektive
 * „Aufgaben"). Rendert große Aktions-Kacheln je Fähigkeit.
 *
 * GUARD: irgendeine Aufgaben-Fähigkeit (hatAufgaben = canVerify || canRedaktion
 * || isAdmin || canBeobachten). Nicht eingeloggt → /anmelden; eingeloggt, aber
 * Nicht-Rollenträger → /umfragen (Bürger-Sicht). Rollen werden über den
 * account_status-filternden Weg (getUserRoleTypes) geladen — ein gesperrtes
 * Konto erhält [] und wird weg-redirectet.
 *
 * DISCOVERABILITY = SERVER-ENFORCEMENT: angezeigt wird ausschließlich, was der
 * Nutzer serverseitig auch darf (aufgabenKacheln spiegelt exakt die Guards der
 * Zielseiten; diese behalten ihre eigenen Guards — hier wird NICHTS gelockert).
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes } from "@/lib/auth/roles";
import { aufgabenKacheln, hatAufgaben } from "@/lib/aufgaben/kacheln";
import { isDemoTenant } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function AufgabenPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();
  // Demo-Mandant hat seinen eigenen Perspektiv-Track (DemoGuide) — die echte
  // Aufgaben-Ansicht bleibt dort aus (konsistent zum Umschalter, der auf Demo
  // nicht gerendert wird). Der ephemere Demo-Admin nutzt den Demo-Rundgang.
  if (isDemoTenant(tenant.slug)) redirect(`/${slugFromPath}`);

  const db = createDb(databaseUrl());
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  // Nicht eingeloggt → Anmelden (kein „nicht eingeloggt"-Irrtum wie beim
  // früheren Admin-Redirect: hier ist es korrekt, weil ohne Session nichts geht).
  if (!rawToken) redirect(`/${slugFromPath}/anmelden`);

  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha256Hex(rawToken)), eq(sessions.tenantId, tenant.id)))
    .limit(1);
  const session = sessionRows[0];
  if (!session || session.revokedAt || session.expiresAt < now) {
    redirect(`/${slugFromPath}/anmelden`);
  }

  const roleTypes = await getUserRoleTypes(db, tenant.id, session.userId);
  // Eingeloggt, aber kein Rollenträger → zurück in die Bürger-Sicht (NICHT
  // /anmelden — sie sind eingeloggt, nur ohne Aufgabe).
  if (!hatAufgaben(roleTypes)) redirect(`/${slugFromPath}/umfragen`);

  const kacheln = aufgabenKacheln(roleTypes);

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Ihre Aufgaben
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
          {tenant.name} — wählen Sie eine Funktion. Über &bdquo;Ansicht&ldquo; oben
          wechseln Sie jederzeit zurück zur Bürger-Ansicht.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {kacheln.map((k) => (
          <Link
            key={k.key}
            href={`/${slugFromPath}${k.href}`}
            className="pz-card pz-card-hover group flex flex-col p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          >
            <div className="mb-3 flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl"
                style={{ backgroundColor: "var(--pz-brand-soft)" }}
              >
                {k.icon}
              </span>
              <h2 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
                {k.titel}
              </h2>
            </div>
            <p className="flex-1 text-sm" style={{ color: "var(--pz-muted)" }}>
              {k.beschreibung}
            </p>
            <p
              className="mt-4 text-sm font-medium group-hover:underline"
              style={{ color: "var(--pz-brand-strong)" }}
            >
              {k.cta} →
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
