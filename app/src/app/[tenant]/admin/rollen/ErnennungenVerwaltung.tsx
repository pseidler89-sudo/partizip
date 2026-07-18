/**
 * ErnennungenVerwaltung.tsx — Client-Komponente „Ausstehende Verifier-
 * Ernennungen“ (Block K3, Vier-Augen).
 *
 * Zeigt die OFFENEN Ernennungs-Vorschläge (nur wenn vorhanden — die Seite
 * rendert die Karte sonst gar nicht): Ziel-E-Mail (Admin-Fläche, tenant-intern
 * — wie die bestehenden Listen), Gebiet, vorgeschlagen von, Datum. Aktionen:
 *   - „Bestätigen“ (.pz-btn-primary, BestaetigungsDialog erklärt Vier-Augen).
 *     Für die VORSCHLAGENDE Person nur sichtbar, wenn selfApprovalAllowed
 *     (Pilot-Überbrückung ALLOW_SELF_APPROVAL) — der Server erzwingt die
 *     SoD-Sperre zusätzlich atomar (UI ist reiner Komfort).
 *   - „Ablehnen“ (.pz-btn-secondary, Dialog).
 *   - „Zurückziehen“ (nur für die vorschlagende Person sichtbar).
 *
 * Ruft die Server Actions verifierErnennungEntscheiden /
 * verifierErnennungZurueckziehen und aktualisiert via router.refresh().
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { regionTypLabel } from "@/lib/region/ebenen";
import {
  verifierErnennungEntscheiden,
  verifierErnennungZurueckziehen,
} from "@/lib/admin/appointment-actions";
import BestaetigungsDialog from "../../BestaetigungsDialog";

export interface Ernennung {
  id: string;
  targetUserId: string;
  targetEmail: string;
  roleType: string;
  regionTyp: string;
  regionName: string;
  proposedBy: string | null;
  proposedByEmail: string | null;
  /** ISO-String (serialisierbar über die RSC-Grenze). */
  proposedAt: string;
}

interface Props {
  ernennungen: Ernennung[];
  /** Eingeloggter Admin — steuert Sichtbarkeit von Bestätigen/Zurückziehen. */
  callerUserId: string;
  /** Serverseitig via isSelfApprovalAllowed() bestimmt (Pilot-Überbrückung). */
  selfApprovalAllowed: boolean;
}

type Dialog =
  | { art: "bestaetigen"; ernennung: Ernennung }
  | { art: "ablehnen"; ernennung: Ernennung }
  | { art: "zurueckziehen"; ernennung: Ernennung }
  | null;

export function ErnennungenVerwaltung({ ernennungen, callerUserId, selfApprovalAllowed }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  if (ernennungen.length === 0) return null;

  function handleBestaetigt() {
    const d = dialog;
    if (!d) return;
    startTransition(async () => {
      const result =
        d.art === "zurueckziehen"
          ? await verifierErnennungZurueckziehen({ appointmentId: d.ernennung.id })
          : await verifierErnennungEntscheiden({
              appointmentId: d.ernennung.id,
              entscheidung: d.art,
            });
      setRowMsg((prev) => ({
        ...prev,
        [d.ernennung.id]: result.ok
          ? { ok: true, text: result.message ?? "Aktion ausgeführt." }
          : { ok: false, text: result.error ?? "Aktion fehlgeschlagen." },
      }));
      setDialog(null);
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="rounded-lg border border-pz-line p-5" aria-busy={isPending}>
      <h2 className="text-lg font-medium text-pz-ink">Ausstehende Verifier-Ernennungen</h2>
      <p className="mt-1 text-sm text-pz-muted">
        Die Rolle Verifizierer:in wird zweistufig vergeben (Vier-Augen-Prinzip):
        Ein Vorschlag wird erst wirksam, wenn eine zweite Administratorin oder
        ein zweiter Administrator ihn bestätigt.
      </p>

      <div className="mt-4 space-y-3">
        {ernennungen.map((e) => {
          const istVorschlagender = e.proposedBy === callerUserId;
          // Gate-B MINOR: auch die BEGÜNSTIGTE Person bestätigt nie die eigene
          // Ernennung (außer Pilot-Überbrückung) — der Server erzwingt beides
          // zusätzlich atomar; die UI blendet den Button nur aus (Komfort).
          const istZiel = e.targetUserId === callerUserId;
          const darfBestaetigen = (!istVorschlagender && !istZiel) || selfApprovalAllowed;
          const msg = rowMsg[e.id];
          return (
            <div key={e.id} className="rounded-md bg-pz-page px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-pz-ink truncate">{e.targetEmail}</p>
                  <p className="mt-0.5 text-sm text-pz-muted">
                    Verifizierer:in · {regionTypLabel(e.regionTyp)}
                    {e.regionTyp === "ortsteil" ? ` (${e.regionName})` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-pz-muted">
                    Vorgeschlagen von {e.proposedByEmail ?? "einem gelöschten Konto"}
                    {istVorschlagender ? " (Sie)" : ""} am{" "}
                    {new Date(e.proposedAt).toLocaleDateString("de-DE")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {darfBestaetigen && (
                    <button
                      type="button"
                      onClick={() => setDialog({ art: "bestaetigen", ernennung: e })}
                      disabled={isPending}
                      className="pz-btn pz-btn-sm pz-btn-primary"
                    >
                      Bestätigen
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDialog({ art: "ablehnen", ernennung: e })}
                    disabled={isPending}
                    className="pz-btn pz-btn-sm pz-btn-secondary"
                  >
                    Ablehnen
                  </button>
                  {istVorschlagender && (
                    <button
                      type="button"
                      onClick={() => setDialog({ art: "zurueckziehen", ernennung: e })}
                      disabled={isPending}
                      className="pz-btn pz-btn-sm pz-btn-secondary"
                      style={{ color: "var(--pz-danger)" }}
                    >
                      Zurückziehen
                    </button>
                  )}
                </div>
              </div>

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

      {/* Dialoge — der Bestätigungs-Klick bleibt auch bei erlaubter
          Selbst-Bestätigung eine explizite, auditierte Handlung. */}
      <BestaetigungsDialog
        offen={dialog?.art === "bestaetigen"}
        titel="Ernennung bestätigen?"
        beschreibung={
          <>
            <strong>{dialog?.ernennung.targetEmail}</strong> erhält die Rolle
            Verifizierer:in und kann damit Wohnsitz-Verifizierungen durchführen.
            {(dialog?.ernennung.proposedBy === callerUserId ||
              dialog?.ernennung.targetUserId === callerUserId) &&
            selfApprovalAllowed ? (
              <>
                {" "}Hinweis: Sie bestätigen Ihren EIGENEN Vorschlag bzw. Ihre eigene
                Ernennung — das ist nur im Pilotbetrieb (Ein-Personen-Verwaltung)
                zulässig und wird im Protokoll sichtbar vermerkt.
              </>
            ) : (
              <>
                {" "}Mit Ihrer Bestätigung ist das Vier-Augen-Prinzip erfüllt: Vorschlag
                und Bestätigung stammen von zwei verschiedenen Personen.
              </>
            )}
          </>
        }
        bestaetigenLabel="Ernennung bestätigen"
        variante="normal"
        busy={isPending}
        onBestaetigen={handleBestaetigt}
        onAbbrechen={() => setDialog(null)}
      />
      <BestaetigungsDialog
        offen={dialog?.art === "ablehnen"}
        titel="Vorschlag ablehnen?"
        beschreibung={
          <>
            Der Ernennungs-Vorschlag für <strong>{dialog?.ernennung.targetEmail}</strong>{" "}
            wird abgelehnt — es wird keine Rolle vergeben. Die Entscheidung wird im
            Protokoll PII-frei erfasst.
          </>
        }
        bestaetigenLabel="Ablehnen"
        variante="normal"
        busy={isPending}
        onBestaetigen={handleBestaetigt}
        onAbbrechen={() => setDialog(null)}
      />
      <BestaetigungsDialog
        offen={dialog?.art === "zurueckziehen"}
        titel="Vorschlag zurückziehen?"
        beschreibung={
          <>
            Ihr Ernennungs-Vorschlag für <strong>{dialog?.ernennung.targetEmail}</strong>{" "}
            wird zurückgezogen — es wird keine Rolle vergeben. Sie können später
            jederzeit einen neuen Vorschlag anlegen.
          </>
        }
        bestaetigenLabel="Zurückziehen"
        variante="normal"
        busy={isPending}
        onBestaetigen={handleBestaetigt}
        onAbbrechen={() => setDialog(null)}
      />
    </section>
  );
}
