/**
 * AdminAnliegenDetail.tsx — Client-Komponente für Admin-Detail-Seite
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  changeAnliegenStatus,
  confirmMatch,
  rejectMatch,
  verbergenAnliegen,
  wiederherstellenAnliegen,
} from "@/lib/anliegen/actions";

const STATUS_OPTIONS = [
  { value: "eingegangen", label: "Eingegangen" },
  { value: "in_pruefung", label: "In Prüfung" },
  { value: "im_gremium", label: "Im Gremium" },
  { value: "beantwortet", label: "Beantwortet" },
  { value: "umgesetzt", label: "Umgesetzt" },
  { value: "abgelehnt", label: "Abgelehnt" },
];

const STATUS_COLORS: Record<string, string> = {
  eingegangen: "pz-badge-info",
  in_pruefung: "pz-badge-warning",
  im_gremium: "pz-badge-warning",
  beantwortet: "pz-badge-success",
  umgesetzt: "pz-badge-success",
  abgelehnt: "pz-badge-neutral",
};

const MATCH_STATUS_COLORS: Record<string, string> = {
  vorgeschlagen: "pz-badge-warning",
  bestaetigt: "pz-badge-success",
  verworfen: "pz-badge-neutral",
};

const MATCH_STATUS_LABELS: Record<string, string> = {
  vorgeschlagen: "Vorgeschlagen",
  bestaetigt: "Bestätigt",
  verworfen: "Verworfen",
};

interface AnliegenData {
  id: string;
  trackingCode: string;
  titel: string;
  beschreibung: string | null;
  status: string;
  ortsteilId: string | null;
  ortsteilName: string | null;
  createdAt: Date;
  updatedAt: Date;
  verborgenAt: Date | null;
  verborgenGrund: string | null;
}

interface EventData {
  id: string;
  status: string;
  quelle: string | null;
  notiz: string | null;
  createdAt: Date;
}

interface MatchData {
  id: string;
  risDocumentId: string;
  confidence: number;
  status: string;
  decidedAt: Date | null;
  docTitle: string | null;
  docSourceUrl: string;
}

interface Props {
  tenantSlug: string;
  anliegenId: string;
  anliegen: AnliegenData;
  events: EventData[];
  followerCount: number;
  matches: MatchData[];
}

export default function AdminAnliegenDetail({
  tenantSlug,
  anliegenId,
  anliegen: a,
  events,
  followerCount,
  matches,
}: Props) {
  const router = useRouter();
  const [newStatus, setNewStatus] = useState(a.status);
  const [quelleUrl, setQuelleUrl] = useState("");
  const [notiz, setNotiz] = useState("");
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSuccess, setStatusSuccess] = useState(false);
  const [matchAction, setMatchAction] = useState<Record<string, "confirming" | "rejecting" | null>>({});
  const [matchErrors, setMatchErrors] = useState<Record<string, string>>({});

  // H2b: Moderation (Verbergen / Wiederherstellen)
  const istVerborgen = a.verborgenAt !== null;
  const [grund, setGrund] = useState("");
  const [modSubmitting, setModSubmitting] = useState(false);
  const [modError, setModError] = useState<string | null>(null);

  async function handleVerbergen(e: React.FormEvent) {
    e.preventDefault();
    setModError(null);
    setModSubmitting(true);
    try {
      const result = await verbergenAnliegen(anliegenId, grund.trim());
      if (!result.ok) {
        setModError(result.error ?? "Verbergen fehlgeschlagen.");
        return;
      }
      setGrund("");
      router.refresh();
    } catch {
      setModError("Verbindungsfehler.");
    } finally {
      setModSubmitting(false);
    }
  }

  async function handleWiederherstellen() {
    setModError(null);
    setModSubmitting(true);
    try {
      const result = await wiederherstellenAnliegen(anliegenId);
      if (!result.ok) {
        setModError(result.error ?? "Wiederherstellen fehlgeschlagen.");
        return;
      }
      router.refresh();
    } catch {
      setModError("Verbindungsfehler.");
    } finally {
      setModSubmitting(false);
    }
  }

  async function handleStatusChange(e: React.FormEvent) {
    e.preventDefault();
    setStatusError(null);
    setStatusSuccess(false);
    setStatusSubmitting(true);

    try {
      const result = await changeAnliegenStatus({
        anliegenId,
        newStatus,
        quelleUrl: quelleUrl.trim() || null,
        notiz: notiz.trim() || null,
      });

      if (!result.ok) {
        setStatusError(result.error ?? "Fehler beim Statuswechsel.");
        return;
      }

      setStatusSuccess(true);
      setQuelleUrl("");
      setNotiz("");
      router.refresh();
    } catch {
      setStatusError("Verbindungsfehler.");
    } finally {
      setStatusSubmitting(false);
    }
  }

  async function handleConfirmMatch(matchId: string, withEvent: boolean) {
    setMatchAction(prev => ({ ...prev, [matchId]: "confirming" }));
    setMatchErrors(prev => ({ ...prev, [matchId]: "" }));

    try {
      const result = await confirmMatch(matchId, withEvent);
      if (!result.ok) {
        setMatchErrors(prev => ({ ...prev, [matchId]: result.error ?? "Fehler." }));
      } else {
        router.refresh();
      }
    } catch {
      setMatchErrors(prev => ({ ...prev, [matchId]: "Verbindungsfehler." }));
    } finally {
      setMatchAction(prev => ({ ...prev, [matchId]: null }));
    }
  }

  async function handleRejectMatch(matchId: string) {
    setMatchAction(prev => ({ ...prev, [matchId]: "rejecting" }));
    setMatchErrors(prev => ({ ...prev, [matchId]: "" }));

    try {
      const result = await rejectMatch(matchId);
      if (!result.ok) {
        setMatchErrors(prev => ({ ...prev, [matchId]: result.error ?? "Fehler." }));
      } else {
        router.refresh();
      }
    } catch {
      setMatchErrors(prev => ({ ...prev, [matchId]: "Verbindungsfehler." }));
    } finally {
      setMatchAction(prev => ({ ...prev, [matchId]: null }));
    }
  }

  return (
    <main className="min-h-screen px-4 py-10 max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <a href={`/${tenantSlug}/admin/anliegen`} className="text-sm text-pz-muted hover:text-pz-body">
            ← Zurück zur Liste
          </a>
        </div>
        <p className="text-xs font-mono text-pz-muted mb-1">{a.trackingCode}</p>
        <h1 className="text-xl font-semibold text-pz-ink">{a.titel}</h1>
        <div className="flex items-center gap-3 mt-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] ?? "pz-badge-neutral"}`}>
            {STATUS_OPTIONS.find(s => s.value === a.status)?.label ?? a.status}
          </span>
          {istVerborgen && (
            <span className="rounded-full px-2.5 py-0.5 text-xs font-medium bg-red-100 text-red-800">
              Verborgen
            </span>
          )}
          {a.ortsteilName && <span className="text-xs text-pz-muted">{a.ortsteilName}</span>}
          <span className="text-xs text-pz-muted">{followerCount} Follower</span>
        </div>
        {a.beschreibung && (
          <p className="text-sm text-pz-muted mt-3 leading-relaxed">{a.beschreibung}</p>
        )}
      </div>

      {/* Status ändern */}
      <section className="rounded-lg border border-pz-line p-5">
        <h2 className="text-sm font-semibold text-pz-body mb-4">Status ändern</h2>
        <form onSubmit={handleStatusChange} className="space-y-4">
          <div>
            <label htmlFor="anl-neuer-status" className="block text-xs font-medium text-pz-muted mb-1">Neuer Status</label>
            <select
              id="anl-neuer-status"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value)}
              className="w-full rounded-md border border-pz-line px-3 py-2 text-sm bg-pz-surface
                         focus:border-[color:var(--pz-brand)] focus:outline-none focus:ring-1 focus:ring-[color:var(--pz-brand)]"
            >
              {STATUS_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="anl-quelle" className="block text-xs font-medium text-pz-muted mb-1">
              Quelle (optional, http/https)
            </label>
            <input
              id="anl-quelle"
              type="url"
              value={quelleUrl}
              onChange={(e) => setQuelleUrl(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-md border border-pz-line px-3 py-2 text-sm
                         focus:border-[color:var(--pz-brand)] focus:outline-none focus:ring-1 focus:ring-[color:var(--pz-brand)]"
            />
          </div>
          <div>
            <label htmlFor="anl-notiz" className="block text-xs font-medium text-pz-muted mb-1">
              Notiz (optional)
            </label>
            <textarea
              id="anl-notiz"
              value={notiz}
              onChange={(e) => setNotiz(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Interne Anmerkung zum Statuswechsel"
              className="w-full rounded-md border border-pz-line px-3 py-2 text-sm resize-none
                         focus:border-[color:var(--pz-brand)] focus:outline-none focus:ring-1 focus:ring-[color:var(--pz-brand)]"
            />
          </div>

          {statusError && (
            <p className="text-sm text-red-600">{statusError}</p>
          )}
          {statusSuccess && (
            <p className="text-sm text-green-600">Status wurde aktualisiert.</p>
          )}

          <button
            type="submit"
            disabled={statusSubmitting || newStatus === a.status}
            className="rounded-md bg-[color:var(--pz-brand)] px-4 py-2 text-sm font-medium text-white
                       hover:bg-[color:var(--pz-brand-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {statusSubmitting ? "Wird gespeichert…" : "Status speichern"}
          </button>
        </form>
      </section>

      {/* H2b: Moderation (Verbergen / Wiederherstellen) */}
      <section className="rounded-lg border border-pz-line p-5">
        <h2 className="text-sm font-semibold text-pz-body mb-1">Moderation</h2>
        <p className="text-xs text-pz-muted mb-4">
          Ein verborgenes Anliegen ist öffentlich nicht mehr einsehbar (nur ein neutraler Hinweis).
          Der Grund wird intern gespeichert, nicht im Audit-Log.
        </p>

        {istVerborgen ? (
          <div className="space-y-3">
            <div className="rounded-md bg-red-50 border border-red-200 p-3">
              <p className="text-xs font-medium text-red-800">
                Dieses Anliegen ist verborgen.
              </p>
              {a.verborgenGrund && (
                <p className="text-sm text-pz-body mt-1">
                  Grund: {a.verborgenGrund}
                </p>
              )}
            </div>
            {modError && <p className="text-sm text-red-600">{modError}</p>}
            <button
              type="button"
              onClick={handleWiederherstellen}
              disabled={modSubmitting}
              className="pz-btn pz-btn-primary"
            >
              {modSubmitting ? "Wird wiederhergestellt…" : "Wiederherstellen"}
            </button>
          </div>
        ) : (
          <form onSubmit={handleVerbergen} className="space-y-3">
            <div>
              <label htmlFor="anl-verbergen-grund" className="block text-xs font-medium text-pz-muted mb-1">
                Grund (intern, 1–1000 Zeichen)
              </label>
              <textarea
                id="anl-verbergen-grund"
                value={grund}
                onChange={(e) => setGrund(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="z. B. beleidigender Inhalt, Spam, personenbezogene Daten"
                className="w-full rounded-md border border-pz-line px-3 py-2 text-sm resize-none
                           focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>
            {modError && <p className="text-sm text-red-600">{modError}</p>}
            <button
              type="submit"
              disabled={modSubmitting || grund.trim().length === 0}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white
                         hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {modSubmitting ? "Wird verborgen…" : "Anliegen verbergen"}
            </button>
          </form>
        )}
      </section>

      {/* Match-Vorschläge */}
      {matches.length > 0 && (
        <section className="rounded-lg border border-pz-line p-5">
          <h2 className="text-sm font-semibold text-pz-body mb-4">
            Dokument-Vorschläge ({matches.length})
          </h2>
          <p className="text-xs text-pz-muted mb-4">
            Semantisches Matching v1 — Mensch bestätigt. Kein automatischer Statuswechsel.
          </p>
          <div className="space-y-3">
            {matches.map((m) => (
              <div key={m.id} className="rounded-md border border-pz-line p-3 bg-pz-surface">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-pz-body truncate">
                      {m.docTitle ?? "Unbenanntes Dokument"}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-pz-muted">
                        Konfidenz: {(m.confidence * 100).toFixed(1)}%
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_STATUS_COLORS[m.status] ?? "pz-badge-neutral"}`}>
                        {MATCH_STATUS_LABELS[m.status] ?? m.status}
                      </span>
                    </div>
                    <a
                      href={m.docSourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[color:var(--pz-brand-strong)] hover:underline mt-1 inline-block"
                    >
                      Dokument öffnen ↗
                    </a>
                  </div>

                  {m.status === "vorgeschlagen" && (
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => handleConfirmMatch(m.id, false)}
                        disabled={!!matchAction[m.id]}
                        className="rounded px-2 py-1 text-xs bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        Bestätigen
                      </button>
                      <button
                        onClick={() => handleConfirmMatch(m.id, true)}
                        disabled={!!matchAction[m.id]}
                        className="rounded px-2 py-1 text-xs bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                        title="Bestätigen + Status auf Im Gremium setzen"
                      >
                        + Im Gremium
                      </button>
                      <button
                        onClick={() => handleRejectMatch(m.id)}
                        disabled={!!matchAction[m.id]}
                        className="pz-btn pz-btn-secondary pz-btn-sm"
                      >
                        Verwerfen
                      </button>
                    </div>
                  )}
                </div>
                {matchErrors[m.id] && (
                  <p className="text-xs text-red-600 mt-1">{matchErrors[m.id]}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Event-Zeitleiste */}
      <section>
        <h2 className="text-sm font-semibold text-pz-body mb-4">Verlauf</h2>
        <ol className="relative border-l border-pz-line space-y-4 ml-3">
          {events.map((ev) => (
            <li key={ev.id} className="ml-4">
              <div className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-white bg-pz-muted" />
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[ev.status] ?? "pz-badge-neutral"}`}>
                    {STATUS_OPTIONS.find(s => s.value === ev.status)?.label ?? ev.status}
                  </span>
                  {ev.notiz && <p className="text-sm text-pz-muted mt-1">{ev.notiz}</p>}
                  {ev.quelle && (
                    <a href={ev.quelle} target="_blank" rel="noopener noreferrer"
                       className="text-xs text-[color:var(--pz-brand-strong)] hover:underline mt-1 inline-block">
                      Quelle
                    </a>
                  )}
                </div>
                <time className="text-xs text-pz-muted shrink-0">
                  {ev.createdAt.toLocaleDateString("de-DE")}
                </time>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Links */}
      <div className="pt-4 border-t border-pz-line flex gap-4">
        <a
          href={`/${tenantSlug}/anliegen/${a.trackingCode}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[color:var(--pz-brand-strong)] hover:underline"
        >
          Öffentliche Statusseite ↗
        </a>
      </div>
    </main>
  );
}
