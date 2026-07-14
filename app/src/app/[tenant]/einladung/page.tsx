/**
 * [tenant]/einladung/page.tsx — Einladung annehmen (Rollen-Einladungs-Flow).
 *
 * SCANNER-HÄRTUNG (konsistent mit der Magic-Link-Bestätigungsseite):
 *   GET  = idempotent, nebenwirkungsfrei. Der Token wird NUR geprüft
 *          (unbekannt / zurückgezogen / abgelaufen / bereits angenommen) und
 *          eine Bestätigungsseite gerendert. KEIN Verbrauch, keine Rollenvergabe,
 *          kein Audit-Event.
 *   POST = erst der Klick auf „Einladung annehmen" (EinladungAnnehmen → Server
 *          Action) nimmt an. Dort passiert der atomare pending→accepted-Übergang
 *          und die Rollenvergabe (race-frei).
 *
 * E-Mail-BINDUNG: Angenommen werden kann nur mit einem Konto, dessen E-Mail der
 * eingeladenen Adresse entspricht. Nicht angemeldet → Anmelde-CTA. Mit falscher
 * Adresse angemeldet → klarer Hinweis (kein Existenz-Leak: der/die Aufrufer:in
 * hat den Link ohnehin per Mail an genau diese Adresse erhalten).
 *
 * referrer: "no-referrer" — der Token steht in der URL und darf nicht abfließen.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions, users } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  getInvitationStatus,
  type InvitationStatus,
} from "@/lib/admin/invitation-core";
import { PLATFORM_NAME } from "@/lib/brand";
import EinladungAnnehmen from "./EinladungAnnehmen";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Einladung annehmen",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ token?: string }>;
}

const ROLE_LABELS: Record<string, string> = {
  user: "Bürger:in",
  verifier: "Verifizierer:in",
  redakteur: "Redakteur:in",
  beobachter: "Beobachter:in (nur Lesen)",
  kommune_admin: "Kommune-Admin",
  super_admin: "Super-Admin",
  ortsteil_admin: "Ortsteil-Admin",
  kreis_admin: "Kreis-Admin",
  land_admin: "Land-Admin",
};

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

function Fehler({ titel, text, slug }: { titel: string; text: string; slug: string }) {
  return (
    <Schale>
      <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        {titel}
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        {text}
      </p>
      <Link
        href={`/${slug}`}
        className="mt-4 inline-block text-sm font-medium underline-offset-2 hover:underline"
        style={{ color: "var(--pz-brand-strong)" }}
      >
        Zur Startseite
      </Link>
    </Schale>
  );
}

const FEHLER_TEXTE: Record<Exclude<InvitationStatus, "valid">, { titel: string; text: string }> = {
  unknown: {
    titel: "Einladung ungültig",
    text: "Diese Einladung ist ungültig. Bitte wenden Sie sich an Ihre Kommune.",
  },
  accepted: {
    titel: "Bereits angenommen",
    text: "Diese Einladung wurde bereits angenommen. Melden Sie sich einfach an, um mitzuwirken.",
  },
  revoked: {
    titel: "Einladung zurückgezogen",
    text: "Diese Einladung wurde von Ihrer Kommune zurückgezogen.",
  },
  expired: {
    titel: "Einladung abgelaufen",
    text: "Diese Einladung ist abgelaufen. Bitte bitten Sie Ihre Kommune um eine neue Einladung.",
  },
};

export default async function EinladungPage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const { token } = await searchParams;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  if (!token) {
    return (
      <Fehler
        slug={slugFromPath}
        titel="Kein Einladungslink"
        text="Diese Seite wurde ohne gültigen Einladungslink aufgerufen."
      />
    );
  }

  const db = createDb(databaseUrl());

  // --- Token NUR prüfen — reiner Lesezugriff, keine Annahme, kein Audit. ---
  const check = await getInvitationStatus(db, tenant.id, token);
  if (check.status !== "valid") {
    const f = FEHLER_TEXTE[check.status];
    return <Fehler slug={slugFromPath} titel={f.titel} text={f.text} />;
  }

  const roleLabel = ROLE_LABELS[check.roleType ?? ""] ?? check.roleType ?? "Mitwirkende:r";

  // --- Anmeldestatus + E-Mail-Bindung (Session OPTIONAL). ---
  let loggedInEmail: string | null = null;
  const cookieStore = await cookies();
  const rawSession = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawSession) {
    const now = new Date();
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256Hex(rawSession)), eq(sessions.tenantId, tenant.id)))
      .limit(1);
    const session = sessionRows[0];
    if (session && !session.revokedAt && session.expiresAt >= now) {
      const userRows = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
        .limit(1);
      if (userRows[0]) loggedInEmail = userRows[0].email;
    }
  }

  const eingeladeneEmail = (check.email ?? "").trim().toLowerCase();

  // Nicht angemeldet → Anmelde-CTA (Magic-Link-Infrastruktur).
  if (!loggedInEmail) {
    const anmeldenHref = `/${slugFromPath}/anmelden?next=${encodeURIComponent(
      `/${slugFromPath}/einladung?token=${token}`,
    )}`;
    return (
      <Schale>
        <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Einladung als {roleLabel}
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Sie wurden von <strong>{tenant.name}</strong> eingeladen, bei {PLATFORM_NAME} als{" "}
          <strong>{roleLabel}</strong> mitzuwirken. Bitte melden Sie sich mit der{" "}
          <strong>eingeladenen E-Mail-Adresse</strong> an, um die Einladung anzunehmen.
        </p>
        <Link
          href={anmeldenHref}
          className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
          style={{ backgroundColor: "var(--tenant-primary, var(--pz-brand))" }}
        >
          Jetzt anmelden
        </Link>
        <p className="mt-3 text-xs" style={{ color: "var(--pz-muted)" }}>
          Bitte öffnen Sie nach der Anmeldung diesen Link erneut, um die Einladung
          abzuschließen.
        </p>
      </Schale>
    );
  }

  // Mit anderer Adresse angemeldet → klarer Hinweis (E-Mail-Bindung).
  if (loggedInEmail.trim().toLowerCase() !== eingeladeneEmail) {
    return (
      <Schale>
        <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Andere E-Mail-Adresse angemeldet
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Diese Einladung ist an eine bestimmte E-Mail-Adresse gebunden. Sie sind
          derzeit mit einer anderen Adresse angemeldet. Bitte melden Sie sich mit der
          eingeladenen Adresse an, um die Einladung anzunehmen.
        </p>
        <Link
          href={`/${slugFromPath}/konto`}
          className="mt-4 inline-block text-sm font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Zum Konto (dort abmelden)
        </Link>
      </Schale>
    );
  }

  // Angemeldet mit der eingeladenen Adresse → bewusste Annahme per Klick (POST).
  return (
    <Schale>
      <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Einladung annehmen
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        Sie wurden von <strong>{tenant.name}</strong> eingeladen, bei {PLATFORM_NAME} als{" "}
        <strong>{roleLabel}</strong> mitzuwirken. Mit einem Klick nehmen Sie die
        Einladung an und erhalten die Rolle.
      </p>
      <EinladungAnnehmen token={token} tenantSlug={slugFromPath} />
      <p className="mt-4 text-xs" style={{ color: "var(--pz-muted)" }}>
        Falls Sie diese Einladung nicht erwartet haben, schließen Sie diese Seite
        einfach — es passiert nichts ohne Ihre Bestätigung.
      </p>
    </Schale>
  );
}
