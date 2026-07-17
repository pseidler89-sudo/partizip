/**
 * [tenant]/layout.tsx — Tenant-spezifisches Layout
 *
 * M2 (Gate-B-Fix): Tenant wird AUSSCHLIESSLICH über den Host-Header aufgelöst.
 * Wenn kein Host-Tenant gefunden ODER hostTenant.slug !== params.tenant → notFound().
 * Der Pfad-Slug-Fallback wurde ersatzlos entfernt.
 *
 * Injiziert CSS-Variablen für Tenant-Branding (--tenant-primary etc.)
 * aus dem Tenant-Datensatz-Felder. Naming bewusst ohne party-Kontext.
 *
 * Enthält schlanke Kopfzeile (Tenant-Name + Navigation) und Footer.
 * Die Navigation zeigt den Anmelde-Status: für Admins einen „Verwaltung"-Link
 * (Discoverability — die Admin-Seiten erzwingen die Berechtigung weiterhin
 * serverseitig), für Eingeloggte „Konto", sonst „Anmelden".
 */

import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { getTenantFromHost } from "@/lib/tenant";
import type { TenantRow } from "@/lib/tenant";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { createDb } from "@/db/client";
import { polls, sessions, users } from "@/db/schema";
import { isDemoTenant } from "@/lib/demo/config";
import { DemoBanner } from "./DemoBanner";
import { DemoGuide } from "./DemoGuide";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getUserRoleTypes, isAdmin } from "@/lib/auth/roles";
import { FEATURE_ANLIEGEN_EINREICHEN } from "@/lib/features";
import { PLATFORM_NAME, regionDisplayName } from "@/lib/brand";
import { BrandMark } from "@/components/BrandMark";
import { StandortChip } from "./StandortChip";
import { NavLink } from "./NavLink";
import { LoginEntry } from "./LoginEntry";

interface TenantLayoutProps {
  children: React.ReactNode;
  params: Promise<{ tenant: string }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const { tenant: slugFromPath } = await params;

  // Host-Header lesen — EINZIGE Quelle der Tenant-Auflösung
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";

  const tenant = await getTenantFromHost(host);

  // Kein Host-Tenant ODER Slug stimmt nicht überein → 404
  if (!tenant || tenant.slug !== slugFromPath) {
    notFound();
  }

  // Anmelde-Status + Admin-Rolle für die Navigation (nur Anzeige; die Admin-
  // Seiten erzwingen die Berechtigung selbst serverseitig). Tenant-scoped.
  let eingeloggt = false;
  let admin = false;
  const db = createDb(databaseUrl());
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
      const u = userRows[0];
      if (u) {
        eingeloggt = true;
        admin = isAdmin(await getUserRoleTypes(db, tenant.id, u.id));
      }
    }
  }

  // Demo-Mandant: Belege-Link der neuesten GESCHLOSSENEN Beispiel-Frage für den
  // geführten Rundgang (Schritt „Beleg prüfen") — tenant-scoped, nur im Demo-Fall.
  const demo = isDemoTenant(tenant.slug);
  let demoBelegeHref = `/${slugFromPath}/umfragen`;
  if (demo) {
    const geschlossen = await db
      .select({ id: polls.id })
      .from(polls)
      .where(and(eq(polls.tenantId, tenant.id), eq(polls.status, "geschlossen")))
      .orderBy(desc(polls.closesAt))
      .limit(1);
    if (geschlossen[0]) {
      demoBelegeHref = `/${slugFromPath}/umfrage/${geschlossen[0].id}/belege`;
    }
  }

  return (
    <TenantLayoutInner
      tenant={tenant}
      slugFromPath={slugFromPath}
      eingeloggt={eingeloggt}
      admin={admin}
      demo={demo}
      demoBelegeHref={demoBelegeHref}
    >
      {children}
    </TenantLayoutInner>
  );
}

function TenantLayoutInner({
  tenant,
  slugFromPath,
  eingeloggt,
  admin,
  demo,
  demoBelegeHref,
  children,
}: {
  tenant: TenantRow;
  slugFromPath: string;
  eingeloggt: boolean;
  admin: boolean;
  demo: boolean;
  demoBelegeHref: string;
  children: React.ReactNode;
}) {
  // Default-Akzent = Civic-Teal (Design-Profil); Tenant-Branding überschreibt.
  const primaryColor = tenant.primaryColor ?? "#0d6a70";
  // Standort-Chip-Label: die Kommune ohne interne Suffixe („(Staging)" etc.).
  const kommuneName = regionDisplayName(tenant.name);

  return (
    <div
      style={
        {
          "--tenant-primary": primaryColor,
          "--tenant-primary-foreground": "#ffffff",
        } as React.CSSProperties
      }
      className="min-h-screen flex flex-col"
    >
      {/* Kopfzeile */}
      <header className="sticky top-0 z-30 border-b border-[color:var(--pz-line)] bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70">
        {/* flex-wrap: auf schmalen Handy-Viewports (<~430px) bricht die Nav in
            eine zweite Zeile statt Marke/Links zu überlappen (Demo-DoD „mobil
            einwandfrei"; Overlap real auf 420px-Screenshot beobachtet). */}
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
          {/* Plattform-Marke (Single-Domain): immer „Partizip" — die Kommune ist
              Region-Kontext (Standort-Chip daneben), nicht die Marke im Seitenkopf. */}
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href="/"
              className="flex items-center gap-2 transition-opacity hover:opacity-80"
            >
              {/* Bildzeichen bleibt IMMER Plattform-Teal (Marken-Regel);
                  Tenant-Farbe trägt nur der Standort-Chip. */}
              <BrandMark className="h-6 w-6 shrink-0" />
              <span className="text-base font-semibold" style={{ color: "var(--tenant-primary)" }}>
                {PLATFORM_NAME}
              </span>
            </Link>
            <StandortChip slug={slugFromPath} label={kommuneName} />
          </div>

          {/* Haupt-Navigation — NavLink setzt aria-current="page" für den
              aktiven Abschnitt (A11y) und hebt ihn dezent hervor. */}
          <div className="flex items-center gap-1 sm:gap-3 text-sm">
            <NavLink
              href={`/${slugFromPath}/umfragen`}
              className="rounded-md px-2.5 py-1.5 text-pz-muted hover:bg-pz-brand-soft hover:text-pz-ink transition-colors whitespace-nowrap"
              activeClassName="font-medium text-pz-ink"
            >
              Abstimmungen
            </NavLink>
            <NavLink
              href={`/${slugFromPath}/digest`}
              className="rounded-md px-2.5 py-1.5 text-pz-muted hover:bg-pz-brand-soft hover:text-pz-ink transition-colors whitespace-nowrap"
              activeClassName="font-medium text-pz-ink"
            >
              Ratsinfos
            </NavLink>
            {FEATURE_ANLIEGEN_EINREICHEN && (
              <NavLink
                href={`/${slugFromPath}/anliegen`}
                className="rounded-md px-2.5 py-1.5 text-pz-muted hover:bg-pz-brand-soft hover:text-pz-ink transition-colors whitespace-nowrap"
                activeClassName="font-medium text-pz-ink"
              >
                Anliegen
              </NavLink>
            )}
            {admin && (
              <NavLink
                href={`/${slugFromPath}/admin`}
                className="rounded-md px-2.5 py-1.5 font-medium text-pz-brand-strong hover:bg-pz-brand-soft transition-colors whitespace-nowrap"
                activeClassName="bg-pz-brand-soft"
              >
                Verwaltung
              </NavLink>
            )}
            {eingeloggt ? (
              <NavLink
                href={`/${slugFromPath}/konto`}
                className="rounded-md px-2.5 py-1.5 text-pz-muted hover:bg-pz-brand-soft hover:text-pz-ink transition-colors whitespace-nowrap"
                activeClassName="font-medium text-pz-ink"
              >
                Konto
              </NavLink>
            ) : (
              <LoginEntry tenantSlug={slugFromPath} />
            )}
          </div>
        </nav>
      </header>

      {/* Demo-Mandant: nicht schließbares Spielwiesen-Banner + geführter Rundgang */}
      {demo && <DemoBanner />}
      {demo && <DemoGuide slug={slugFromPath} belegeHref={demoBelegeHref} />}

      {/* Seiteninhalt (Skip-Link-Ziel) */}
      <div id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </div>

      {/* Footer — dauerhaft erreichbare Einstiege (FAQ/Für-Kommunen lebten sonst
          nur auf der Landing, die mit dem Region-Cookie verschwindet) */}
      <footer className="border-t border-pz-line bg-pz-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 py-4 text-xs text-pz-muted">
          {/* Markenzeile: Bildzeichen + Plattformname (bleibt Teal, s. Header). */}
          <span className="inline-flex items-center gap-1.5">
            <BrandMark className="h-4 w-4 shrink-0" />
            <span className="font-medium">{PLATFORM_NAME}</span>
          </span>
          <span aria-hidden>·</span>
          <Link
            href={`/${slugFromPath}/impressum`}
            className="hover:text-pz-ink transition-colors"
          >
            Impressum
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={`/${slugFromPath}/datenschutz`}
            className="hover:text-pz-ink transition-colors"
          >
            Datenschutz
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={`/${slugFromPath}/transparenz`}
            className="hover:text-pz-ink transition-colors"
          >
            Transparenz
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={`/${slugFromPath}/faq`}
            className="hover:text-pz-ink transition-colors"
          >
            Häufige Fragen
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={`/${slugFromPath}/fuer-kommunen`}
            className="hover:text-pz-ink transition-colors"
          >
            Für Kommunen
          </Link>
          <span aria-hidden>·</span>
          <a
            href="https://github.com/pseidler89-sudo/partizip"
            className="hover:text-pz-ink transition-colors"
          >
            Quellcode (GitHub)
          </a>
        </div>
      </footer>
    </div>
  );
}
