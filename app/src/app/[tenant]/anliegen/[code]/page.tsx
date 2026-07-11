/**
 * [tenant]/anliegen/[code]/page.tsx — Öffentliche Status-Seite (Stufe 0)
 *
 * Zeigt: Titel, Ortsteil, Status-Badge, Zeitleiste der anliegen_events
 * KEINE creator-Infos (Datensparsamkeit)
 * 404 bei unbekanntem Code (kein Unterschied unbekannt vs. fremder Tenant)
 * Neutraler Wortlaut: "liegt seit X Monaten im Gremium" — reine Zeitangabe
 *
 * Bei ?neu=1: prominente Code-Anzeige mit Copy-Button und Datenschutz-Hinweis.
 *
 * Kein Login erforderlich (GET only).
 */

import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import { and, eq, asc } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { anliegen, anliegenEvents, ortsteile, sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { computeCreatorRef } from "@/lib/anliegen/creator-ref";
import { TrackingCodeAnzeige } from "./TrackingCodeAnzeige";
import { ZurueckziehenButton } from "./ZurueckziehenButton";

// M3: Status, aus denen ein Anliegen vom Ersteller zurückgezogen werden darf.
// Muss zu WITHDRAWABLE_STATES in src/lib/anliegen/actions.ts passen.
const WITHDRAWABLE_STATES = new Set([
  "eingegangen",
  "in_pruefung",
  "im_gremium",
  "beantwortet",
]);

interface PageProps {
  params: Promise<{ tenant: string; code: string }>;
  searchParams: Promise<{ neu?: string }>;
}

// Status-Labels: neutral, kein Vorwurf
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

function formatMonths(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 7) return "weniger als einer Woche";
  if (days < 30) return `${Math.floor(days / 7)} Woche${Math.floor(days / 7) !== 1 ? "n" : ""}`;
  const months = Math.floor(days / 30);
  return `${months} Monat${months !== 1 ? "en" : ""}`;
}

function neutralStatusHint(status: string, sinceDate: Date): string {
  const duration = formatMonths(sinceDate);
  switch (status) {
    case "eingegangen":
      return `Liegt seit ${duration} vor.`;
    case "in_pruefung":
      return `Wird seit ${duration} geprüft.`;
    case "im_gremium":
      return `Liegt seit ${duration} im Gremium.`;
    case "beantwortet":
      return `Wurde vor ${duration} beantwortet.`;
    case "umgesetzt":
      return `Wurde vor ${duration} umgesetzt.`;
    case "abgelehnt":
      return `Wurde vor ${duration} abgeschlossen.`;
    default:
      return "";
  }
}

export default async function AnliegenCodePage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath, code } = await params;
  const { neu } = await searchParams;
  const isNeu = neu === "1";
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  // Tenant-Prüfung: kein Unterschied zwischen unbekannt und falschem Tenant
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );

  // Anliegen laden (exakter Code-Match, tenant-scoped)
  const decodedCode = decodeURIComponent(code).toUpperCase();
  const anliegenRows = await db
    .select({
      id: anliegen.id,
      titel: anliegen.titel,
      status: anliegen.status,
      ortsteilId: anliegen.ortsteilId,
      createdAt: anliegen.createdAt,
      trackingCode: anliegen.trackingCode,
      verborgenAt: anliegen.verborgenAt,
      creatorRef: anliegen.creatorRef,
    })
    .from(anliegen)
    .where(
      and(
        eq(anliegen.trackingCode, decodedCode),
        eq(anliegen.tenantId, tenant.id)
      )
    )
    .limit(1);

  // 404 — kein Unterschied zwischen unbekannt und fremdem Tenant (Anti-Enumeration)
  if (anliegenRows.length === 0) notFound();

  const a = anliegenRows[0];

  // H2b: Verborgenes Anliegen — Existenz/Status sind ok, Inhalt nicht.
  if (a.verborgenAt) {
    return (
      <main className="min-h-screen px-4 py-10 max-w-2xl mx-auto">
        <div className="mb-6">
          <p className="text-xs font-mono text-zinc-400 mb-1">{a.trackingCode}</p>
        </div>
        <div className="pz-card p-6">
          <p className="text-sm" style={{ color: "var(--pz-body)" }}>
            Dieses Anliegen wurde von der Moderation ausgeblendet.
          </p>
        </div>
        <div className="mt-10 pt-4 border-t border-[color:var(--pz-line)]">
          <a
            href={`/${slugFromPath}/anliegen`}
            className="text-sm hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
            style={{ color: "var(--pz-muted)" }}
          >
            ← Anderen Code suchen
          </a>
        </div>
      </main>
    );
  }

  // M3: Ist der eingeloggte Betrachter der Ersteller? (Session-userId → creator_ref)
  let viewerIsCreator = false;
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    const tokenHash = sha256Hex(rawToken);
    const nowDate = new Date();
    const sessionRows = await db
      .select({
        userId: sessions.userId,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.tenantId, tenant.id)))
      .limit(1);
    const session = sessionRows[0];
    if (session && !session.revokedAt && session.expiresAt >= nowDate) {
      try {
        viewerIsCreator = computeCreatorRef(session.userId) === a.creatorRef;
      } catch {
        // ANLIEGEN_REF_SALT fehlt → Button bleibt aus, kein harter Fehler.
        viewerIsCreator = false;
      }
    }
  }

  const canWithdraw = viewerIsCreator && WITHDRAWABLE_STATES.has(a.status);

  // Ortsteil laden
  let ortsteilName: string | null = null;
  if (a.ortsteilId) {
    const ortsteilRows = await db
      .select({ name: ortsteile.name })
      .from(ortsteile)
      .where(and(eq(ortsteile.id, a.ortsteilId), eq(ortsteile.tenantId, tenant.id)))
      .limit(1);
    ortsteilName = ortsteilRows[0]?.name ?? null;
  }

  // Events laden (chronologisch)
  type EventRow = {
    id: string;
    status: string;
    quelle: string | null;
    notiz: string | null;
    createdAt: Date;
  };
  const events: EventRow[] = await db
    .select({
      id: anliegenEvents.id,
      status: anliegenEvents.status,
      quelle: anliegenEvents.quelle,
      notiz: anliegenEvents.notiz,
      createdAt: anliegenEvents.createdAt,
    })
    .from(anliegenEvents)
    .where(eq(anliegenEvents.anliegenId, a.id))
    .orderBy(asc(anliegenEvents.createdAt));

  // Letzter Status-Wechsel für Dauer-Hinweis
  const latestEvent = events[events.length - 1];
  const statusHint = latestEvent
    ? neutralStatusHint(a.status, latestEvent.createdAt)
    : "";

  return (
    <main className="min-h-screen px-4 py-10 max-w-2xl mx-auto">
      {/* Bei ?neu=1: Tracking-Code prominent anzeigen */}
      {isNeu && <TrackingCodeAnzeige trackingCode={a.trackingCode} />}

      {/* Header */}
      <div className="mb-6">
        <p className="text-xs font-mono text-zinc-400 mb-1">{a.trackingCode}</p>
        <h1 className="text-xl font-semibold leading-snug" style={{ color: "var(--pz-ink)" }}>{a.titel}</h1>
        {ortsteilName && (
          <p className="text-sm mt-1" style={{ color: "var(--pz-muted)" }}>{ortsteilName}</p>
        )}
      </div>

      {/* Status-Badge */}
      <div className="flex items-center gap-3 mb-6">
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[a.status] ?? "bg-zinc-100 text-zinc-700"}`}
        >
          {STATUS_LABELS[a.status] ?? a.status}
        </span>
        {statusHint && (
          <span className="text-sm" style={{ color: "var(--pz-muted)" }}>{statusHint}</span>
        )}
      </div>

      {/* Zeitleiste */}
      <div className="mt-6">
        <h2 className="text-sm font-medium mb-4" style={{ color: "var(--pz-ink)" }}>Verlauf</h2>
        <ol className="relative border-l border-zinc-200 space-y-6 ml-3">
          {events.map((ev) => (
            <li key={ev.id} className="ml-4">
              <div className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-white bg-zinc-400" />
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[ev.status] ?? "bg-zinc-100 text-zinc-700"}`}
                  >
                    {STATUS_LABELS[ev.status] ?? ev.status}
                  </span>
                  {ev.notiz && (
                    <p className="text-sm mt-1" style={{ color: "var(--pz-body)" }}>{ev.notiz}</p>
                  )}
                  {ev.quelle && (
                    <a
                      href={ev.quelle}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs hover:underline mt-1 inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                      style={{ color: "var(--pz-brand-strong)" }}
                    >
                      Quelldokument ansehen
                    </a>
                  )}
                </div>
                <time
                  dateTime={ev.createdAt.toISOString()}
                  className="shrink-0 text-xs text-zinc-400"
                >
                  {ev.createdAt.toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </time>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* M3: Zurückziehen — nur für den eingeloggten Ersteller, bei zurückziehbarem Status */}
      {canWithdraw && (
        <div className="mt-8 pt-6 border-t border-[color:var(--pz-line)]">
          <ZurueckziehenButton anliegenId={a.id} />
        </div>
      )}

      {/* Footer */}
      <div className="mt-10 pt-4 border-t border-[color:var(--pz-line)]">
        <a
          href={`/${slugFromPath}/anliegen`}
          className="text-sm hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          style={{ color: "var(--pz-muted)" }}
        >
          ← Anderen Code suchen
        </a>
      </div>
    </main>
  );
}
