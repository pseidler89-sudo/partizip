/**
 * RollenVerwaltung.tsx — Client-Komponente für die Rollen-Verwaltung (Achse B).
 *
 * - Formular: Rolle zuweisen (Ziel-E-Mail + roleType-Auswahl; scopeLevel Default
 *   'stadt'). Es werden NUR die für den Caller erlaubten roleTypes angeboten
 *   (der Server erzwingt die Eskalationsgrenze ohnehin zusätzlich).
 * - Liste: User mit Rollen + Entzug-Buttons.
 * - Block K2 (Konto-Sicherheit): je User-Karte (außer dem Caller selbst) ein
 *   dezenter „Konto"-Aktionsbereich — Sitzungen beenden, Sperren (mit
 *   Tipp-Bestätigung SPERREN), Entsperren, Offboarding (Tipp-Bestätigung
 *   OFFBOARDING) — plus eine eigene Karte „Konto per E-Mail sperren"
 *   (IR-Notfall für Bürger:innen ohne Rolle). Alle Aktionen laufen über
 *   BestaetigungsDialog; der Server erzwingt Eskalationsgrenze/Guards erneut.
 *
 * Ruft die Server Actions assignRole / revokeRole bzw. die Konto-Sicherheits-
 * Actions und aktualisiert via router.refresh().
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignRole, revokeRole } from "@/lib/admin/actions";
import {
  sessionsBeenden,
  kontoSperren,
  kontoEntsperren,
  offboarding,
  kontoSperrenPerEmail,
} from "@/lib/admin/konto-sicherheit-actions";
import { regionTypLabel } from "@/lib/region/ebenen";
import BestaetigungsDialog from "../../BestaetigungsDialog";

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
  /** Anzahl aktiver (nicht revozierter, nicht abgelaufener) Sitzungen — informativ. */
  aktiveSitzungen: number;
  roles: RoleEntry[];
}

interface Props {
  tenantSlug: string;
  users: TenantUser[];
  erlaubteRollen: string[];
  /** Eingeloggter Admin — auf der eigenen Karte werden KEINE Konto-Aktionen angeboten. */
  callerUserId: string;
}

/** Welcher Bestätigungs-Dialog ist offen? (K2-Konto-Aktionen) */
type KontoDialog =
  | { art: "sessions"; userId: string; email: string }
  | { art: "sperren"; userId: string; email: string }
  | { art: "entsperren"; userId: string; email: string }
  | { art: "offboarding"; userId: string; email: string }
  | { art: "sperrenPerEmail"; email: string }
  | null;

export function RollenVerwaltung({ users, erlaubteRollen, callerUserId }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Formular-State
  const [targetEmail, setTargetEmail] = useState("");
  const [roleType, setRoleType] = useState(erlaubteRollen[0] ?? "user");
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>("stadt");
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Entzug-State (welche Rolle wird gerade entzogen + Fehlermeldung)
  const [revokeError, setRevokeError] = useState<Record<string, string>>({});

  // K2: Konto-Aktions-State — Dialog + Ergebnis-Meldung je User-Karte.
  const [kontoDialog, setKontoDialog] = useState<KontoDialog>(null);
  const [kontoMsg, setKontoMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  // K2: „Konto per E-Mail sperren" (IR-Notfall-Karte)
  const [sperrEmail, setSperrEmail] = useState("");
  const [sperrEmailMsg, setSperrEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  /** Führt die im Dialog bestätigte Konto-Aktion aus (K2). */
  function handleKontoBestaetigt() {
    const dialog = kontoDialog;
    if (!dialog) return;
    startTransition(async () => {
      if (dialog.art === "sperrenPerEmail") {
        const result = await kontoSperrenPerEmail(dialog.email);
        setSperrEmailMsg(
          result.ok
            ? { ok: true, text: result.message ?? "Konto gesperrt." }
            : { ok: false, text: result.error ?? "Sperren fehlgeschlagen." },
        );
        if (result.ok) setSperrEmail("");
        setKontoDialog(null);
        if (result.ok) router.refresh();
        return;
      }

      const input = { targetUserId: dialog.userId };
      const result =
        dialog.art === "sessions"
          ? await sessionsBeenden(input)
          : dialog.art === "sperren"
            ? await kontoSperren(input)
            : dialog.art === "entsperren"
              ? await kontoEntsperren(input)
              : await offboarding(input);

      setKontoMsg((prev) => ({
        ...prev,
        [dialog.userId]: result.ok
          ? { ok: true, text: result.message ?? "Aktion ausgeführt." }
          : { ok: false, text: result.error ?? "Aktion fehlgeschlagen." },
      }));
      setKontoDialog(null);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-10" aria-busy={isPending}>
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
              <p
                className="text-sm"
                role={formMsg.ok ? undefined : "alert"}
                style={{ color: formMsg.ok ? "var(--pz-success)" : "var(--pz-danger)" }}
              >
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
          {users.map((u) => {
            const istCaller = u.userId === callerUserId;
            const istGesperrt = u.accountStatus === "locked";
            const istGeloescht = u.accountStatus === "deleted";
            const msg = kontoMsg[u.userId];
            return (
              <div key={u.userId} className="rounded-lg border border-pz-line px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-pz-ink truncate">
                      {u.email}
                      {istGesperrt && (
                        <span className="ml-2 inline-flex items-center rounded-full pz-badge-danger px-2.5 py-0.5 text-xs font-medium align-middle">
                          Gesperrt
                        </span>
                      )}
                    </p>
                    {!istGesperrt && u.accountStatus !== "active" && (
                      <span className="text-xs text-pz-muted">Status: {u.accountStatus}</span>
                    )}
                    <span className="block text-xs text-pz-muted">
                      {u.aktiveSitzungen === 1
                        ? "1 aktive Sitzung"
                        : `${u.aktiveSitzungen} aktive Sitzungen`}
                    </span>
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
                    <p
                      key={`err-${r.roleId}`}
                      className="mt-2 text-sm"
                      role="alert"
                      style={{ color: "var(--pz-danger)" }}
                    >
                      {revokeError[r.roleId]}
                    </p>
                  ) : null
                )}

                {/* K2: Konto-Sicherheits-Aktionen — nie auf dem eigenen Konto,
                    nie auf gelöschten Konten (der Server verweigert beides
                    ohnehin; die UI bietet es gar nicht erst an). */}
                {!istCaller && !istGeloescht && (
                  <div className="mt-3 border-t border-pz-line pt-3">
                    <p className="text-xs font-medium text-pz-muted">Konto</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setKontoDialog({ art: "sessions", userId: u.userId, email: u.email })
                        }
                        disabled={isPending}
                        className="pz-btn pz-btn-sm pz-btn-secondary"
                      >
                        Alle Sitzungen beenden
                      </button>
                      {u.accountStatus === "active" && (
                        <button
                          type="button"
                          onClick={() =>
                            setKontoDialog({ art: "sperren", userId: u.userId, email: u.email })
                          }
                          disabled={isPending}
                          className="pz-btn pz-btn-sm pz-btn-danger"
                        >
                          Konto sperren
                        </button>
                      )}
                      {istGesperrt && (
                        <button
                          type="button"
                          onClick={() =>
                            setKontoDialog({ art: "entsperren", userId: u.userId, email: u.email })
                          }
                          disabled={isPending}
                          className="pz-btn pz-btn-sm pz-btn-secondary"
                        >
                          Entsperren
                        </button>
                      )}
                      {u.roles.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setKontoDialog({ art: "offboarding", userId: u.userId, email: u.email })
                          }
                          disabled={isPending}
                          className="pz-btn pz-btn-sm pz-btn-danger"
                        >
                          Offboarding: alle Rollen + Sitzungen entfernen
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {msg && (
                  <p
                    className="mt-2 text-sm"
                    role={msg.ok ? undefined : "alert"}
                    style={{ color: msg.ok ? "var(--pz-success)" : "var(--pz-danger)" }}
                  >
                    {msg.text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* K2: IR-Notfall — Konto per E-Mail sperren (Bürger:in ohne Rolle) */}
      <section className="rounded-lg border border-pz-line p-5">
        <h2 className="text-lg font-medium text-pz-ink">Konto per E-Mail sperren</h2>
        <p className="mt-1 text-sm text-pz-muted">
          Für den Notfall (z.&nbsp;B. Missbrauch): sperrt ein Bürgerkonto, das
          nicht in der Liste oben steht, anhand seiner E-Mail-Adresse. Die Sperre
          beendet sofort alle Sitzungen und ist umkehrbar.
        </p>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSperrEmailMsg(null);
            if (sperrEmail.trim()) {
              setKontoDialog({ art: "sperrenPerEmail", email: sperrEmail });
            }
          }}
        >
          <div className="min-w-0 grow">
            <label htmlFor="sperrEmail" className="block text-xs font-medium text-pz-muted">
              E-Mail des zu sperrenden Kontos
            </label>
            <input
              id="sperrEmail"
              type="email"
              required
              value={sperrEmail}
              onChange={(e) => setSperrEmail(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-pz-line px-3 py-1.5 text-sm
                         focus:border-pz-brand focus:outline-none"
              placeholder="person@beispiel.de"
            />
          </div>
          <button
            type="submit"
            disabled={isPending || !sperrEmail.trim()}
            className="pz-btn pz-btn-sm pz-btn-danger"
          >
            Konto sperren…
          </button>
        </form>
        {sperrEmailMsg && (
          <p
            className="mt-3 text-sm"
            role={sperrEmailMsg.ok ? undefined : "alert"}
            style={{ color: sperrEmailMsg.ok ? "var(--pz-success)" : "var(--pz-danger)" }}
          >
            {sperrEmailMsg.text}
          </p>
        )}
      </section>

      {/* K2: Bestätigungs-Dialoge der Konto-Aktionen */}
      <BestaetigungsDialog
        offen={kontoDialog?.art === "sessions"}
        titel="Alle Sitzungen beenden?"
        beschreibung={
          <>
            Alle aktiven Sitzungen von <strong>{kontoDialog?.email}</strong> werden
            sofort beendet — die Person wird auf allen Geräten abgemeldet und kann
            sich danach normal wieder anmelden. Konto und Rollen bleiben unverändert.
          </>
        }
        bestaetigenLabel="Sitzungen beenden"
        variante="normal"
        busy={isPending}
        onBestaetigen={handleKontoBestaetigt}
        onAbbrechen={() => setKontoDialog(null)}
      />
      <BestaetigungsDialog
        offen={kontoDialog?.art === "sperren" || kontoDialog?.art === "sperrenPerEmail"}
        titel="Konto sperren?"
        beschreibung={
          <>
            Das Konto <strong>{kontoDialog?.email}</strong> wird sofort gesperrt und
            alle aktiven Sitzungen werden beendet. Rollen bleiben bestehen, sind aber
            wirkungslos, solange die Sperre gilt. Die Sperre ist per
            &bdquo;Entsperren&ldquo; umkehrbar.
          </>
        }
        bestaetigenLabel="Konto sperren"
        tippBestaetigung="SPERREN"
        busy={isPending}
        onBestaetigen={handleKontoBestaetigt}
        onAbbrechen={() => setKontoDialog(null)}
      />
      <BestaetigungsDialog
        offen={kontoDialog?.art === "entsperren"}
        titel="Konto entsperren?"
        beschreibung={
          <>
            Die Sperre von <strong>{kontoDialog?.email}</strong> wird aufgehoben —
            die Person kann sich wieder anmelden und ihre Rollen gelten wieder.
          </>
        }
        bestaetigenLabel="Entsperren"
        variante="normal"
        busy={isPending}
        onBestaetigen={handleKontoBestaetigt}
        onAbbrechen={() => setKontoDialog(null)}
      />
      <BestaetigungsDialog
        offen={kontoDialog?.art === "offboarding"}
        titel="Offboarding durchführen?"
        beschreibung={
          <>
            Alle Rollen von <strong>{kontoDialog?.email}</strong> werden entfernt und
            alle aktiven Sitzungen beendet. Das Konto bleibt als Bürgerkonto aktiv —
            die Person kann weiterhin teilnehmen, hat aber keine Sonderrechte mehr.
          </>
        }
        bestaetigenLabel="Offboarding durchführen"
        tippBestaetigung="OFFBOARDING"
        busy={isPending}
        onBestaetigen={handleKontoBestaetigt}
        onAbbrechen={() => setKontoDialog(null)}
      />
    </div>
  );
}
