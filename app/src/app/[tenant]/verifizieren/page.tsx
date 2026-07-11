/**
 * [tenant]/verifizieren/page.tsx — Verify-Hub (D6) + QR-Einlösung (ADR-014 Block 2).
 *
 * Zwei Modi:
 *   A) ?code=<rawToken> in der URL → QR-Einlöse-Flow (FALLBACK, unverändert):
 *      nicht eingeloggt → Anmelde-CTA · gültig → Bestätigen · sonst Hinweis.
 *   B) ohne code → Verify-Hub: Status (verifiziert / Termin gebucht / offen),
 *      3-Schritt-Stepper (Standort → Termin → vor Ort ausweisen), CTA „Standort
 *      wählen". „Mitmachen geht sofort" — Verifizierung nur für verbindliche Polls.
 *
 * Diese Seite löst selbst NICHT ein/bucht nicht — Aktionen laufen über Server
 * Actions (Stufe-/Berechtigungs-Pflicht, atomar).
 */

import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import {
  MapPin,
  CalendarCheck,
  BadgeCheck,
  ShieldAlert,
  ShieldCheck,
  Info,
  QrCode,
} from "lucide-react";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions, users } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getStufe } from "@/lib/eligibility/stufe";
import { qrTokenMeta, type QrTokenMeta } from "@/lib/verification/queries";
import { getMeinOffenerTermin } from "@/lib/verification/booking-queries";
import { formatSlotLabel, formatDay } from "@/lib/verification/slot-format";
import VerifizierenBestaetigen from "./VerifizierenBestaetigen";
import TerminAbsagen from "./TerminAbsagen";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ code?: string }>;
}

const SCOPE_LABELS: Record<string, string> = {
  ortsteil: "Ortsteil",
  stadt: "Kommune",
  kreis: "Kreis",
  land: "Land",
};

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

function scopeBezeichnung(meta: QrTokenMeta, tenantName: string): string {
  if (meta.label) return meta.label;
  if (meta.scopeLevel === "stadt") return tenantName;
  const lvl = SCOPE_LABELS[meta.scopeLevel] ?? meta.scopeLevel;
  return meta.scopeCode ? `${lvl} ${meta.scopeCode}` : lvl;
}

function Schale({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

export default async function VerifizierenPage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const { code } = await searchParams;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const db = createDb(databaseUrl());

  // Session OPTIONAL → userId/stufe/Verifizierungs-Ablauf.
  let userId: string | null = null;
  let stufe = 0;
  let residencyVerifiedUntil: Date | null = null;
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
        .select()
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.tenantId, tenant.id)))
        .limit(1);
      if (userRows[0]) {
        userId = userRows[0].id;
        stufe = getStufe(userRows[0]);
        residencyVerifiedUntil = userRows[0].residencyVerifiedUntil ?? null;
      }
    }
  }
  const eingeloggt = stufe >= 1;

  // =========================================================================
  // MODUS A — QR-Einlösung (FALLBACK): nur wenn ?code= gesetzt ist.
  // =========================================================================
  if (code) {
    const meta = await qrTokenMeta(db, tenant.id, code);

    if (!meta || meta.status !== "gueltig") {
      const text =
        meta?.status === "widerrufen"
          ? "Dieser Code wurde widerrufen."
          : meta?.status === "abgelaufen"
            ? "Dieser Code ist abgelaufen."
            : meta?.status === "aufgebraucht"
              ? "Dieser Code ist aufgebraucht."
              : "Dieser Code ist ungültig.";
      return (
        <Schale>
          <div className="pz-card p-6 text-center">
            <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
              Verifizierung nicht möglich
            </h1>
            <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>{text}</p>
            <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
              Bitte wenden Sie sich an Ihre Kommune für einen neuen Code.
            </p>
            <Link
              href={`/${slugFromPath}/verifizieren`}
              className="mt-4 inline-block text-sm font-medium underline-offset-2 hover:underline"
              style={{ color: "var(--pz-brand-strong)" }}
            >
              Zur Verifizierungs-Übersicht
            </Link>
          </div>
        </Schale>
      );
    }

    const bezeichnung = scopeBezeichnung(meta, tenant.name);

    if (!eingeloggt) {
      return (
        <Schale>
          <div className="pz-card p-6 text-center">
            <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
              Zum Verifizieren bitte anmelden
            </h1>
            <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
              Sie verifizieren sich als Bürger:in von <strong>{bezeichnung}</strong>.
              Dafür ist eine kurze Anmeldung per E-Mail-Link nötig — so hängt die
              Verifizierung an einer bestätigten Person.
            </p>
            <Link
              href={`/${slugFromPath}/anmelden`}
              className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
              style={{ backgroundColor: "var(--tenant-primary)" }}
            >
              Jetzt anmelden
            </Link>
            <p className="mt-3 text-xs" style={{ color: "var(--pz-muted)" }}>
              Bitte öffnen Sie nach der Anmeldung diesen Link erneut, um die
              Verifizierung abzuschließen.
            </p>
          </div>
        </Schale>
      );
    }

    return (
      <Schale>
        <div className="pz-card p-6">
          <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Wohnsitz verifizieren
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
            Sie verifizieren sich als Bürger:in von <strong>{bezeichnung}</strong>.
            Nach der Bestätigung sind Sie wohnsitz-verifiziert (Stufe 2).
          </p>
          <VerifizierenBestaetigen code={code} tenantSlug={slugFromPath} />
        </div>
      </Schale>
    );
  }

  // =========================================================================
  // MODUS B — Verify-Hub (kein code).
  // =========================================================================
  const verifiziert = stufe >= 2;
  const offenerTermin =
    eingeloggt && userId ? await getMeinOffenerTermin(db, tenant.id, userId) : null;

  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-10">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Bestätigen Sie Ihren Wohnsitz
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        So zählt Ihre Stimme bei <strong>verbindlichen</strong> Abstimmungen als
        wohnsitz-verifiziert. Einmal erledigt, gilt es dauerhaft (mit Ablauf).
      </p>

      {/* Status-Karte */}
      {verifiziert ? (
        <div
          className="mt-5 flex items-center gap-3 rounded-xl border p-4"
          role="status"
          style={{ borderColor: "var(--pz-success-soft)", backgroundColor: "var(--pz-success-soft)" }}
        >
          <ShieldCheck aria-hidden className="h-6 w-6 shrink-0" style={{ color: "var(--pz-success-ink)" }} strokeWidth={2} />
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--pz-success-ink)" }}>
              Sie sind wohnsitz-verifiziert (Stufe 2)
            </p>
            {residencyVerifiedUntil && (
              <p className="text-xs" style={{ color: "var(--pz-success-ink)" }}>
                Gültig bis {formatDay(residencyVerifiedUntil)}.
              </p>
            )}
          </div>
        </div>
      ) : offenerTermin ? (
        <div
          className="mt-5 rounded-xl border p-4"
          role="status"
          style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-brand-soft)" }}
        >
          <div className="flex items-center gap-2">
            <CalendarCheck aria-hidden className="h-5 w-5 shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
            <p className="text-sm font-semibold" style={{ color: "var(--pz-brand-strong)" }}>
              Termin gebucht
            </p>
          </div>
          <dl className="mt-2 space-y-1 text-sm" style={{ color: "var(--pz-body)" }}>
            <div><dt className="sr-only">Termin</dt><dd>{formatSlotLabel(offenerTermin.startsAt, offenerTermin.endsAt)}</dd></div>
            <div>
              <dt className="sr-only">Ort</dt>
              <dd>
                {offenerTermin.locationName}
                {offenerTermin.locationAddress ? `, ${offenerTermin.locationAddress}` : ""}
              </dd>
            </div>
          </dl>
          <div
            className="mt-3 rounded-lg border border-dashed p-2.5 text-center"
            style={{ borderColor: "var(--pz-line-strong, var(--pz-line))", backgroundColor: "var(--pz-surface)" }}
          >
            <p className="text-xs" style={{ color: "var(--pz-muted)" }}>Ihr Termin-Code (vor Ort zeigen)</p>
            <p className="mt-0.5 font-mono text-base font-medium tracking-wide" style={{ color: "var(--pz-ink)" }}>
              {offenerTermin.code}
            </p>
          </div>
          {offenerTermin.locationHinweise && (
            <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>{offenerTermin.locationHinweise}</p>
          )}
          <TerminAbsagen bookingId={offenerTermin.bookingId} />
        </div>
      ) : (
        <div
          className="mt-5 flex items-center gap-3 rounded-xl border p-4"
          role="status"
          style={{ borderColor: "var(--pz-warning-soft)", backgroundColor: "var(--pz-warning-soft)" }}
        >
          <ShieldAlert aria-hidden className="h-6 w-6 shrink-0" style={{ color: "var(--pz-warning-ink)" }} strokeWidth={2} />
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--pz-warning-ink)" }}>
              Noch nicht verifiziert
            </p>
            <p className="text-xs" style={{ color: "var(--pz-warning-ink)" }}>
              Stimmungsbilder können Sie schon jetzt mitentscheiden.
            </p>
          </div>
        </div>
      )}

      {/* 3-Schritt-Stepper — nur wenn noch kein Termin/verifiziert. */}
      {!verifiziert && !offenerTermin && (
        <ol className="mt-6 space-y-0">
          {[
            { icon: MapPin, h: "Standort wählen", p: "Wählen Sie ein Bürgerbüro in Ihrer Nähe." },
            { icon: CalendarCheck, h: "Termin buchen", p: "Suchen Sie einen freien Termin — meist noch in dieser Woche." },
            { icon: BadgeCheck, h: "Vor Ort kurz ausweisen", p: "Personalausweis zeigen, fertig. Wir speichern kein Ausweisbild — nur, dass Ihr Wohnsitz bestätigt ist." },
          ].map((s, i, arr) => {
            const Icon = s.icon;
            return (
              <li key={s.h} className="flex gap-3.5">
                <div className="flex flex-col items-center">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                    style={
                      i === 0
                        ? { backgroundColor: "var(--tenant-primary)", color: "#fff" }
                        : { backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }
                    }
                  >
                    {i + 1}
                  </span>
                  {i < arr.length - 1 && (
                    <span className="my-1 w-0.5 flex-1" style={{ backgroundColor: "var(--pz-line-strong, var(--pz-line))", minHeight: 20 }} />
                  )}
                </div>
                <div className="pb-5">
                  <h3 className="flex items-center gap-1.5 text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
                    <Icon aria-hidden className="h-4 w-4" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
                    {s.h}
                  </h3>
                  <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>{s.p}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* „Mitmachen geht sofort"-Hinweis */}
      {!verifiziert && (
        <div className="mt-2 flex items-start gap-2.5 rounded-xl p-3.5" style={{ backgroundColor: "var(--pz-brand-soft)" }}>
          <Info aria-hidden className="mt-0.5 h-[17px] w-[17px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
          <p className="text-sm" style={{ color: "var(--pz-brand-strong)" }}>
            Sie müssen das nicht jetzt tun: <b>Mitmachen geht sofort.</b> Die
            Verifizierung brauchen Sie nur für rechtlich verbindliche Abstimmungen.
          </p>
        </div>
      )}

      {/* CTA */}
      <div className="mt-6 flex flex-col gap-3">
        {verifiziert ? (
          <Link
            href={`/${slugFromPath}/konto`}
            className="inline-flex items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--tenant-primary)" }}
          >
            Zum Konto
          </Link>
        ) : offenerTermin ? null : eingeloggt ? (
          <Link
            href={`/${slugFromPath}/verifizieren/termin`}
            className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--tenant-primary)" }}
          >
            <MapPin aria-hidden className="h-[18px] w-[18px]" strokeWidth={2} /> Standort wählen
          </Link>
        ) : (
          <Link
            href={`/${slugFromPath}/anmelden`}
            className="inline-flex items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--tenant-primary)" }}
          >
            Anmelden, um Termin zu buchen
          </Link>
        )}
        <Link
          href={`/${slugFromPath}`}
          className="self-center text-sm font-semibold underline-offset-2 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Später — erst einmal mitmachen
        </Link>
      </div>

      {/* QR-Fallback-Hinweis */}
      <p className="mt-6 flex items-start gap-2 border-t pt-4 text-xs" style={{ color: "var(--pz-muted)", borderColor: "var(--pz-line)" }}>
        <QrCode aria-hidden className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
        <span>
          Sie haben einen QR-Code Ihrer Kommune (z. B. im Bürgerbüro)? Scannen Sie
          ihn — das verifiziert Sie sofort, ohne Termin.
        </span>
      </p>
    </main>
  );
}
