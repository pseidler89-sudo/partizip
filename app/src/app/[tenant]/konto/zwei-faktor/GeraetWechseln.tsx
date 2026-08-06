/**
 * GeraetWechseln.tsx — Gerätewechsel für die Zwei-Faktor-Anmeldung (Client, #59).
 *
 * Sichtbar NUR, wenn die Session frisch bestätigt ist; die Seite daneben
 * entscheidet das serverseitig (page.tsx). Die Action prüft es erneut — diese
 * Komponente ist Bedienoberfläche, keine Sicherheitsgrenze.
 *
 * Zwei Klicks statt einem: Der erste öffnet die Warnung, erst der zweite setzt
 * zurück. Der Schritt ist nicht umkehrbar (alte Wiederherstellungscodes sind
 * danach wertlos), und er liegt auf einer Seite, die man auch aus Neugier
 * öffnet.
 *
 * Nach Erfolg ein voller Seiten-Neuaufbau (location.reload) statt eines
 * Client-Refresh: Der Aktiv-/Nicht-aktiv-Zustand wird serverseitig aus der
 * users-Zeile gerendert — die Seite muss ihn frisch lesen, sonst stünde der
 * Nutzer weiter vor dem Aktiv-Zustand eines Faktors, den es nicht mehr gibt.
 */

"use client";

import { useState, useTransition } from "react";
import { ShieldAlert } from "lucide-react";
import { zweitFaktorNeuEinrichten } from "@/lib/auth/totp-actions";

export default function GeraetWechseln() {
  const [offen, setOffen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function zuruecksetzen() {
    setFehler(null);
    startTransition(async () => {
      try {
        const r = await zweitFaktorNeuEinrichten();
        if (!r.ok) {
          setFehler(r.error);
          return;
        }
        window.location.reload();
      } catch {
        setFehler("Verbindungsfehler — bitte versuchen Sie es erneut.");
      }
    });
  }

  return (
    <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--pz-line)" }}>
      <p className="text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
        Gerät wechseln
      </p>
      <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
        Neues Telefon oder neue Authenticator-App? Setzen Sie die Zwei-Faktor-Anmeldung zurück und
        richten Sie sie danach in zwei Minuten neu ein.
      </p>

      {!offen ? (
        <>
          {fehler && (
            <p role="alert" className="mt-3 text-sm" style={{ color: "var(--pz-danger)" }}>
              {fehler}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setFehler(null);
              setOffen(true);
            }}
            className="pz-btn pz-btn-secondary mt-3"
          >
            Gerät wechseln
          </button>
        </>
      ) : (
        <div
          className="mt-3 rounded-xl p-4"
          style={{ backgroundColor: "var(--pz-warning-soft)", color: "var(--pz-warning-ink)" }}
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={2} />
            <div className="text-sm">
              <p className="font-semibold">Das lässt sich nicht rückgängig machen.</p>
              <p className="mt-1">
                Ihr bisheriger Authenticator und <strong>alle Ihre Wiederherstellungscodes</strong>{" "}
                werden ungültig. Bis zur neuen Einrichtung schützt Ihr Konto nur der Anmeldelink;
                Admin-Bereiche bleiben so lange gesperrt. Sie erhalten zum Abschluss zehn frische
                Wiederherstellungscodes.
              </p>
            </div>
          </div>

          {fehler && (
            <p role="alert" className="mt-3 text-sm" style={{ color: "var(--pz-danger)" }}>
              {fehler}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={zuruecksetzen}
              disabled={isPending}
              className="pz-btn pz-btn-primary"
            >
              {isPending ? "Wird zurückgesetzt …" : "Zurücksetzen und neu einrichten"}
            </button>
            <button
              type="button"
              onClick={() => {
                setFehler(null);
                setOffen(false);
              }}
              disabled={isPending}
              className="pz-btn pz-btn-secondary"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
