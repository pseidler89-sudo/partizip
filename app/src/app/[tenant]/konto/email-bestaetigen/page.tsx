/**
 * [tenant]/konto/email-bestaetigen/page.tsx — Bestätigung der E-Mail-Änderung
 * (Block J2b).
 *
 * SCANNER-HÄRTUNG (wie Magic-Link-/Einladungs-Bestätigung, Block A):
 *   GET  = idempotent, nebenwirkungsfrei. Der Token wird NUR geprüft
 *          (ungültig / abgelaufen / bereits verwendet / falsches Konto). KEIN
 *          Verbrauch, KEIN Wechsel, KEIN Audit.
 *   POST = erst der Klick auf „Neue Adresse jetzt bestätigen"
 *          (EmailBestaetigenButton → Server Action) konsumiert den Token und
 *          vollzieht den Wechsel (atomar, race-frei).
 *
 * Erfordert die Session DESSELBEN Users. Nicht angemeldet → Anmelde-CTA mit
 * Rückkehr. referrer: "no-referrer" — der Token steht in der URL.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { emailAenderungPruefenCore } from "@/lib/konto/email-change-core";
import EmailBestaetigenButton from "./EmailBestaetigenButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "E-Mail-Adresse bestätigen",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ token?: string }>;
}

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip";
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

function Meldung({ titel, text, slug }: { titel: string; text: string; slug: string }) {
  return (
    <Schale>
      <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        {titel}
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        {text}
      </p>
      <Link
        href={`/${slug}/konto`}
        className="mt-4 inline-block text-sm font-medium underline-offset-2 hover:underline"
        style={{ color: "var(--pz-brand-strong)" }}
      >
        Zum Konto
      </Link>
    </Schale>
  );
}

export default async function EmailBestaetigenPage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const { token } = await searchParams;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  if (!token) {
    return (
      <Meldung
        slug={slugFromPath}
        titel="Kein Bestätigungslink"
        text="Diese Seite wurde ohne gültigen Bestätigungslink aufgerufen."
      />
    );
  }

  const db = createDb(databaseUrl());

  // --- Session (OPTIONAL): Bestätigung braucht die Session DESSELBEN Users. ---
  let sessionUserId: string | null = null;
  const cookieStore = await cookies();
  const rawSession = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawSession) {
    const now = new Date();
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256Hex(rawSession)), eq(sessions.tenantId, tenant.id)))
      .limit(1);
    const s = rows[0];
    if (s && !s.revokedAt && s.expiresAt >= now) sessionUserId = s.userId;
  }

  // Nicht angemeldet → Anmelde-CTA mit Rückkehr auf genau diese Seite.
  if (!sessionUserId) {
    const anmeldenHref = `/${slugFromPath}/anmelden?next=${encodeURIComponent(
      `/${slugFromPath}/konto/email-bestaetigen?token=${token}`,
    )}`;
    return (
      <Schale>
        <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Bitte melden Sie sich an
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Um Ihre neue E-Mail-Adresse zu bestätigen, melden Sie sich bitte in dem
          Konto an, für das Sie die Änderung angefordert haben.
        </p>
        <Link
          href={anmeldenHref}
          className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
          style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
        >
          Jetzt anmelden
        </Link>
        <p className="mt-3 text-xs" style={{ color: "var(--pz-muted)" }}>
          Öffnen Sie nach der Anmeldung diesen Link erneut, um die Änderung
          abzuschließen.
        </p>
      </Schale>
    );
  }

  // --- Token NUR prüfen (kein Verbrauch). ---
  const check = await emailAenderungPruefenCore(db, {
    tenantId: tenant.id,
    sessionUserId,
    tokenRaw: token,
  });

  if (check.kind === "invalid") {
    return (
      <Meldung
        slug={slugFromPath}
        titel="Link ungültig"
        text="Dieser Bestätigungslink ist ungültig. Bitte fordern Sie die Änderung in Ihrem Konto erneut an."
      />
    );
  }
  if (check.kind === "wrong_account") {
    return (
      <Meldung
        slug={slugFromPath}
        titel="Anderes Konto angemeldet"
        text="Dieser Bestätigungslink gehört zu einem anderen Konto. Bitte melden Sie sich mit dem Konto an, für das Sie die Änderung angefordert haben."
      />
    );
  }
  if (check.kind === "used") {
    return (
      <Meldung
        slug={slugFromPath}
        titel="Bereits verwendet"
        text="Dieser Bestätigungslink wurde bereits verwendet. Falls Ihre Adresse noch nicht geändert wurde, fordern Sie die Änderung bitte erneut an."
      />
    );
  }
  if (check.kind === "expired") {
    return (
      <Meldung
        slug={slugFromPath}
        titel="Link abgelaufen"
        text="Dieser Bestätigungslink ist abgelaufen. Bitte fordern Sie die Änderung in Ihrem Konto erneut an."
      />
    );
  }

  // valid → bewusste Bestätigung per Klick (POST konsumiert).
  return (
    <Schale>
      <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Neue E-Mail-Adresse bestätigen
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        Sie sind dabei, die E-Mail-Adresse Ihres Kontos auf{" "}
        <strong style={{ color: "var(--pz-ink)" }}>{check.neueEmail}</strong> zu
        ändern. Ab dann melden Sie sich mit der neuen Adresse an.
      </p>
      <EmailBestaetigenButton token={token} tenantSlug={slugFromPath} />
      <p className="mt-4 text-xs" style={{ color: "var(--pz-muted)" }}>
        Falls Sie diese Änderung nicht angefordert haben, schließen Sie diese Seite
        einfach — es passiert nichts ohne Ihre Bestätigung.
      </p>
    </Schale>
  );
}
