/**
 * [tenant]/konto/page.tsx — Dashboard mit "Meine Anliegen" (M8)
 *
 * Zeigt: User-Daten, gefolgten Anliegen (über anliegen_followers), Logout.
 * Stufe 1 erforderlich (eingeloggt).
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KontoLoeschenSection } from "./KontoLoeschenSection";
import { BenachrichtigungSection } from "./BenachrichtigungSection";
import { EinrichtungsCheckliste } from "./EinrichtungsCheckliste";
import { ProfilSection } from "./ProfilSection";
import { EmailAendernSection } from "./EmailAendernSection";
import { WohnortSection } from "./WohnortSection";
import { DatentransparenzPanel } from "./DatentransparenzPanel";
import { FEATURE_ANLIEGEN_EINREICHEN } from "@/lib/features";
import type { EinrichtungsStatus } from "@/lib/konto/einrichtung";
import type { OrtsteilOption } from "@/lib/region/queries";

type MeData = {
  user: {
    id: string;
    email: string;
    verificationStatus: string;
    // ADR-014 Block 2: Ablauf der Wohnsitz-Verifizierung (ISO oder null).
    residencyVerifiedUntil: string | null;
    // Benachrichtigungs-Motor: Opt-in-Status für E-Mails bei neuen Abstimmungen.
    notifyNewPolls: boolean;
    // Block J2c: granulare Opt-outs.
    notifyAnliegenUpdates: boolean;
    notifyReverify: boolean;
    // Block J2c: Wohnort. Roh-Ids + serverseitig aufgelöste, lesbare Pfade.
    homeRegionId: string | null;
    ortsteilId: string | null;
    residencyRegionId: string | null;
    homeRegionPfad: string | null;
    residencyRegionPfad: string | null;
    ortsteilOptionen: OrtsteilOption[];
    homeOrtsteilCode: string | null;
    stufe: number;
    // Admin-Sichtbarkeit (kommune_admin/super_admin) für die Verwaltung-Karte.
    isAdmin?: boolean;
    // Block J1: Rollenträger-Identität. Nur Rollenträger sehen die Klarname-
    // Sektion + den Nudge; Bürger bleiben pseudonym.
    istRollentraeger?: boolean;
    displayName?: string | null;
    funktion?: string | null;
  };
  // Einrichtungs-Checkliste (Fläche A) — Booleans aus getEinrichtungsStatus.
  // null auf dem Demo-Mandanten (serverseitig übersprungen).
  einrichtung?: EinrichtungsStatus | null;
  tenant: {
    slug: string;
    name: string;
    // Demo-Mandant: dort keine Checkliste (Demo-Konten erfüllen die Schritte nie).
    istDemo?: boolean;
  };
};

type FollowedAnliegen = {
  id: string;
  trackingCode: string;
  titel: string;
  status: string;
};

const STATUS_LABELS: Record<string, string> = {
  eingegangen: "Eingegangen",
  in_pruefung: "In Prüfung",
  im_gremium: "Im Gremium",
  beantwortet: "Beantwortet",
  umgesetzt: "Umgesetzt",
  abgelehnt: "Abgelehnt",
};

const STATUS_COLORS: Record<string, string> = {
  eingegangen: "pz-badge-info",
  in_pruefung: "pz-badge-warning",
  im_gremium: "pz-badge-warning",
  beantwortet: "pz-badge-success",
  umgesetzt: "pz-badge-success",
  abgelehnt: "pz-badge-neutral",
};

export default function KontoPage() {
  const router = useRouter();
  const [data, setData] = useState<MeData | null>(null);
  const [followed, setFollowed] = useState<FollowedAnliegen[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // /api/me laden. Wird beim Mount aufgerufen und — nach einer Wohnort-Änderung —
  // erneut (die Client-Seite holt ihre Daten selbst; router.refresh() reicht nicht).
  const ladeMe = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/me");
      if (res.status === 401) {
        router.replace("/");
        return;
      }
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string } };
        setError(body?.error?.message ?? "Fehler beim Laden der Kontodaten.");
        return;
      }
      const body = await res.json() as MeData;
      setData(body);
    } catch {
      setError("Verbindungsfehler.");
    } finally {
      // Erstladung beenden; bei Re-Fetch (onChanged) bereits false → No-op.
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    // loading wird über /api/me beendet (läuft immer). Die "Meine Anliegen"-
    // Liste wird nur geladen, wenn das Anliegen-Modul aktiv ist (ADR-014).
    // Async-Closure: setState in ladeMe passiert erst nach `await` (deferred).
    void (async () => { await ladeMe(); })();

    if (FEATURE_ANLIEGEN_EINREICHEN) {
      fetch("/api/anliegen/followed")
        .then(async (res) => {
          if (!res.ok) return;
          const body = await res.json() as { anliegen: FollowedAnliegen[] };
          setFollowed(body.anliegen ?? []);
        })
        .catch(() => { /* ignorieren */ });
    }
  }, [ladeMe]);

  // Anker-Ziel (#benachrichtigungen, Checklisten-CTA) existiert erst NACH dem
  // /api/me-Fetch — der native Anker-Scroll des Browsers läuft daher ins Leere.
  // Nach dem Laden einmal manuell hinscrollen (Gate-B MINOR).
  useEffect(() => {
    if (data == null || typeof window === "undefined") return;
    if (window.location.hash === "#benachrichtigungen") {
      document.getElementById("benachrichtigungen")?.scrollIntoView({ block: "start" });
    }
  }, [data]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-pz-muted text-sm">Lädt…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <p className="text-red-600 text-sm">{error}</p>
      </main>
    );
  }

  if (!data) return null;

  const stufeLabel = ["Nicht eingeloggt", "Eingeloggt", "Verifiziert", "Erweitert"][data.user.stufe] ?? "Unbekannt";

  /**
   * Gibt Badge-Text und Erläuterungstext für den verificationStatus zurück.
   * Rohwerte wie "pending" werden so nie direkt in der UI angezeigt.
   */
  function getVerificationStatusInfo(
    status: string,
    stufe: number,
    residencyVerifiedUntil: string | null,
  ): { badge: string; hint: string } {
    // ADR-014 Block 2: Eine abgelaufene Verifizierung (status='verified', aber
    // Stufe < 2) wird als „abgelaufen" gezeigt — nicht mehr als verifiziert.
    if (status === "verified" && stufe < 2) {
      return {
        badge: "Wohnort-Verifikation abgelaufen",
        hint: "Ihre Wohnort-Verifizierung ist abgelaufen. Bitte verifizieren Sie sich erneut über eine Verifizierungsstelle in Ihrer Nähe (Stufe 2) — dort zeigen Sie vor Ort Ihren persönlichen Konto-QR.",
      };
    }
    if (status === "verified") {
      const bis = residencyVerifiedUntil
        ? new Date(residencyVerifiedUntil).toLocaleDateString("de-DE", {
            day: "2-digit",
            month: "long",
            year: "numeric",
          })
        : null;
      return {
        badge: bis ? `Wohnort verifiziert bis ${bis}` : "Wohnort verifiziert",
        hint: bis
          ? `Ihr Wohnort ist verifiziert (Stufe 2) — gültig bis ${bis}.`
          : "Ihr Wohnort wurde erfolgreich verifiziert (Stufe 2).",
      };
    }
    if (status === "rejected") {
      return {
        badge: "Verifikation abgelehnt",
        hint: "Die Wohnort-Verifikation konnte nicht abgeschlossen werden. Bitte kontaktieren Sie Ihre Gemeinde.",
      };
    }
    // pending (und unbekannte Werte) → ausstehend
    return {
      badge: "Wohnort-Verifikation ausstehend",
      hint: "Sie sind mit bestätigter E-Mail dabei (Stufe 1) und können Anliegen einreichen. Die Wohnort-Verifikation (Stufe 2) erhalten Sie über eine Verifizierungsstelle in Ihrer Nähe — dort zeigen Sie vor Ort Ihren persönlichen Konto-QR.",
    };
  }

  const verificationInfo = getVerificationStatusInfo(
    data.user.verificationStatus,
    data.user.stufe,
    data.user.residencyVerifiedUntil,
  );

  return (
    <main className="min-h-screen px-6 py-12 max-w-lg mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Mein Konto</h1>
        <p className="text-sm mt-1" style={{ color: "var(--pz-muted)" }}>{data.tenant.name}</p>
      </div>

      {/* Block J1 Nudge: Rollenträger ohne hinterlegten Klarnamen bekommen eine
          dezente Erinnerung (kein Blocker — weiche Durchsetzung, sonst sperrt sich
          der einzige Admin selbst aus) mit Deep-Link zur Namens-Sektion. */}
      {data.user.istRollentraeger && !data.user.displayName && (
        <div
          className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          role="note"
        >
          <p className="font-medium">Bitte hinterlegen Sie Ihren Klarnamen für Ihre Rolle.</p>
          <p className="mt-1 text-amber-800">
            Sie tragen eine Rolle auf dieser Plattform. Ohne Klarnamen erscheint bei
            Ihren Abstimmungen und Prüfungen nur der Name Ihrer Institution.{" "}
            <a href="#oeffentlicher-name" className="font-medium underline underline-offset-2">
              Jetzt eintragen
            </a>
            .
          </p>
        </div>
      )}

      {/* Einrichtungs-Checkliste (Fläche A): nur solange Schritte offen sind —
          danach verschwindet sie vollständig. Nicht auf dem Demo-Mandanten
          (Demo-Konten erfüllen die Schritte nie — die Karte wäre eine Sackgasse). */}
      {data.einrichtung && !data.einrichtung.alleErledigt && !data.tenant.istDemo && (
        <EinrichtungsCheckliste einrichtung={data.einrichtung} tenantSlug={data.tenant.slug} />
      )}

      {/* Kontodaten */}
      <div className="pz-card p-4 space-y-3 text-sm mb-6">
        <div className="flex justify-between gap-3">
          <span style={{ color: "var(--pz-muted)" }}>E-Mail</span>
          <span className="font-medium text-pz-ink break-all text-right">{data.user.email}</span>
        </div>
        {/* Block J2b: E-Mail-Adresse ändern (Magic-Link an die NEUE Adresse).
            Nicht auf dem Demo-Mandanten (Wechsel dort serverseitig gefenced). */}
        {!data.tenant.istDemo && (
          <div className="border-t border-pz-line pt-3">
            <EmailAendernSection />
          </div>
        )}
        <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:items-start">
          <span className="shrink-0" style={{ color: "var(--pz-muted)" }}>Status</span>
          <div className="text-right">
            <span className="pz-badge-neutral inline-block rounded-full px-2.5 py-0.5 text-xs font-medium">
              {verificationInfo.badge}
            </span>
            <p className="mt-1 text-xs text-pz-muted max-w-xs sm:text-right">
              {verificationInfo.hint}
            </p>
          </div>
        </div>
        <div className="flex justify-between">
          <span style={{ color: "var(--pz-muted)" }}>Stufe</span>
          <span className="font-medium text-pz-ink">{stufeLabel} ({data.user.stufe})</span>
        </div>
      </div>

      {/* Block J2c: Wohnort anzeigen + ändern (Anzeige-Wohnort = home_region_id;
          verbindlicher Wohnsitz = residency_region_id, schreibgeschützt). */}
      <WohnortSection
        tenantName={data.tenant.name}
        homeRegionPfad={data.user.homeRegionPfad}
        residencyRegionPfad={data.user.residencyRegionPfad}
        residencyVerifiedUntil={data.user.residencyVerifiedUntil}
        ortsteilOptionen={data.user.ortsteilOptionen}
        homeOrtsteilCode={data.user.homeOrtsteilCode}
        onChanged={ladeMe}
      />

      {/* Block J1: Öffentlicher Name — für Rollenträger (setzen/ändern/leeren)
          UND für Bestandsfälle (Gate-B 1b): ein herabgestufter Ex-Rollenträger
          ohne Rolle, aber mit noch hinterlegtem Namen, muss ihn selbst entfernen
          können (nurLeeren). Reine Bürger ohne PII sehen die Sektion nicht. */}
      {(data.user.istRollentraeger || data.user.displayName || data.user.funktion) && (
        <ProfilSection
          initialDisplayName={data.user.displayName ?? null}
          initialFunktion={data.user.funktion ?? null}
          nurLeeren={!data.user.istRollentraeger}
          onSaved={(displayName, funktion) =>
            setData((prev) =>
              prev ? { ...prev, user: { ...prev.user, displayName, funktion } } : prev,
            )
          }
        />
      )}

      {/* Verwaltung — nur für Admins (kommune_admin/super_admin). Discoverability;
          die Admin-Seiten erzwingen die Berechtigung weiterhin serverseitig. */}
      {data.user.isAdmin && (
        <Link
          href={`/${data.tenant.slug}/admin`}
          className="pz-card pz-card-hover mb-6 flex items-center justify-between gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
        >
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
              <span aria-hidden>🛠️</span> Verwaltung
            </p>
            <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
              Abstimmungen, Verifizierung (QR), Rollen, Anliegen, Protokoll.
            </p>
          </div>
          <span
            className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium"
            style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
          >
            Admin →
          </span>
        </Link>
      )}

      {/* Meine Anliegen — nur wenn das Anliegen-Modul aktiv ist (ADR-014). */}
      {FEATURE_ANLIEGEN_EINREICHEN && (
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>Meine Anliegen</h2>
          <Link
            href={`/${data.tenant.slug}/anliegen/neu`}
            className="text-xs hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
            style={{ color: "var(--pz-brand-strong)" }}
          >
            + Neues Anliegen
          </Link>
        </div>

        {followed.length === 0 ? (
          <div className="rounded-lg border border-dashed border-pz-line bg-pz-surface p-6 text-center">
            <div className="text-2xl" aria-hidden>📨</div>
            <p className="mt-2 text-sm font-medium text-pz-body">Noch kein Anliegen eingereicht</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-pz-muted">
              Sobald Sie ein Anliegen einreichen, erscheint es hier und Sie können
              seinen Status verfolgen. Den Tracking-Code schicken wir Ihnen zusätzlich
              per E-Mail.
            </p>
            <Link
              href={`/${data.tenant.slug}/anliegen/neu`}
              className="mt-3 inline-block text-sm font-medium hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              style={{ color: "var(--pz-brand-strong)" }}
            >
              Jetzt Anliegen einreichen →
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {followed.map((a) => (
              <Link
                key={a.id}
                href={`/${data.tenant.slug}/anliegen/${a.trackingCode}`}
                className="pz-card pz-card-hover block px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--pz-ink)" }}>{a.titel}</p>
                    <p className="text-xs text-pz-muted font-mono mt-0.5">{a.trackingCode}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] ?? "pz-badge-neutral"}`}>
                    {STATUS_LABELS[a.status] ?? a.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Benachrichtigungs-Motor: drei Opt-outs (Block J2c). */}
      <BenachrichtigungSection
        initialNewPolls={data.user.notifyNewPolls}
        initialAnliegenUpdates={data.user.notifyAnliegenUpdates}
        initialReverify={data.user.notifyReverify}
      />

      {/* Datenschutz: Auskunft (Export) */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--pz-ink)" }}>Meine Daten</h2>
        <a
          href={`/${data.tenant.slug}/konto/export`}
          download
          className="pz-btn pz-btn-secondary"
        >
          Meine Daten exportieren
        </a>
        <p className="mt-1 text-xs text-pz-muted">
          Lädt alle zu Ihrem Konto gespeicherten Daten als JSON-Datei herunter
          (Auskunftsrecht, Art. 15 DSGVO).
        </p>

        {/* Block J2c: Transparenz-Panel „Was wir sehen — und was nicht". */}
        <DatentransparenzPanel anliegenAktiv={FEATURE_ANLIEGEN_EINREICHEN} />
      </section>

      <button
        onClick={handleLogout}
        className="pz-btn pz-btn-secondary w-full"
      >
        Abmelden
      </button>

      <KontoLoeschenSection />
    </main>
  );
}
