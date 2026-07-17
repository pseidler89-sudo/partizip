/**
 * EinladungenVerwaltung.tsx — Client-Komponente für den Einladungs-Bereich.
 *
 * - Formular: einladen (E-Mail + Rolle + Geltungsbereich). Es werden NUR die für
 *   den Caller erlaubten Rollen angeboten (der Server erzwingt die
 *   Eskalationsgrenze ohnehin zusätzlich — die UI ist reiner Komfort).
 * - Liste: offene/vergangene Einladungen mit Zurückziehen / Erneut senden für
 *   offene Einladungen.
 *
 * Ruft die Server Actions einladen / einladungZurueckziehen /
 * einladungErneutSenden und aktualisiert via router.refresh().
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { regionTypLabel } from "@/lib/region/ebenen";
import {
  einladen,
  einladungZurueckziehen,
  einladungErneutSenden,
} from "@/lib/admin/invitation-actions";

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

const STATUS_LABELS: Record<string, string> = {
  pending: "Offen",
  accepted: "Angenommen",
  revoked: "Zurückgezogen",
  expired: "Abgelaufen",
};

const SCOPE_LEVELS = ["ortsteil", "stadt", "kreis", "land"] as const;
type ScopeLevel = (typeof SCOPE_LEVELS)[number];

interface Einladung {
  id: string;
  email: string;
  roleType: string;
  // ADR-024: Gebietsart + Name des Rollen-Knotens (statt scope_level/scope_code).
  regionTyp: string;
  regionName: string;
  status: string;
  resendCount: number;
  expiresAt: string;
  createdAt: string;
}

interface Props {
  erlaubteRollen: string[];
  einladungen: Einladung[];
}

function istAbgelaufen(e: Einladung): boolean {
  return e.status === "pending" && new Date(e.expiresAt).getTime() <= Date.now();
}

function anzeigeStatus(e: Einladung): string {
  if (istAbgelaufen(e)) return STATUS_LABELS.expired;
  return STATUS_LABELS[e.status] ?? e.status;
}

export function EinladungenVerwaltung({ erlaubteRollen, einladungen }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [email, setEmail] = useState("");
  const [roleType, setRoleType] = useState(erlaubteRollen[0] ?? "user");
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>("stadt");
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  function handleEinladen(e: React.FormEvent) {
    e.preventDefault();
    setFormMsg(null);
    startTransition(async () => {
      const result = await einladen({ email, roleType, scopeLevel });
      if (!result.ok) {
        setFormMsg({ ok: false, text: result.error ?? "Einladung fehlgeschlagen." });
        return;
      }
      setFormMsg({ ok: true, text: result.message ?? "Einladung versendet." });
      setEmail("");
      router.refresh();
    });
  }

  function clearRowError(id: string) {
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function handleZurueckziehen(id: string) {
    clearRowError(id);
    startTransition(async () => {
      const result = await einladungZurueckziehen(id);
      if (!result.ok) {
        setRowError((prev) => ({ ...prev, [id]: result.error ?? "Zurückziehen fehlgeschlagen." }));
        return;
      }
      router.refresh();
    });
  }

  function handleErneutSenden(id: string) {
    clearRowError(id);
    startTransition(async () => {
      const result = await einladungErneutSenden(id);
      if (!result.ok) {
        setRowError((prev) => ({ ...prev, [id]: result.error ?? "Erneut senden fehlgeschlagen." }));
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-medium text-pz-ink">Mitwirkende einladen</h2>
        <p className="mt-1 text-sm text-pz-muted">
          Laden Sie Personen per E-Mail ein. Die eingeladene Person meldet sich mit
          der eingeladenen Adresse an und erhält die Rolle nach Annahme. Jede
          Einladung wird im Protokoll PII-frei erfasst.
        </p>
      </div>

      {/* Formular: einladen */}
      <section className="rounded-lg border border-pz-line p-5">
        <h3 className="text-base font-medium text-pz-ink">Neue Einladung</h3>

        {erlaubteRollen.length === 0 ? (
          <p className="mt-4 text-sm" style={{ color: "var(--pz-warning-ink)" }}>
            Ihre Rolle erlaubt keine Einladungen.
          </p>
        ) : (
          <form onSubmit={handleEinladen} className="mt-4 space-y-4">
            <div>
              <label htmlFor="inviteEmail" className="block text-xs font-medium text-pz-muted">
                E-Mail der einzuladenden Person
              </label>
              <input
                id="inviteEmail"
                type="email"
                required
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-pz-line px-3 py-1.5 text-sm
                           focus:border-pz-brand focus:outline-none"
                placeholder="person@beispiel.de"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="inviteRole" className="block text-xs font-medium text-pz-muted">
                  Rolle
                </label>
                <select
                  id="inviteRole"
                  value={roleType}
                  onChange={(ev) => setRoleType(ev.target.value)}
                  className="mt-1 w-full rounded-md border border-pz-line px-3 py-1.5 text-sm
                             focus:border-pz-brand focus:outline-none"
                >
                  {erlaubteRollen.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r] ?? r}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="inviteScope" className="block text-xs font-medium text-pz-muted">
                  Geltungsbereich
                </label>
                <select
                  id="inviteScope"
                  value={scopeLevel}
                  onChange={(ev) => setScopeLevel(ev.target.value as ScopeLevel)}
                  className="mt-1 w-full rounded-md border border-pz-line px-3 py-1.5 text-sm
                             focus:border-pz-brand focus:outline-none"
                >
                  {SCOPE_LEVELS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {formMsg && (
              <p className="text-sm" style={{ color: formMsg.ok ? "var(--pz-success)" : "var(--pz-danger)" }}>
                {formMsg.text}
              </p>
            )}

            <button
              type="submit"
              disabled={isPending || !email.trim()}
              className="pz-btn pz-btn-sm pz-btn-primary"
            >
              {isPending ? "Wird gesendet…" : "Einladung senden"}
            </button>
          </form>
        )}
      </section>

      {/* Liste: Einladungen */}
      <section>
        <h3 className="text-base font-medium text-pz-ink">Einladungen</h3>
        <p className="mt-1 text-sm text-pz-muted">
          {einladungen.length} Einladung{einladungen.length !== 1 ? "en" : ""}.
        </p>

        {einladungen.length === 0 ? (
          <p className="mt-4 text-sm text-pz-muted">Noch keine Einladungen.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {einladungen.map((e) => {
              const offen = e.status === "pending" && !istAbgelaufen(e);
              const darfVerwalten = erlaubteRollen.includes(e.roleType);
              return (
                <div key={e.id} className="rounded-lg border border-pz-line px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-pz-ink truncate">{e.email}</p>
                      <p className="mt-0.5 text-sm text-pz-muted">
                        <span className="font-medium">{ROLE_LABELS[e.roleType] ?? e.roleType}</span>
                        <span className="text-pz-muted">
                          {" "}· {regionTypLabel(e.regionTyp)}
                          {e.regionTyp === "ortsteil" ? ` (${e.regionName})` : ""}
                        </span>
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        offen
                          ? "pz-badge-warning"
                          : e.status === "accepted"
                            ? "pz-badge-success"
                            : "pz-badge-neutral"
                      }`}
                    >
                      {anzeigeStatus(e)}
                    </span>
                  </div>

                  {offen && darfVerwalten && (
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleErneutSenden(e.id)}
                        disabled={isPending}
                        className="pz-btn pz-btn-sm pz-btn-secondary"
                      >
                        Erneut senden
                      </button>
                      <button
                        type="button"
                        onClick={() => handleZurueckziehen(e.id)}
                        disabled={isPending}
                        className="pz-btn pz-btn-sm pz-btn-secondary"
                        style={{ color: "var(--pz-danger)" }}
                      >
                        Zurückziehen
                      </button>
                    </div>
                  )}

                  {rowError[e.id] && (
                    <p className="mt-2 text-sm" style={{ color: "var(--pz-danger)" }}>{rowError[e.id]}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
