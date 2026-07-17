/**
 * RollenVerwaltung.tsx — Client-Komponente für die Rollen-Verwaltung (Achse B).
 *
 * - Formular: Rolle zuweisen (Ziel-E-Mail + roleType-Auswahl; scopeLevel Default
 *   'stadt'). Es werden NUR die für den Caller erlaubten roleTypes angeboten
 *   (der Server erzwingt die Eskalationsgrenze ohnehin zusätzlich).
 * - Liste: User mit Rollen + Entzug-Buttons.
 *
 * Ruft die Server Actions assignRole / revokeRole und aktualisiert via
 * router.refresh().
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignRole, revokeRole } from "@/lib/admin/actions";
import { regionTypLabel } from "@/lib/region/ebenen";

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

const SCOPE_LEVELS = ["ortsteil", "stadt", "kreis", "land"] as const;
type ScopeLevel = (typeof SCOPE_LEVELS)[number];

interface RoleEntry {
  roleId: string;
  roleType: string;
  // ADR-024: Gebietsart + Name des Rollen-Knotens (statt scope_level/scope_code).
  regionTyp: string;
  regionName: string;
}

interface TenantUser {
  userId: string;
  email: string;
  accountStatus: string;
  roles: RoleEntry[];
}

interface Props {
  tenantSlug: string;
  users: TenantUser[];
  erlaubteRollen: string[];
}

export function RollenVerwaltung({ users, erlaubteRollen }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Formular-State
  const [targetEmail, setTargetEmail] = useState("");
  const [roleType, setRoleType] = useState(erlaubteRollen[0] ?? "user");
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>("stadt");
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Entzug-State (welche Rolle wird gerade entzogen + Fehlermeldung)
  const [revokeError, setRevokeError] = useState<Record<string, string>>({});

  function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    setFormMsg(null);
    startTransition(async () => {
      const result = await assignRole({ targetEmail, roleType, scopeLevel });
      if (!result.ok) {
        setFormMsg({ ok: false, text: result.error ?? "Zuweisung fehlgeschlagen." });
        return;
      }
      setFormMsg({ ok: true, text: result.message ?? "Rolle vergeben." });
      setTargetEmail("");
      router.refresh();
    });
  }

  function handleRevoke(roleId: string) {
    setRevokeError((prev) => {
      const next = { ...prev };
      delete next[roleId];
      return next;
    });
    startTransition(async () => {
      const result = await revokeRole({ roleId });
      if (!result.ok) {
        setRevokeError((prev) => ({ ...prev, [roleId]: result.error ?? "Entzug fehlgeschlagen." }));
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-10">
      {/* Formular: Rolle zuweisen */}
      <section className="rounded-lg border border-pz-line p-5">
        <h2 className="text-lg font-medium text-pz-ink">Rolle zuweisen</h2>
        <p className="mt-1 text-sm text-pz-muted">
          Die Person muss bereits ein Konto in dieser Kommune haben.
        </p>

        {erlaubteRollen.length === 0 ? (
          <p className="mt-4 text-sm" style={{ color: "var(--pz-warning-ink)" }}>
            Ihre Rolle erlaubt keine Rollen-Vergabe.
          </p>
        ) : (
          <form onSubmit={handleAssign} className="mt-4 space-y-4">
            <div>
              <label htmlFor="targetEmail" className="block text-xs font-medium text-pz-muted">
                E-Mail der Zielperson
              </label>
              <input
                id="targetEmail"
                type="email"
                required
                value={targetEmail}
                onChange={(e) => setTargetEmail(e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-pz-line px-3 py-1.5 text-sm
                           focus:border-pz-brand focus:outline-none"
                placeholder="person@beispiel.de"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="roleType" className="block text-xs font-medium text-pz-muted">
                  Rolle
                </label>
                <select
                  id="roleType"
                  value={roleType}
                  onChange={(e) => setRoleType(e.target.value)}
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
                <label htmlFor="scopeLevel" className="block text-xs font-medium text-pz-muted">
                  Geltungsbereich
                </label>
                <select
                  id="scopeLevel"
                  value={scopeLevel}
                  onChange={(e) => setScopeLevel(e.target.value as ScopeLevel)}
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
              disabled={isPending || !targetEmail.trim()}
              className="pz-btn pz-btn-sm pz-btn-primary"
            >
              {isPending ? "Wird gespeichert…" : "Rolle zuweisen"}
            </button>
          </form>
        )}
      </section>

      {/* Liste: User mit Rollen */}
      <section>
        <h2 className="text-lg font-medium text-pz-ink">Konten &amp; Rollen</h2>
        <p className="mt-1 text-sm text-pz-muted">
          {users.length} Konto{users.length !== 1 ? "en" : ""} in dieser Kommune.
        </p>

        <div className="mt-4 space-y-3">
          {users.map((u) => (
            <div key={u.userId} className="rounded-lg border border-pz-line px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-pz-ink truncate">{u.email}</p>
                  {u.accountStatus !== "active" && (
                    <span className="text-xs text-pz-muted">Status: {u.accountStatus}</span>
                  )}
                </div>
              </div>

              {u.roles.length === 0 ? (
                <p className="mt-2 text-sm text-pz-muted">Keine Rollen.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {u.roles.map((r) => {
                    const darfEntziehen = erlaubteRollen.includes(r.roleType);
                    return (
                      <li
                        key={r.roleId}
                        className="flex items-center justify-between gap-3 rounded-md bg-pz-page px-3 py-2"
                      >
                        <span className="text-sm text-pz-body">
                          <span className="font-medium">{ROLE_LABELS[r.roleType] ?? r.roleType}</span>
                          <span className="text-pz-muted">
                            {" "}· {regionTypLabel(r.regionTyp)}
                            {r.regionTyp === "ortsteil" ? ` (${r.regionName})` : ""}
                          </span>
                        </span>
                        {darfEntziehen ? (
                          <button
                            type="button"
                            onClick={() => handleRevoke(r.roleId)}
                            disabled={isPending}
                            className="pz-btn pz-btn-sm pz-btn-secondary"
                            style={{ color: "var(--pz-danger)" }}
                          >
                            Entziehen
                          </button>
                        ) : (
                          <span className="text-xs text-pz-muted">nicht verwaltbar</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Entzug-Fehler je Rolle anzeigen */}
              {u.roles.map((r) =>
                revokeError[r.roleId] ? (
                  <p key={`err-${r.roleId}`} className="mt-2 text-sm" style={{ color: "var(--pz-danger)" }}>
                    {revokeError[r.roleId]}
                  </p>
                ) : null
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
