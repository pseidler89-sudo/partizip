"use client";

/**
 * RegionEinstieg.tsx — die „Haustür" (ADR-015).
 *
 * Erster Schritt für neue Besucher: PLZ eingeben ODER Standort freigeben →
 * Region wird gemerkt (Cookie) und der Bürger sieht, was ihn betrifft. Niedrige
 * Schwelle, ohne Konto. Die Wahl wird gemerkt; „Region ändern" ist später möglich.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  regionAusPlz,
  regionAusKoordinaten,
  regionUebernehmen,
} from "@/lib/region/actions";

/**
 * variante:
 *  - "landing"    (Default): eigenständige Karte, anonymer Kontext — PLZ landet
 *                 nur im Cookie („nur lokal").
 *  - "eingeloggt": rahmenlos (Eltern-Karte liefert den Rahmen); regionAusPlz
 *                 schreibt für Eingeloggte zusätzlich den Wohnknoten ins Konto
 *                 (home_region_id) → der Datenschutz-Hinweis muss das ehrlich sagen.
 */
export function RegionEinstieg({
  tenantName,
  variante = "landing",
}: {
  tenantName: string;
  variante?: "landing" | "eingeloggt";
}) {
  const router = useRouter();
  const [plz, setPlz] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  function handlePlzSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFehler(null);
    setHinweis(null);
    startTransition(async () => {
      const res = await regionAusPlz(plz);
      if (res.ok) {
        router.refresh();
        return;
      }
      if (res.nichtGefunden) {
        setHinweis(
          `Für diese PLZ läuft noch keine Beteiligung. Im Pilot ist ${tenantName} dabei — Sie können sich trotzdem umsehen.`
        );
        return;
      }
      setFehler(res.error ?? "Das hat nicht geklappt.");
    });
  }

  function handleStandort() {
    setFehler(null);
    setHinweis(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setFehler("Standort wird von Ihrem Browser nicht unterstützt. Bitte PLZ eingeben.");
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        startTransition(async () => {
          const res = await regionAusKoordinaten(latitude, longitude);
          setGeoBusy(false);
          if (res.ok) {
            router.refresh();
            return;
          }
          if (res.nichtGefunden) {
            setHinweis(
              `Wir konnten Ihren Standort keiner teilnehmenden Kommune zuordnen. Im Pilot ist ${tenantName} dabei — Sie können sich trotzdem umsehen.`
            );
            return;
          }
          setFehler(res.error ?? "Standort konnte nicht ausgewertet werden.");
        });
      },
      () => {
        setGeoBusy(false);
        setFehler("Standort-Freigabe nicht möglich. Bitte geben Sie Ihre PLZ ein.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  }

  function handleUebernehmen() {
    setFehler(null);
    startTransition(async () => {
      const res = await regionUebernehmen();
      if (res.ok) router.refresh();
      else setFehler(res.error ?? "Das hat nicht geklappt.");
    });
  }

  const busy = pending || geoBusy;

  return (
    <div
      className={
        variante === "eingeloggt"
          ? "text-left"
          : "mx-auto max-w-lg pz-card p-6 text-left"
      }
    >
      <form onSubmit={handlePlzSubmit} noValidate>
        <label htmlFor="plz" className="block text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
          Ihre Postleitzahl
        </label>
        {/* Funktions-Erklärung (P2 §Empf. 7): was die PLZ bewirkt — der Datenschutz-
            Hinweis steht weiterhin unten. */}
        <p id="plz-funktion" className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
          Ihre PLZ bestimmt, welche Abstimmungen Sie sehen.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            id="plz"
            name="plz"
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="z. B. 65232"
            value={plz}
            onChange={(e) => setPlz(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-[color:var(--pz-line)] bg-white px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
            style={{ color: "var(--pz-ink)" }}
            aria-describedby={`plz-funktion${fehler ? " plz-fehler" : hinweis ? " plz-hinweis" : ""}`}
          />
          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
            style={{ backgroundColor: "var(--tenant-primary)" }}
          >
            {pending ? "…" : "Weiter"}
          </button>
        </div>
      </form>

      <div className="mt-3 flex items-center gap-3">
        <span className="h-px flex-1" style={{ backgroundColor: "var(--pz-line)" }} aria-hidden />
        <span className="text-xs" style={{ color: "var(--pz-muted)" }}>oder</span>
        <span className="h-px flex-1" style={{ backgroundColor: "var(--pz-line)" }} aria-hidden />
      </div>

      <button
        type="button"
        onClick={handleStandort}
        disabled={busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--pz-line)] bg-white px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-zinc-50 disabled:opacity-60"
        style={{ color: "var(--pz-ink)" }}
      >
        <span aria-hidden>📍</span> {geoBusy ? "Standort wird ermittelt…" : "Meinen Standort verwenden"}
      </button>

      {fehler && (
        <p id="plz-fehler" className="mt-3 text-sm" style={{ color: "#b42318" }} role="alert">
          {fehler}
        </p>
      )}
      {hinweis && (
        <div id="plz-hinweis" className="mt-3 rounded-lg border border-dashed border-[color:var(--pz-line)] bg-zinc-50/60 p-3">
          <p className="text-sm" style={{ color: "var(--pz-body)" }}>{hinweis}</p>
          <button
            type="button"
            onClick={handleUebernehmen}
            disabled={busy}
            className="mt-2 text-sm font-semibold underline-offset-4 hover:underline disabled:opacity-60"
            style={{ color: "var(--pz-brand-strong)" }}
          >
            Trotzdem ansehen →
          </button>
        </div>
      )}

      {/* Tertiär: ohne eigene PLZ stöbern (Pitch-Publikum / Neugierige). Setzt die
          Pilotregion auf Kommune-Ebene — man sieht, „was so läuft", ohne Eingabe. */}
      <p className="mt-4 text-center text-sm" style={{ color: "var(--pz-muted)" }}>
        <button
          type="button"
          onClick={handleUebernehmen}
          disabled={busy}
          className="font-medium underline-offset-4 hover:underline disabled:opacity-60"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Nur umschauen? Beispielregion ansehen →
        </button>
      </p>

      <p className="mt-4 text-xs" style={{ color: "var(--pz-muted)" }}>
        {variante === "eingeloggt"
          ? "Ihr Wohnort wird in Ihrem Konto gespeichert und bestimmt Ihre Standard-Ansicht. Sie können ihn jederzeit ändern."
          : "Ihre PLZ wird nur lokal gespeichert, um Ihnen passende Abstimmungen zu zeigen. Kein Konto nötig."}
      </p>
    </div>
  );
}
