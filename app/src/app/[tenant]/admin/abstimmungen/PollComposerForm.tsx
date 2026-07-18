/**
 * PollComposerForm.tsx — Client-Formular zum Anlegen einer Abstimmung (M5 / Block H).
 *
 * Ruft die Server-Action pollErstellen() auf (admin-gated, tenant-scoped) und
 * legt eine neue Umfrage als ENTWURF an. Erfolg/Fehler werden inline angezeigt,
 * router.refresh() holt die Übersicht frisch nach. Die Validierung hier ist nur
 * Komfort — die Action validiert/erzwingt alles serverseitig erneut.
 *
 * Block H: Die wählbaren Ziel-Gebiete kommen server-getrieben als `gebiete`-Feed
 * (erlaubteZielGebiete) — die eigene Rollen-Scheibe abwärts (Gemeinde + berechtigte
 * Ortsteile), NIE kreis/land. Der Ebenen-/Ortsteil-Picker rendert AUSSCHLIESSLICH
 * aus diesem Feed; die Durchsetzung liegt zusätzlich serverseitig in pollErstellen
 * (pollGebietErlaubt). scopeCode wird nur bei Ebene = Ortsteil übergeben.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { pollErstellen } from "@/lib/polls/actions";

/** Serialisierte Form eines Ziel-Gebiets aus erlaubteZielGebiete (Server). */
interface ZielGebietOption {
  regionId: string;
  typ: "gemeinde" | "ortsteil";
  label: string;
  scopeLevel: "stadt" | "ortsteil";
  scopeCode: string | null;
}

interface Props {
  /**
   * Vom Server berechnete erlaubte Ziel-Gebiete (Block H): Gemeinde-Knoten +
   * berechtigte Ortsteile der eigenen Rollen-Scheibe. Der Picker rendert nur
   * hieraus — enthält der Feed keinen Ortsteil, gibt es die Ebene „Ortsteil" nicht.
   */
  gebiete: ZielGebietOption[];
  /**
   * Demo-Mandant: der Ortsteil-Zweig ist bereits serverseitig aus dem Feed
   * gefiltert (Demo-Konto ohne Ortsteil-Anker sähe die Frage nie). Das Flag
   * doppelt-sichert die UI (kein Ortsteil-Angebot auf Demo).
   */
  demo?: boolean;
}

type ScopeLevel = "stadt" | "ortsteil";
type PollTyp = "ja_nein_enthaltung" | "dot_voting" | "widerstandsabfrage";

const DOT_MIN = 2;
const DOT_MAX = 12;

// Ebenen-Labels — deckungsgleich mit REGION_TYP_LABEL (lib/region/ebenen.ts):
// Eingabe „stadt" bildet den gemeinde-Knoten ab („Kommune"). Bewusst als lokale
// Konstante (kein Import der Schema-tragenden ebenen.ts in die Client-Bundle).
const EBENEN_LABEL: Record<ScopeLevel, string> = {
  stadt: "Kommune (alle Bürger:innen)",
  ortsteil: "Ortsteil",
};

export default function PollComposerForm({ gebiete, demo = false }: Props) {
  const router = useRouter();

  // Feed in wählbare Ebenen + Ortsteil-Knoten aufteilen. Demo-Fence zusätzlich
  // hart in der UI (der Feed ist serverseitig bereits gemeinde-only auf Demo).
  const hatStadt = gebiete.some((g) => g.scopeLevel === "stadt");
  const ortsteilGebiete = demo
    ? []
    : gebiete.filter((g) => g.scopeLevel === "ortsteil" && g.scopeCode);
  const hatOrtsteil = ortsteilGebiete.length > 0;
  const ebenen: ScopeLevel[] = [];
  if (hatStadt) ebenen.push("stadt");
  if (hatOrtsteil) ebenen.push("ortsteil");
  const keineGebiete = ebenen.length === 0;

  const [frage, setFrage] = useState("");
  const [typ, setTyp] = useState<PollTyp>("ja_nein_enthaltung");
  const [optionen, setOptionen] = useState<string[]>(["", ""]);
  const [punkteBudget, setPunkteBudget] = useState<number>(5);
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>(
    hatStadt ? "stadt" : (ebenen[0] ?? "stadt"),
  );
  const [scopeCode, setScopeCode] = useState<string>(
    ortsteilGebiete[0]?.scopeCode ?? "",
  );
  const [verbindlich, setVerbindlich] = useState(false);
  const [closesAt, setClosesAt] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (keineGebiete) {
      setError("Für Ihr Zuständigkeitsgebiet ist noch keine Ebene hinterlegt.");
      return;
    }
    if (frage.trim().length < 5) {
      setError("Bitte formulieren Sie eine etwas längere Frage (mind. 5 Zeichen).");
      return;
    }
    if (scopeLevel === "ortsteil" && !scopeCode) {
      setError("Bitte wählen Sie einen Ortsteil.");
      return;
    }
    const sauberOptionen = optionen.map((o) => o.trim()).filter((o) => o.length > 0);
    // Optionen-Validierung für beide Nicht-binär-Formate; Budget nur dot_voting.
    if (typ !== "ja_nein_enthaltung") {
      if (sauberOptionen.length < DOT_MIN) {
        setError(`Bitte mindestens ${DOT_MIN} Optionen angeben.`);
        return;
      }
      if (new Set(sauberOptionen.map((o) => o.toLowerCase())).size !== sauberOptionen.length) {
        setError("Die Optionen müssen sich unterscheiden.");
        return;
      }
    }
    if (typ === "dot_voting") {
      if (!Number.isInteger(punkteBudget) || punkteBudget < 1 || punkteBudget > 100) {
        setError("Das Punktebudget muss zwischen 1 und 100 liegen.");
        return;
      }
    }

    setSubmitting(true);
    try {
      const result = await pollErstellen({
        frage: frage.trim(),
        typ,
        // Optionen für beide Nicht-binär-Formate; Punktebudget nur dot_voting.
        ...(typ !== "ja_nein_enthaltung" ? { optionen: sauberOptionen } : {}),
        ...(typ === "dot_voting" ? { punkteBudget } : {}),
        scopeLevel,
        scopeCode: scopeLevel === "ortsteil" ? scopeCode : null,
        verbindlich,
        // datetime-local liefert "YYYY-MM-DDТHH:mm" (lokal) — leer ⇒ kein Enddatum.
        closesAt: closesAt ? new Date(closesAt) : null,
      });

      if (!result.ok) {
        setError(result.error ?? "Die Abstimmung konnte nicht angelegt werden.");
        return;
      }

      // Erfolg: Formular zurücksetzen, Hinweis zeigen, Übersicht neu laden.
      setSuccess(true);
      setFrage("");
      setVerbindlich(false);
      setClosesAt("");
      setScopeLevel(hatStadt ? "stadt" : (ebenen[0] ?? "stadt"));
      setTyp("ja_nein_enthaltung");
      setOptionen(["", ""]);
      setPunkteBudget(5);
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setSubmitting(false);
    }
  }

  const labelCls = "block text-sm font-medium";
  const inputCls =
    "mt-1 w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-1";

  const zeigeOrtsteilWarnung = verbindlich && scopeLevel === "ortsteil";

  return (
    <form onSubmit={handleSubmit} className="pz-card p-6">
      <h2 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
        Neue Abstimmung anlegen
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
        Die Abstimmung entsteht zunächst als <strong>Entwurf</strong>. Erst nach dem
        Aktivieren können Bürger:innen mitstimmen.
      </p>

      {keineGebiete && (
        <div
          className="mt-4 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: "var(--pz-line)", color: "var(--pz-muted)" }}
          role="status"
        >
          Für Ihr Zuständigkeitsgebiet ist noch keine Ebene hinterlegt. Bitte wenden
          Sie sich an die Plattform-Betreuung.
        </div>
      )}

      <div className="mt-5 space-y-5">
        {/* Frage */}
        <div>
          <label htmlFor="frage" className={labelCls} style={{ color: "var(--pz-ink)" }}>
            Frage
          </label>
          <textarea
            id="frage"
            value={frage}
            onChange={(e) => setFrage(e.target.value)}
            rows={3}
            minLength={5}
            maxLength={500}
            required
            placeholder="Z. B. Soll der Marktplatz autofrei werden?"
            className={inputCls}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          />
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            {frage.trim().length}/500 Zeichen (mind. 5)
          </p>
        </div>

        {/* Format (ADR-025) */}
        <div>
          <label htmlFor="typ" className={labelCls} style={{ color: "var(--pz-ink)" }}>
            Format
          </label>
          <select
            id="typ"
            value={typ}
            onChange={(e) => setTyp(e.target.value as PollTyp)}
            className={inputCls}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          >
            <option value="ja_nein_enthaltung">Ja / Nein / Enthaltung</option>
            <option value="dot_voting">Punkte-Voting (Prioritäten setzen)</option>
            <option value="widerstandsabfrage">Widerstandsabfrage (geringster Widerstand gewinnt)</option>
          </select>
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            {typ === "dot_voting"
              ? "Teilnehmende verteilen ein festes Punktebudget auf mehrere Optionen — Ergebnis ist eine Prioritätenverteilung."
              : typ === "widerstandsabfrage"
                ? "Teilnehmende bewerten jede Option mit Widerstand 0–10; es gewinnt die Option mit dem geringsten Gesamtwiderstand."
                : "Klassisches Stimmungsbild mit drei Antwortmöglichkeiten."}
          </p>
        </div>

        {/* Nicht-binäre Formate: Optionen (Budget nur bei Punkte-Voting) */}
        {typ !== "ja_nein_enthaltung" && (
          <div className="rounded-lg border p-4" style={{ borderColor: "var(--pz-line)" }}>
            <span className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
              Optionen ({DOT_MIN}–{DOT_MAX})
            </span>
            <div className="mt-2 space-y-2">
              {optionen.map((wert, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={wert}
                    maxLength={120}
                    onChange={(e) =>
                      setOptionen((arr) => arr.map((v, j) => (j === i ? e.target.value : v)))
                    }
                    aria-label={`Option ${i + 1}`}
                    placeholder={`Option ${i + 1}`}
                    className={inputCls}
                    style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)", marginTop: 0 }}
                  />
                  {optionen.length > DOT_MIN && (
                    <button
                      type="button"
                      onClick={() => setOptionen((arr) => arr.filter((_, j) => j !== i))}
                      aria-label={`Option ${i + 1} entfernen`}
                      className="shrink-0 rounded-md border px-2 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                      style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                    >
                      Entfernen
                    </button>
                  )}
                </div>
              ))}
            </div>
            {optionen.length < DOT_MAX && (
              <button
                type="button"
                onClick={() => setOptionen((arr) => [...arr, ""])}
                className="mt-2 text-sm font-medium underline-offset-4 hover:underline"
                style={{ color: "var(--pz-brand-strong)" }}
              >
                + Option hinzufügen
              </button>
            )}

            {typ === "dot_voting" && (
              <div className="mt-4">
                <label htmlFor="punkteBudget" className={labelCls} style={{ color: "var(--pz-ink)" }}>
                  Punkte je Teilnehmer:in
                </label>
                <input
                  id="punkteBudget"
                  type="number"
                  min={1}
                  max={100}
                  value={punkteBudget}
                  onChange={(e) => setPunkteBudget(Math.floor(Number(e.target.value) || 0))}
                  className={inputCls}
                  style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)", maxWidth: "8rem" }}
                />
                <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
                  Wie viele Punkte jede:r auf die Optionen verteilen darf (1–100).
                </p>
              </div>
            )}
          </div>
        )}

        {/* Ebene + (bei Ortsteil) Knoten — server-getriebener Picker (Block H) */}
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="scopeLevel" className={labelCls} style={{ color: "var(--pz-ink)" }}>
              Ebene
            </label>
            <select
              id="scopeLevel"
              value={scopeLevel}
              onChange={(e) => setScopeLevel(e.target.value as ScopeLevel)}
              disabled={keineGebiete}
              aria-describedby={zeigeOrtsteilWarnung ? "ortsteil-warnung" : undefined}
              className={inputCls}
              style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
            >
              {ebenen.map((s) => (
                <option key={s} value={s}>
                  {EBENEN_LABEL[s]}
                </option>
              ))}
            </select>
            {zeigeOrtsteilWarnung && (
              <p
                id="ortsteil-warnung"
                className="mt-1 text-xs"
                style={{ color: "var(--pz-warn-strong, #92400e)" }}
              >
                Hinweis: Eine <strong>verbindliche</strong> Ortsteil-Frage erreicht nur
                wohnsitz-verifizierte Bürger:innen dieses Ortsteils — die Wählerschaft
                kann dadurch klein oder (noch) leer sein.
              </p>
            )}
          </div>

          {/* Ortsteil-Auswahl, nur bei Ebene = Ortsteil (aus dem Feed) */}
          {scopeLevel === "ortsteil" && hatOrtsteil && (
            <div>
              <label htmlFor="scopeCode" className={labelCls} style={{ color: "var(--pz-ink)" }}>
                Ortsteil
              </label>
              <select
                id="scopeCode"
                value={scopeCode}
                onChange={(e) => setScopeCode(e.target.value)}
                className={inputCls}
                style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
              >
                {ortsteilGebiete.map((o) => (
                  <option key={o.regionId} value={o.scopeCode ?? ""}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Verbindlich */}
        <div className="rounded-lg border p-4" style={{ borderColor: "var(--pz-line)" }}>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={verbindlich}
              onChange={(e) => setVerbindlich(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
            />
            <span>
              <span className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
                Verbindliche Abstimmung
              </span>
              <span className="mt-0.5 block text-xs" style={{ color: "var(--pz-muted)" }}>
                Es stimmen nur wohnsitz-verifizierte Bürger:innen ab (Stufe 2). Ohne
                Haken ist es ein unverbindliches Stimmungsbild — alle angemeldeten
                Bürger:innen können teilnehmen. Auch dann zeigt das Ergebnis
                transparent, wie viele Stimmen von wohnsitz-verifizierten
                Bürger:innen stammen.
              </span>
            </span>
          </label>
        </div>

        {/* Enddatum (optional) */}
        <div>
          <label htmlFor="closesAt" className={labelCls} style={{ color: "var(--pz-ink)" }}>
            Endet am (optional)
          </label>
          <input
            id="closesAt"
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            className={inputCls}
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          />
          <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
            Ohne Angabe läuft die Abstimmung, bis Sie sie manuell schließen.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mt-5 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Abstimmung als Entwurf gespeichert. Sie finden sie unten unter „Entwürfe&ldquo;.
        </div>
      )}

      <div className="mt-6">
        <button
          type="submit"
          disabled={submitting || keineGebiete}
          className="inline-flex items-center rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: "var(--tenant-primary)" }}
        >
          {submitting ? "Wird gespeichert …" : "Als Entwurf anlegen"}
        </button>
      </div>
    </form>
  );
}
