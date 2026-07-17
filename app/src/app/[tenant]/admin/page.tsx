/**
 * [tenant]/admin/page.tsx — Admin-Übersicht / Dashboard (Aufgabe 2)
 *
 * Gleicher Auth-/Rollen-Guard wie admin/digests/page.tsx und admin/anliegen/page.tsx.
 * Zeigt zwei Karten: Digests (Anzahl Entwürfe) und Anliegen (Anzahl offener Anliegen).
 * Für kommune_admin/super_admin (voll) sowie `beobachter` (reduzierte Lese-
 * Übersicht: nur Digests-/Abstimmungs-Karten im eigenen Scope, keine Kennzahlen).
 */

import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, count } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { digests, polls, qrCodes, sessions, verificationLocations } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { isAdmin as isAdminCheck, beobachterDarfTenantweitSehen, canRedaktion, getUserRolesMitScope } from "@/lib/auth/roles";
import { getAdminKennzahlen, maskTeilnahme } from "@/lib/admin/kennzahlen";
import { isDemoTenant } from "@/lib/demo/config";
import Link from "next/link";

/** Eine Kennzahl-Kachel (PII-frei). `hint` erklärt z. B. die Re-Identifikations-Maskierung. */
function Kennzahl({ label, wert, hint }: { label: string; wert: string; hint?: string }) {
  return (
    <div className="pz-card p-4">
      <div className="text-2xl font-semibold tabular-nums" style={{ color: "var(--pz-ink)" }}>
        {wert}
      </div>
      <div className="mt-0.5 text-xs font-medium" style={{ color: "var(--pz-muted)" }}>
        {label}
      </div>
      {hint && (
        <div className="mt-1 text-[11px]" style={{ color: "var(--pz-muted)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

interface PageProps {
  params: Promise<{ tenant: string }>;
}

export default async function AdminDashboardPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) redirect(`/${slugFromPath}/anmelden`);

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
    redirect(`/${slugFromPath}/anmelden`);
  }

  // Rollen über den account-status-filternden Weg laden: ein gesperrtes/gelöschtes
  // Konto (accountStatus != 'active') erhält [] und kann diese Admin-Sicht nicht
  // laden — konsistent mit getUserRoleTypes (kein Direktzugriff auf `roles`).
  const roleRows = await getUserRolesMitScope(db, tenant.id, session.userId);
  const roleTypes = roleRows.map((r: { roleType: string }) => r.roleType);

  // Rollen-Governance: Admins sehen alles; `beobachter` bekommt eine reduzierte
  // Lese-Übersicht (nur Digests-/Abstimmungs-Karten, keine Kennzahlen und keine
  // Verwaltungs-Karten — Rollen/Protokoll/Verifizierung/Anliegen bleiben Admins
  // vorbehalten und sind serverseitig zusätzlich gegated).
  const isAdmin = isAdminCheck(roleTypes);
  const hatBeobachterRolle = roleTypes.includes("beobachter");

  if (!isAdmin && !hatBeobachterRolle) redirect(`/${slugFromPath}/anmelden`);

  // Beobachter: Digest-Karte nur mit stadtweitem Scope (Digests sind stadtweit).
  const zeigeDigestKarte = isAdmin || beobachterDarfTenantweitSehen(roleRows);

  // Anzahl Digest-Entwürfe (Status: entwurf)
  let digestEntwurfCount = 0;
  if (zeigeDigestKarte) {
    const digestEntwurfRows = await db
      .select({ count: count() })
      .from(digests)
      .where(and(eq(digests.tenantId, tenant.id), eq(digests.status, "entwurf")));
    digestEntwurfCount = digestEntwurfRows[0]?.count ?? 0;
  }

  // PII-freie Civic-Kennzahlen fürs Dashboard (P2 §Empf. 5) — enthält auch die
  // offenen Anliegen (für die Karten-Badge wiederverwendet). Nur für Admins.
  const kennzahlen = isAdmin ? await getAdminKennzahlen(db, tenant.id) : null;
  const anliegenOffenCount = kennzahlen?.offeneAnliegen ?? 0;

  // „Erste Schritte" (Einrichtungs-Checkliste Fläche C): zustandsbasiert —
  // ein Schritt gilt als erledigt, sobald das Objekt EINMAL existiert. Bewusst
  // eigene Existenz-Zähler statt der Kennzahlen-Kacheln: die zählen nur AKTIVE
  // Objekte (laufende Abstimmungen, gültige QR-Codes) — für „schon eingerichtet"
  // zählt aber auch Abgelaufenes/Geschlossenes. Nur für Admins (Beobachter =
  // View-Only, keine Handlungs-CTAs); die Karte verschwindet vollständig,
  // sobald alles vorhanden ist (kein Dismiss nötig).
  // Auf dem Demo-Mandanten NICHT berechnen/rendern: „Verifizierungs-Standort"
  // und „QR-Code" sind dort nicht erfüllbar (keine UI) → die Karte bliebe ewig
  // stehen (Sackgasse, Gate-B MINOR-3).
  let ersteSchritte: { label: string; href: string; erledigt: boolean }[] | null = null;
  if (isAdmin && !isDemoTenant(tenant.slug)) {
    const [locRows, qrRows, pollRows, digestRows] = await Promise.all([
      db.select({ c: count() }).from(verificationLocations).where(eq(verificationLocations.tenantId, tenant.id)),
      db.select({ c: count() }).from(qrCodes).where(eq(qrCodes.tenantId, tenant.id)),
      db.select({ c: count() }).from(polls).where(eq(polls.tenantId, tenant.id)),
      db.select({ c: count() }).from(digests).where(eq(digests.tenantId, tenant.id)),
    ]);
    const schritte = [
      {
        label: "Verifizierungs-Standort anlegen",
        // Block K1: direkt zur Standort-/Sprechzeiten-Verwaltung (vorher gab es
        // keine UI dafür — der Link zeigte nur auf die Verifizierungs-Übersicht).
        href: `/${slugFromPath}/admin/verifizierung/standorte`,
        erledigt: Number(locRows[0]?.c ?? 0) > 0,
      },
      {
        label: "QR-Code erstellen",
        href: `/${slugFromPath}/admin/verifizierung`,
        erledigt: Number(qrRows[0]?.c ?? 0) > 0,
      },
      {
        label: "Erste Umfrage stellen",
        href: `/${slugFromPath}/admin/abstimmungen`,
        erledigt: Number(pollRows[0]?.c ?? 0) > 0,
      },
      // Digest-Schritt nur für Redaktions-Berechtigte (Admins erfüllen das
      // immer — der Check hält die Bedingung explizit, falls die Karte je
      // für weitere Rollen geöffnet wird).
      ...(canRedaktion(roleTypes)
        ? [
            {
              label: "Ersten Digest anlegen",
              href: `/${slugFromPath}/admin/digests`,
              erledigt: Number(digestRows[0]?.c ?? 0) > 0,
            },
          ]
        : []),
    ];
    ersteSchritte = schritte.some((s) => !s.erledigt) ? schritte : null;
  }

  return (
    <main className="min-h-screen px-6 py-10 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-pz-ink">Admin-Bereich</h1>
        <p className="text-sm text-pz-muted mt-1">{tenant.name}</p>
      </div>

      {/* „Erste Schritte" (Fläche C): nur solange mindestens ein Baustein fehlt —
          danach verschwindet die Karte vollständig (keine Dauerpräsenz). */}
      {ersteSchritte && (
        <section className="pz-card mb-8 p-5" aria-label="Erste Schritte">
          <h2 className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
            Erste Schritte
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
            Diese Bausteine machen Ihre Kommune startklar. Die Karte verschwindet,
            sobald alles vorhanden ist.
          </p>
          <ul className="mt-3 space-y-2.5">
            {ersteSchritte.map((s) => (
              <li key={s.label} className="flex items-start gap-2.5 text-sm">
                {s.erledigt ? (
                  <>
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
                    >
                      ✓
                    </span>
                    <span style={{ color: "var(--pz-body)" }}>
                      <span className="sr-only">Erledigt: </span>
                      {s.label}
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      aria-hidden
                      className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2"
                      style={{ borderColor: "var(--pz-line)" }}
                    />
                    <Link
                      href={s.href}
                      className="font-medium underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                      style={{ color: "var(--pz-brand-strong)" }}
                    >
                      {s.label} →
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Civic-Kennzahlen (P2 §Empf. 5): PII-freie Aggregate auf einen Blick.
          Teilnahmezahlen (Stimmen) werden ab <5 maskiert (Re-Identifikationsschutz). */}
      {kennzahlen && (
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kennzahl label="Aktive Abstimmungen" wert={String(kennzahlen.aktiveAbstimmungen)} />
          <Kennzahl
            label="Stimmen (laufend)"
            wert={maskTeilnahme(kennzahlen.stimmenLaufend)}
            hint={
              kennzahlen.stimmenLaufend > 0 && kennzahlen.stimmenLaufend < 5
                ? "klein gehalten zum Schutz vor Rückschlüssen"
                : undefined
            }
          />
          <Kennzahl label="Aktive QR-Codes" wert={String(kennzahlen.aktiveQrCodes)} />
          <Kennzahl label="Offene Anliegen" wert={String(kennzahlen.offeneAnliegen)} />
        </div>
      )}

      {!isAdmin && (
        <div className="mb-8 rounded-lg border border-pz-line bg-pz-surface p-4 text-sm text-pz-muted">
          Lesender Zugriff: Sie können Ergebnisse und Digest-Entwürfe in Ihrem
          Bereich einsehen. Bearbeitung, Freigabe und Verwaltung übernehmen
          Administrator:innen.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Karte: Digests (Beobachter nur mit stadtweitem Scope) */}
        {zeigeDigestKarte && (
          <Link
            href={`/${slugFromPath}/admin/digests`}
            className="group rounded-lg border border-pz-line p-6 hover:border-pz-line hover:bg-pz-brand-soft transition-colors"
          >
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-lg font-medium text-pz-ink group-hover:text-pz-body">
                Digests
              </h2>
              {digestEntwurfCount > 0 && (
                <span className="rounded-full pz-badge-warning px-2.5 py-0.5 text-xs font-medium">
                  {digestEntwurfCount} Entwurf{digestEntwurfCount !== 1 ? "e" : ""}
                </span>
              )}
            </div>
            <p className="text-sm text-pz-muted">
              {isAdmin
                ? "Sitzungszusammenfassungen verwalten, freigeben und veröffentlichen."
                : "Sitzungszusammenfassungen und Entwürfe einsehen."}
            </p>
            <p className="mt-3 text-sm font-medium text-[var(--tenant-primary,var(--pz-brand))] group-hover:underline">
              Digests öffnen →
            </p>
          </Link>
        )}

        {/* Karte: Anliegen */}
        {isAdmin && (
        <Link
          href={`/${slugFromPath}/admin/anliegen`}
          className="group rounded-lg border border-pz-line p-6 hover:border-pz-line hover:bg-pz-brand-soft transition-colors"
        >
          <div className="flex items-start justify-between mb-3">
            <h2 className="text-lg font-medium text-pz-ink group-hover:text-pz-body">
              Anliegen
            </h2>
            {anliegenOffenCount > 0 && (
              <span className="rounded-full pz-badge-info px-2.5 py-0.5 text-xs font-medium">
                {anliegenOffenCount} offen
              </span>
            )}
          </div>
          <p className="text-sm text-pz-muted">
            Eingereichte Bürgeranliegen einsehen und bearbeiten.
          </p>
          <p className="mt-3 text-sm font-medium text-[var(--tenant-primary,var(--pz-brand))] group-hover:underline">
            Anliegen öffnen →
          </p>
        </Link>
        )}

        {/* Karte: Rollen verwalten (Achse B) */}
        {isAdmin && (
        <Link
          href={`/${slugFromPath}/admin/rollen`}
          className="group rounded-lg border border-pz-line p-6 hover:border-pz-line hover:bg-pz-brand-soft transition-colors"
        >
          <div className="flex items-start justify-between mb-3">
            <h2 className="text-lg font-medium text-pz-ink group-hover:text-pz-body">
              Rollen
            </h2>
          </div>
          <p className="text-sm text-pz-muted">
            Rollen zuweisen und entziehen. Jede Änderung wird PII-frei protokolliert.
          </p>
          <p className="mt-3 text-sm font-medium text-[var(--tenant-primary,var(--pz-brand))] group-hover:underline">
            Rollen verwalten →
          </p>
        </Link>
        )}

        {/* Karte: Protokoll / Audit-Log (Achse B) */}
        {isAdmin && (
        <Link
          href={`/${slugFromPath}/admin/protokoll`}
          className="group rounded-lg border border-pz-line p-6 hover:border-pz-line hover:bg-pz-brand-soft transition-colors"
        >
          <div className="flex items-start justify-between mb-3">
            <h2 className="text-lg font-medium text-pz-ink group-hover:text-pz-body">
              Protokoll
            </h2>
          </div>
          <p className="text-sm text-pz-muted">
            Technisches Audit-Log (PII-frei, ohne E-Mail) der letzten Ereignisse.
          </p>
          <p className="mt-3 text-sm font-medium text-[var(--tenant-primary,var(--pz-brand))] group-hover:underline">
            Protokoll öffnen →
          </p>
        </Link>
        )}

        {/* Karte: QR-Verifizierung (ADR-014 Block 2) */}
        {isAdmin && (
        <Link
          href={`/${slugFromPath}/admin/verifizierung`}
          className="group rounded-lg border border-pz-line p-6 hover:border-pz-line hover:bg-pz-brand-soft transition-colors"
        >
          <div className="flex items-start justify-between mb-3">
            <h2 className="text-lg font-medium text-pz-ink group-hover:text-pz-body">
              QR-Verifizierung
            </h2>
          </div>
          <p className="text-sm text-pz-muted">
            QR-Codes erzeugen, mit denen sich Bürger:innen vor Ort
            wohnsitz-verifizieren (Stufe 2).
          </p>
          <p className="mt-3 text-sm font-medium text-[var(--tenant-primary,var(--pz-brand))] group-hover:underline">
            QR-Verifizierung öffnen →
          </p>
        </Link>
        )}

        {/* Karte: Abstimmungen (M5 Composer + Lebenszyklus; Beobachter: Lese-Ansicht) */}
        <Link
          href={`/${slugFromPath}/admin/abstimmungen`}
          className="group rounded-lg border border-pz-line p-6 hover:border-pz-line hover:bg-pz-brand-soft transition-colors"
        >
          <div className="flex items-start justify-between mb-3">
            <h2 className="text-lg font-medium text-pz-ink group-hover:text-pz-body">
              Abstimmungen
            </h2>
          </div>
          <p className="text-sm text-pz-muted">
            {isAdmin
              ? "Abstimmungen für Kommune oder Ortsteil erstellen, aktivieren und schließen. Verbindliche Abstimmungen nur für verifizierte Bürger:innen."
              : "Abstimmungen und Ergebnisse in Ihrem Bereich einsehen."}
          </p>
          <p className="mt-3 text-sm font-medium text-[var(--tenant-primary,var(--pz-brand))] group-hover:underline">
            {isAdmin ? "Abstimmungen verwalten →" : "Abstimmungen einsehen →"}
          </p>
        </Link>
      </div>
    </main>
  );
}
