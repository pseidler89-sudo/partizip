/**
 * QrVerwaltung.tsx — Client-Komponente für die QR-Verifizierung (ADR-014 Block 2).
 *
 * - Formular: QR-Code erstellen (Scope, optional Scope-Code/Label, maxRedemptions,
 *   Gültigkeit in Stunden) → ruft die Server Action qrErstellen.
 * - Nach Erstellung: QR-Code als Bild + Einlöse-Link als Text GENAU EINMAL
 *   sichtbar (Hinweis: jetzt ausdrucken/teilen, wird nicht erneut angezeigt).
 * - Liste: bestehende QR-Codes mit Status (Einlösungen/Limit, Ablauf, widerrufen)
 *   + Widerrufen-Button.
 *
 * Der Server erzwingt canVerify + Tenant-Isolation; diese UI ist nur Komfort.
 */

"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { qrErstellen, qrWiderrufen } from "@/lib/verification/qr-actions";
import { regionTypLabel } from "@/lib/region/ebenen";

const SCOPE_LEVELS = ["ortsteil", "stadt", "kreis", "land"] as const;
type ScopeLevel = (typeof SCOPE_LEVELS)[number];

const SCOPE_LABELS: Record<ScopeLevel, string> = {
  ortsteil: "Ortsteil",
  stadt: "Kommune",
  kreis: "Kreis",
  land: "Land",
};

// Was die gewählte Ebene konkret bewirkt. Wichtig: Die Verifizierung (Stufe 2)
// ist bei JEDER Ebene gleich — nur „Ortsteil" ordnet die Person zusätzlich einem
// Ortsteil zu (für lokale Ortsteil-Abstimmungen). Sonst dient die Ebene als Label.
const SCOPE_HELP: Record<ScopeLevel, string> = {
  stadt: "Standard — passt für die meisten Aktionen (Bürgerbüro, Stadtfest). Bestätigt den Wohnsitz in der Kommune.",
  ortsteil:
    "Nur wenn Sie gezielt in einem Ortsteil verifizieren: Mit dem Ortsteil-Code wird die Person diesem Ortsteil zugeordnet und sieht/stimmt auch bei dessen lokalen Abstimmungen mit.",
  kreis: "Für kreisweite Aktionen. Bestätigt den Wohnsitz; ohne Ortsteil-Zuordnung.",
  land: "Für landesweite Aktionen. Bestätigt den Wohnsitz; ohne Ortsteil-Zuordnung.",
};

interface QrListItem {
  id: string;
  label: string | null;
  // ADR-024: Gebietsart + Name des QR-Knotens (statt scope_level/scope_code).
  regionTyp: string;
  regionName: string;
  redemptionCount: number;
  maxRedemptions: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

interface Props {
  liste: QrListItem[];
  /**
   * Gebietsbindung (Block K1), NUR UI-Komfort: die vom Server berechneten
   * erlaubten Eingabe-Ebenen des Callers (Admin: alle; Nicht-Admin-Verifier:
   * eigener Knoten und darunter). Die Durchsetzung passiert serverseitig in
   * qrErstellenCore — dieses Dropdown filtert nur die Auswahl.
   */
  erlaubteEbenen: ScopeLevel[];
}

interface ErstelltState {
  redeemUrl: string;
  qrDataUrl?: string;
  expiresAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusOf(q: QrListItem): { text: string; tone: "ok" | "warn" | "muted" } {
  if (q.revokedAt) return { text: "Widerrufen", tone: "muted" };
  if (new Date(q.expiresAt) <= new Date()) return { text: "Abgelaufen", tone: "muted" };
  if (q.redemptionCount >= q.maxRedemptions) return { text: "Aufgebraucht", tone: "warn" };
  return { text: "Aktiv", tone: "ok" };
}

export function QrVerwaltung({ liste, erlaubteEbenen }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Nur die für den Caller erlaubten Ebenen anbieten (Reihenfolge der UI-Liste
  // beibehalten). Vorbelegung „stadt" wie bisher — falls dem Caller nicht
  // erlaubt (z. B. reiner Ortsteil-Verifier), die erste erlaubte Ebene.
  const ebenen = SCOPE_LEVELS.filter((s) => erlaubteEbenen.includes(s));
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>(
    ebenen.includes("stadt") ? "stadt" : (ebenen[0] ?? "stadt"),
  );
  const [scopeCode, setScopeCode] = useState("");
  const [label, setLabel] = useState("");
  // Verifizierung 2.0: Einmal-Code — maxRedemptions ist serverseitig fest 1
  // (kein Eingabefeld mehr). Kurze Standard-Laufzeit (persönlich ausgehändigt).
  const [gueltigkeitStunden, setGueltigkeitStunden] = useState("1");

  const [formError, setFormError] = useState<string | null>(null);
  const [erstellt, setErstellt] = useState<ErstelltState | null>(null);
  const [revokeError, setRevokeError] = useState<Record<string, string>>({});

  function handleErstellen(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setErstellt(null);

    const std = Number(gueltigkeitStunden);
    if (!Number.isInteger(std) || std < 1) {
      setFormError("Gültigkeit muss eine ganze Zahl ≥ 1 (Stunden) sein.");
      return;
    }

    startTransition(async () => {
      const result = await qrErstellen({
        scopeLevel,
        scopeCode: scopeLevel === "ortsteil" && scopeCode.trim() ? scopeCode.trim() : null,
        label: label.trim() || null,
        // Einmal-Code: serverseitig auf 1 geklemmt (der Wert hier ist unerheblich).
        maxRedemptions: 1,
        gueltigkeitStunden: std,
      });
      if (!result.ok || !result.redeemUrl) {
        setFormError(result.error ?? "Erstellen fehlgeschlagen.");
        return;
      }
      setErstellt({
        redeemUrl: result.redeemUrl,
        qrDataUrl: result.qrDataUrl,
        expiresAt: result.expiresAt ?? "",
      });
      setLabel("");
      router.refresh();
    });
  }

  function handleWiderrufen(id: string) {
    setRevokeError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    startTransition(async () => {
      const result = await qrWiderrufen(id);
      if (!result.ok) {
        setRevokeError((prev) => ({ ...prev, [id]: result.error ?? "Widerruf fehlgeschlagen." }));
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-10">
      {/* Formular: QR-Code erstellen */}
      <section className="pz-card p-5">
        <h2 className="text-lg font-medium" style={{ color: "var(--pz-ink)" }}>
          QR-Code erstellen
        </h2>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
          Der QR-Code ist nach dem Erstellen GENAU EINMAL sichtbar — bitte direkt
          ausdrucken oder am Bildschirm zeigen und der Person aushändigen.
        </p>

        {/* Hand-an-die-Hand-Erklärung: was der Code tut + wer was sieht. */}
        <div
          className="mt-4 rounded-lg border p-4 text-sm"
          style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-body)" }}
        >
          <p className="font-semibold" style={{ color: "var(--pz-ink)" }}>So funktioniert die Verifizierung</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li><strong>Einmal-Code:</strong> nach Ausweis-Prüfung persönlich ausgehändigt (Ausdruck oder Bildschirm). <strong>Nicht aushängen.</strong></li>
            <li>Die Person scannt ihn, meldet sich an und ist damit <strong>wohnsitz-verifiziert (Stufe 2)</strong> — für 24 Monate. Der Code gilt für <strong>genau eine</strong> Verifizierung.</li>
            <li>Erst mit Stufe 2 können sie an <strong>verbindlichen</strong> Abstimmungen teilnehmen. Fragen und Ergebnisse <strong>ansehen</strong> kann jede:r — auch ohne Verifizierung.</li>
          </ol>
          <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            Tipp: Bequemer ist der umgekehrte Weg — die Person zeigt ihren eigenen
            Verifizierungs-QR, den Sie mit der Kamera scannen. Dann ist kein
            Code-Ausdruck nötig.
          </p>
        </div>

        <form onSubmit={handleErstellen} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="scopeLevel" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                Ebene
              </label>
              <select
                id="scopeLevel"
                value={scopeLevel}
                onChange={(e) => setScopeLevel(e.target.value as ScopeLevel)}
                className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                style={{ borderColor: "var(--pz-line)" }}
              >
                {ebenen.map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABELS[s]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--pz-muted)" }}>
                {SCOPE_HELP[scopeLevel]}
              </p>
            </div>

            {scopeLevel === "ortsteil" && (
              <div>
                <label htmlFor="scopeCode" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                  Ortsteil-Code
                </label>
                <input
                  id="scopeCode"
                  type="text"
                  value={scopeCode}
                  onChange={(e) => setScopeCode(e.target.value)}
                  placeholder="z. B. OT-01"
                  className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                  style={{ borderColor: "var(--pz-line)" }}
                />
                <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--pz-muted)" }}>
                  Code des Ortsteils (siehe Region-Verwaltung). Leer lassen = nur Wohnsitz
                  bestätigen, ohne Ortsteil-Zuordnung.
                </p>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="label" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              Bezeichnung (optional)
            </label>
            <input
              id="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="z. B. Bürgerbüro Stand 1"
              className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              style={{ borderColor: "var(--pz-line)" }}
            />
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--pz-muted)" }}>
              Nur für Ihre eigene Übersicht (Ort/Anlass der Ausgabe). Bürger:innen sehen sie nicht.
            </p>
          </div>

          <div>
            <label htmlFor="gueltigkeit" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              Gültigkeit in Stunden (1–24)
            </label>
            <input
              id="gueltigkeit"
              type="number"
              min={1}
              max={24}
              value={gueltigkeitStunden}
              onChange={(e) => setGueltigkeitStunden(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] sm:max-w-xs"
              style={{ borderColor: "var(--pz-line)" }}
            />
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--pz-muted)" }}>
              Einmal-Code: Der Code verifiziert genau eine Person. Wählen Sie die
              Laufzeit kurz — er wird direkt vor Ort ausgehändigt und danach
              eingelöst. Danach läuft er automatisch ab.
            </p>
          </div>

          {formError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:opacity-50"
            style={{ backgroundColor: "var(--tenant-primary)" }}
          >
            {isPending ? "…" : "QR-Code erstellen"}
          </button>
        </form>

        {/* Ergebnis: QR + Link GENAU EINMAL */}
        {erstellt && (
          <div className="mt-6 rounded-lg border p-4" style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-brand-soft)" }}>
            <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
              Einmal-Code erstellt — jetzt der Person aushändigen (Ausdruck/Bildschirm).
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--pz-body)" }}>
              Dieser Code wird aus Sicherheitsgründen <strong>nicht erneut</strong>{" "}
              angezeigt. {erstellt.expiresAt && `Gültig bis ${formatDate(erstellt.expiresAt)}.`}
            </p>

            {erstellt.qrDataUrl && (
              <div className="mt-4 flex justify-center">
                <Image
                  src={erstellt.qrDataUrl}
                  alt="QR-Code zur Wohnsitz-Verifizierung"
                  width={240}
                  height={240}
                  unoptimized
                  className="rounded-md bg-pz-surface p-2"
                />
              </div>
            )}

            <label htmlFor="qr-redeem-url" className="mt-4 block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              Einlöse-Link
            </label>
            <input
              id="qr-redeem-url"
              type="text"
              readOnly
              value={erstellt.redeemUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="mt-1 w-full rounded-md border bg-pz-surface px-3 py-1.5 font-mono text-xs"
              style={{ borderColor: "var(--pz-line)" }}
            />
          </div>
        )}
      </section>

      {/* Liste bestehender QR-Codes */}
      <section>
        <h2 className="text-lg font-medium" style={{ color: "var(--pz-ink)" }}>
          Bestehende QR-Codes
        </h2>
        {liste.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--pz-muted)" }}>
            Noch keine QR-Codes erstellt.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {liste.map((q) => {
              const st = statusOf(q);
              const aktiv = st.text === "Aktiv";
              return (
                <li key={q.id} className="pz-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
                        {q.label || "(ohne Bezeichnung)"}
                      </p>
                      <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                        {regionTypLabel(q.regionTyp)}
                        {q.regionTyp === "ortsteil" ? ` · ${q.regionName}` : ""} · {q.redemptionCount}/
                        {q.maxRedemptions} eingelöst · gültig bis {formatDate(q.expiresAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                        style={
                          st.tone === "ok"
                            ? { backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }
                            : st.tone === "warn"
                              ? { backgroundColor: "#fef3c7", color: "#92400e" }
                              : { backgroundColor: "var(--pz-line)", color: "var(--pz-muted)" }
                        }
                      >
                        {st.text}
                      </span>
                      {aktiv && (
                        <button
                          type="button"
                          onClick={() => handleWiderrufen(q.id)}
                          disabled={isPending}
                          className="pz-btn pz-btn-secondary pz-btn-sm"
                          style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                        >
                          Widerrufen
                        </button>
                      )}
                    </div>
                  </div>
                  {revokeError[q.id] && (
                    <p className="mt-2 text-xs text-red-700">{revokeError[q.id]}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
