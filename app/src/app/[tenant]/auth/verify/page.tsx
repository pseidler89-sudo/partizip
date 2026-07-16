/**
 * [tenant]/auth/verify/page.tsx — Magic-Link-Bestätigungsseite
 *
 * SCANNER-HÄRTUNG: E-Mail-Security-Scanner und Client-Prefetch folgen Links
 * in E-Mails automatisch per GET. Früher löste diese Seite den Token beim
 * Laden automatisch ein — ein Scanner-Aufruf verbrauchte den single-use
 * Token, bevor der Mensch klicken konnte („Link ungültig").
 *
 * NEUES VERHALTEN:
 *   GET  = idempotent, nebenwirkungsfrei: Token wird NUR geprüft
 *          (unbekannt / abgelaufen / bereits verwendet) und eine
 *          Bestätigungsseite mit Button gerendert. Kein Verbrauch,
 *          keine Session, kein DB-Statuswechsel, kein Audit-Event.
 *   POST = erst der Klick auf „Jetzt anmelden" (VerifyConfirm) sendet
 *          POST /api/auth/verify — dort passiert der atomare Verbrauch
 *          (CAS-UPDATE) und die Session-Erzeugung, unverändert race-sicher.
 *
 * Optionaler ?next=-Parameter: Ziel nach der Anmeldung. Wird serverseitig
 * über safeRedirectPath validiert — nur same-origin-relative Pfade,
 * sonst Default (/umfragen). Kein Open-Redirect.
 *
 * referrer: "no-referrer" — der Token steht in der URL dieser Seite und
 * darf nicht über den Referer-Header an Dritte abfließen.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createDb } from "@/db/client";
import { scopedDb } from "@/lib/db/tenant-scope";
import { getTenantFromHost } from "@/lib/tenant";
import { getTokenStatus, type TokenStatus } from "@/lib/auth/token-status";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";
import { PLATFORM_NAME } from "@/lib/brand";
import VerifyConfirm from "./VerifyConfirm";

// Auth-Seiten niemals cachen
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Anmeldung bestätigen",
  // Token nicht via Referer-Header abfließen lassen
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ token?: string; next?: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

function Schale({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <div className="pz-card p-6 text-center">{children}</div>
      </div>
    </main>
  );
}

function NeuerLinkButton({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
      style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
    >
      Neuen Link anfordern
    </Link>
  );
}

const FEHLER_TEXTE: Record<Exclude<TokenStatus, "valid">, { titel: string; text: string }> = {
  unknown: {
    titel: "Link ungültig",
    text: "Dieser Anmeldelink ist ungültig. Bitte fordern Sie einen neuen Link an.",
  },
  used: {
    titel: "Link bereits verwendet",
    text:
      "Dieser Anmeldelink wurde bereits verwendet — jeder Link funktioniert nur einmal. " +
      "Bitte fordern Sie einen neuen Link an.",
  },
  expired: {
    titel: "Link abgelaufen",
    text:
      "Dieser Anmeldelink ist abgelaufen. Aus Sicherheitsgründen ist ein Link nur " +
      "15 Minuten gültig. Bitte fordern Sie einen neuen Link an.",
  },
};

export default async function VerifyPage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const { token, next } = await searchParams;

  // Tenant ausschließlich über den Host-Header auflösen (wie Layout)
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const anmeldenHref = `/${slugFromPath}/anmelden`;

  // --- Kein Token in der URL ---
  if (!token) {
    return (
      <Schale>
        <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Kein Link gefunden
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Diese Seite wurde ohne Anmeldelink aufgerufen. Bitte fordern Sie einen
          neuen Link an.
        </p>
        <NeuerLinkButton href={anmeldenHref} />
      </Schale>
    );
  }

  // --- Token NUR prüfen — reiner Lesezugriff, kein Verbrauch ---
  const db = createDb(databaseUrl());
  const scoped = scopedDb(db, tenant.id);
  const status = await getTokenStatus(scoped, token);

  if (status !== "valid") {
    const fehler = FEHLER_TEXTE[status];
    return (
      <Schale>
        <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          {fehler.titel}
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          {fehler.text}
        </p>
        <NeuerLinkButton href={anmeldenHref} />
      </Schale>
    );
  }

  // --- Gültig: Bestätigungsseite. Eingelöst wird erst per Klick (POST). ---
  const nextPath = safeRedirectPath(next);

  return (
    <Schale>
      <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Anmeldung bestätigen
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        Sie haben einen Anmeldelink für {PLATFORM_NAME} angefordert. Klicken Sie
        auf den Knopf, um die Anmeldung abzuschließen.
      </p>
      <VerifyConfirm token={token} nextPath={nextPath} anmeldenHref={anmeldenHref} />
      <p className="mt-4 text-xs" style={{ color: "var(--pz-muted)" }}>
        Falls Sie diesen Link nicht angefordert haben, schließen Sie diese Seite
        einfach — es passiert nichts ohne Ihre Bestätigung.
      </p>
    </Schale>
  );
}
