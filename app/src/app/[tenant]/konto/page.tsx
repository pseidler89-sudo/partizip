/**
 * [tenant]/konto/page.tsx — Dashboard mit "Meine Anliegen" (M8)
 *
 * Zeigt: User-Daten, gefolgten Anliegen (über anliegen_followers), Logout.
 * Stufe 1 erforderlich (eingeloggt).
 */

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KontoLoeschenSection } from "./KontoLoeschenSection";
import { BenachrichtigungSection } from "./BenachrichtigungSection";
import { EinrichtungsCheckliste } from "./EinrichtungsCheckliste";
import { FEATURE_ANLIEGEN_EINREICHEN } from "@/lib/features";
import type { EinrichtungsStatus } from "@/lib/konto/einrichtung";

type MeData = {
  user: {
    id: string;
    email: string;
    verificationStatus: string;
    // ADR-014 Block 2: Ablauf der Wohnsitz-Verifizierung (ISO oder null).
    residencyVerifiedUntil: string | null;
    // Benachrichtigungs-Motor: Opt-in-Status für E-Mails bei neuen Abstimmungen.
    notifyNewPolls: boolean;
    stufe: number;
    // Admin-Sichtbarkeit (kommune_admin/super_admin) für die Verwaltung-Karte.
    isAdmin?: boolean;
  };
  // Einrichtungs-Checkliste (Fläche A) — Booleans aus getEinrichtungsStatus.
  einrichtung?: EinrichtungsStatus;
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

  useEffect(() => {
    // loading wird über /api/me beendet (läuft immer). Die "Meine Anliegen"-
    // Liste wird nur geladen, wenn das Anliegen-Modul aktiv ist (ADR-014).
    fetch("/api/me")
      .then(async (res) => {
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
      })
      .catch(() => {
        setError("Verbindungsfehler.");
      })
      .finally(() => setLoading(false));

    if (FEATURE_ANLIEGEN_EINREICHEN) {
      fetch("/api/anliegen/followed")
        .then(async (res) => {
          if (!res.ok) return;
          const body = await res.json() as { anliegen: FollowedAnliegen[] };
          setFollowed(body.anliegen ?? []);
        })
        .catch(() => { /* ignorieren */ });
    }
  }, [router]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-400 text-sm">Lädt…</p>
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
        hint: "Ihre Wohnort-Verifizierung ist abgelaufen. Bitte verifizieren Sie sich erneut über einen QR-Code Ihrer Kommune (Stufe 2).",
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
      hint: "Sie sind mit bestätigter E-Mail dabei (Stufe 1) und können Anliegen einreichen. Die Wohnort-Verifikation (Stufe 2) erhalten Sie über einen QR-Code Ihrer Kommune.",
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

      {/* Einrichtungs-Checkliste (Fläche A): nur solange Schritte offen sind —
          danach verschwindet sie vollständig. Nicht auf dem Demo-Mandanten
          (Demo-Konten erfüllen die Schritte nie — die Karte wäre eine Sackgasse). */}
      {data.einrichtung && !data.einrichtung.alleErledigt && !data.tenant.istDemo && (
        <EinrichtungsCheckliste einrichtung={data.einrichtung} tenantSlug={data.tenant.slug} />
      )}

      {/* Kontodaten */}
      <div className="pz-card p-4 space-y-3 text-sm mb-6">
        <div className="flex justify-between">
          <span style={{ color: "var(--pz-muted)" }}>E-Mail</span>
          <span className="font-medium text-zinc-900">{data.user.email}</span>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:items-start">
          <span className="shrink-0" style={{ color: "var(--pz-muted)" }}>Status</span>
          <div className="text-right">
            <span className="inline-block rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {verificationInfo.badge}
            </span>
            <p className="mt-1 text-xs text-zinc-400 max-w-xs sm:text-right">
              {verificationInfo.hint}
            </p>
          </div>
        </div>
        <div className="flex justify-between">
          <span style={{ color: "var(--pz-muted)" }}>Stufe</span>
          <span className="font-medium text-zinc-900">{stufeLabel} ({data.user.stufe})</span>
        </div>
      </div>

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
          <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center">
            <div className="text-2xl" aria-hidden>📨</div>
            <p className="mt-2 text-sm font-medium text-zinc-700">Noch kein Anliegen eingereicht</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
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
                    <p className="text-xs text-zinc-400 font-mono mt-0.5">{a.trackingCode}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] ?? "bg-zinc-100 text-zinc-600"}`}>
                    {STATUS_LABELS[a.status] ?? a.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Benachrichtigungs-Motor: E-Mail bei neuen Abstimmungen (Opt-out). */}
      <BenachrichtigungSection initial={data.user.notifyNewPolls} />

      {/* Datenschutz: Auskunft (Export) */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--pz-ink)" }}>Meine Daten</h2>
        <a
          href={`/${data.tenant.slug}/konto/export`}
          download
          className="inline-block rounded-md border border-[color:var(--pz-line)] bg-white px-4 py-2 text-sm
                     font-medium text-zinc-700 hover:bg-zinc-50 transition-colors
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
        >
          Meine Daten exportieren
        </a>
        <p className="mt-1 text-xs text-zinc-400">
          Lädt alle zu Ihrem Konto gespeicherten Daten als JSON-Datei herunter
          (Auskunftsrecht, Art. 15 DSGVO).
        </p>
      </section>

      <button
        onClick={handleLogout}
        className="w-full rounded-md border border-[color:var(--pz-line)] bg-white px-4 py-2 text-sm
                   font-medium text-zinc-700 hover:bg-zinc-50 focus:outline-none
                   focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 transition-colors"
      >
        Abmelden
      </button>

      <KontoLoeschenSection />
    </main>
  );
}
