/**
 * BelegListe.tsx — Client-Suche über die veröffentlichte Beleg-Liste (D4).
 *
 * Reine Anzeige + Filter: die anonyme Code-Liste kommt fertig (sortiert) aus der
 * Server-Komponente. Der Filter läuft rein im Browser — es werden keine Eingaben
 * an den Server gesendet (kein Tracking, welcher Code gesucht wird).
 */

"use client";

import { useMemo, useState } from "react";
import { Search, CheckCircle2, XCircle } from "lucide-react";

export default function BelegListe({ codes }: { codes: string[] }) {
  const [q, setQ] = useState("");

  const suche = q.trim().toUpperCase();
  const treffer = useMemo(() => {
    if (!suche) return null;
    return codes.includes(suche);
  }, [suche, codes]);

  const gefiltert = useMemo(() => {
    if (!suche) return codes;
    return codes.filter((c) => c.includes(suche));
  }, [suche, codes]);

  return (
    <div>
      <label htmlFor="beleg-suche" className="sr-only">
        Beleg-Code suchen
      </label>
      <div
        className="flex items-center gap-2 rounded-lg border px-3 py-2.5"
        style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-surface)" }}
      >
        <Search aria-hidden className="h-[18px] w-[18px] shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
        <input
          id="beleg-suche"
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Ihren Code suchen, z. B. BELEG-7F3A-K29Q"
          className="w-full bg-transparent font-mono text-sm outline-none"
          style={{ color: "var(--pz-ink)" }}
        />
      </div>

      {suche && (
        <div
          role="status"
          className="mt-3 flex items-center gap-2.5 rounded-lg px-3.5 py-3 text-sm"
          style={
            treffer
              ? { backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }
              : { backgroundColor: "var(--pz-page)", color: "var(--pz-body)" }
          }
        >
          {treffer ? (
            <>
              <CheckCircle2 aria-hidden className="h-5 w-5 shrink-0" strokeWidth={2} />
              <span>
                <b>Gefunden.</b> Ihr Beleg ist in der Liste — Ihre Stimme ist
                nachweislich im Ergebnis enthalten.
              </span>
            </>
          ) : (
            <>
              <XCircle aria-hidden className="h-5 w-5 shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
              <span>
                Dieser Code ist (noch) nicht in der Liste. Prüfen Sie die Schreibweise
                — Belege haben das Format BELEG-XXXX-XXXX.
              </span>
            </>
          )}
        </div>
      )}

      <ul
        className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-sm sm:grid-cols-3"
        style={{ color: "var(--pz-body)" }}
      >
        {gefiltert.map((c) => (
          <li key={c} className={suche && c === suche ? "font-semibold" : undefined} style={suche && c === suche ? { color: "var(--pz-success-ink)" } : undefined}>
            {c}
          </li>
        ))}
      </ul>
      {gefiltert.length === 0 && (
        <p className="mt-4 text-sm" style={{ color: "var(--pz-muted)" }}>
          Kein Beleg passt zu Ihrer Suche.
        </p>
      )}
    </div>
  );
}
