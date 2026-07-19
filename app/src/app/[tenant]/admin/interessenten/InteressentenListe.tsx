"use client";

/**
 * InteressentenListe — Betreiber-Liste der Leads mit Status-Wechsel und
 * Hard-Delete (Block N3). Der Löschvorgang ist irreversibel → BestaetigungsDialog
 * (Block E). Status-Wechsel läuft über die super_admin-gated Server Action.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import BestaetigungsDialog from "../../BestaetigungsDialog";
import {
  interessentStatusSetzen,
  interessentLoeschen,
} from "@/lib/interessenten/admin-actions";

interface Eintrag {
  id: string;
  kommune: string | null;
  ansprechpartner: string;
  email: string;
  quelleLabel: string;
  termin: string | null;
  status: string;
  datum: string;
}

const STATUS_OPTIONEN: { wert: string; label: string }[] = [
  { wert: "neu", label: "Neu" },
  { wert: "kontaktiert", label: "Kontaktiert" },
  { wert: "pilot", label: "Pilot" },
  { wert: "abgelehnt", label: "Abgelehnt" },
];

export default function InteressentenListe({ eintraege }: { eintraege: Eintrag[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [loeschZiel, setLoeschZiel] = useState<Eintrag | null>(null);

  async function statusAendern(id: string, status: string) {
    setFehler(null);
    setBusyId(id);
    try {
      const res = await interessentStatusSetzen(id, status);
      if (!res.ok) {
        setFehler(res.error ?? "Konnte den Status nicht ändern.");
        return;
      }
      router.refresh();
    } catch {
      setFehler("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusyId(null);
    }
  }

  async function loeschenBestaetigt() {
    if (!loeschZiel) return;
    const id = loeschZiel.id;
    setFehler(null);
    setBusyId(id);
    try {
      const res = await interessentLoeschen(id);
      if (!res.ok) {
        setFehler(res.error ?? "Konnte den Eintrag nicht löschen.");
        return;
      }
      setLoeschZiel(null);
      router.refresh();
    } catch {
      setFehler("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {fehler && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {fehler}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b" style={{ borderColor: "var(--pz-line)" }}>
              {["Organisation", "Ansprechpartner", "E-Mail", "Quelle", "Termin", "Status", "Datum", ""].map(
                (h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-semibold"
                    style={{ color: "var(--pz-muted)" }}
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {eintraege.map((e) => (
              <tr key={e.id} className="border-b" style={{ borderColor: "var(--pz-line)" }}>
                <td className="px-3 py-2" style={{ color: "var(--pz-ink)" }}>
                  {e.kommune ?? "—"}
                </td>
                <td className="px-3 py-2" style={{ color: "var(--pz-ink)" }}>
                  {e.ansprechpartner}
                </td>
                <td className="px-3 py-2">
                  <a
                    href={`mailto:${e.email}`}
                    className="underline"
                    style={{ color: "var(--pz-brand)" }}
                  >
                    {e.email}
                  </a>
                </td>
                <td className="px-3 py-2" style={{ color: "var(--pz-body)" }}>
                  {e.quelleLabel}
                </td>
                <td className="px-3 py-2" style={{ color: "var(--pz-body)" }}>
                  {e.termin ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <label className="sr-only" htmlFor={`status-${e.id}`}>
                    Status ändern
                  </label>
                  <select
                    id={`status-${e.id}`}
                    value={e.status}
                    disabled={busyId === e.id}
                    onChange={(ev) => statusAendern(e.id, ev.target.value)}
                    className="rounded-md border px-2 py-1 text-sm"
                    style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                  >
                    {STATUS_OPTIONEN.map((o) => (
                      <option key={o.wert} value={o.wert}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 whitespace-nowrap" style={{ color: "var(--pz-muted)" }}>
                  {e.datum}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={busyId === e.id}
                    onClick={() => setLoeschZiel(e)}
                    className="pz-btn pz-btn-danger pz-btn-sm"
                  >
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BestaetigungsDialog
        offen={loeschZiel !== null}
        titel="Interessent löschen?"
        beschreibung={
          loeschZiel ? (
            <>
              Der Lead von <strong>{loeschZiel.ansprechpartner}</strong>
              {loeschZiel.kommune ? <> ({loeschZiel.kommune})</> : null} wird endgültig
              gelöscht. Dies kann nicht rückgängig gemacht werden.
            </>
          ) : undefined
        }
        bestaetigenLabel="Endgültig löschen"
        variante="gefahr"
        busy={busyId !== null && loeschZiel !== null && busyId === loeschZiel.id}
        onBestaetigen={loeschenBestaetigt}
        onAbbrechen={() => setLoeschZiel(null)}
      />
    </>
  );
}
