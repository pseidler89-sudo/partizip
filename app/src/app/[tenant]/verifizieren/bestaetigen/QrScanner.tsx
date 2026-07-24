/**
 * QrScanner.tsx — In-App-Scanner für den Verifizierer (PR-O2).
 *
 * Der Verifizierer scannt den Konto-QR des Bürgers DIREKT in der Seite (Kamera
 * in-app), statt die App zu verlassen. Diese Client-Komponente ist reines
 * UX-Frontend: sie extrahiert clientseitig NUR den proof-Token aus dem Scan (oder
 * aus einem manuell vorgelesenen Klartext-Code) und NAVIGIERT dann auf die
 * bestehende, unveränderte Bestätigungs-Seite `…/bestaetigen?proof=<token>`. Die
 * eigentliche Prüfung/Bestätigung (proofFuerAnzeige, Gebiet, N2-Checkliste,
 * verifizierungPerProofBestaetigen) bleibt komplett serverseitig — hier wird
 * NICHTS geprüft und der RAW-Token NIE geloggt (nur in die Ziel-URL geschrieben).
 *
 * Decoder hybrid: native `BarcodeDetector` wo verfügbar, sonst `@zxing/browser`
 * (dynamisch importiert, damit es den Haupt-Bundle nicht belastet). Manuelle
 * Eingabe ist IMMER erreichbar — auch wenn die Kamera nicht startet.
 *
 * Auto-Start-Entscheid: Der Erst-Start läuft bewusst per Button (der
 * getUserMedia-Berechtigungsdialog soll an eine Nutzergeste gebunden sein — auf
 * Mobil sonst unzuverlässig). Ist die Kamera-Berechtigung schon erteilt (typisch
 * bei „Nächste Person"), startet der Scanner via Permissions-API automatisch.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ScanLine, X } from "lucide-react";
import { extrahiereProofToken } from "@/lib/verification/proof-scan";

// --- Minimal-Typen für die (noch nicht in der TS-DOM-Lib enthaltene) native
//     BarcodeDetector-API. Nur was wir wirklich nutzen. -----------------------
interface ErkannterCode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<ErkannterCode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}
interface ZxingControls {
  stop(): void;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

export default function QrScanner({ tenantSlug }: { tenantSlug: string }) {
  const [scanning, setScanning] = useState(false);
  const [navigiert, setNavigiert] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [manuellCode, setManuellCode] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<ZxingControls | null>(null);
  const detektorRef = useRef<BarcodeDetectorLike | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Verhindert überlappende (asynchrone) detect()-Aufrufe im Poll-Intervall.
  const detektorBusyRef = useRef(false);
  // Aktiv-Flag: verhindert Doppel-Handling nach dem ersten Treffer und stoppt die
  // rAF-Schleife. Als Ref, damit Callbacks es ohne Neu-Binden lesen können.
  const aktivRef = useRef(false);
  // In-Flight-Sperre: wird SYNCHRON gesetzt, sobald ein starteKamera-Lauf beginnt,
  // und erst freigegeben, wenn getUserMedia aufgelöst ist (Erfolg/Fehler/Unmount).
  // Schließt das Re-Entrancy-Fenster VOR dem ersten await, in dem aktivRef/streamRef
  // noch nicht gesetzt sind (siehe starteKamera-Kopf).
  const startendRef = useRef(false);
  // Mounted-Flag: schützt gegen den Unmount-während-Kamera-Start-Race — wird die
  // Seite verlassen, WÄHREND getUserMedia/import/decodeFromStream noch laufen,
  // darf der danach erlangte Stream nicht ungestoppt bleiben (Kamera-Licht!).
  const montiertRef = useRef(true);
  useEffect(() => {
    montiertRef.current = true;
    return () => {
      montiertRef.current = false;
    };
  }, []);

  // --- Kamera-Lifecycle: ALLES stoppen (kein weiterlaufendes Kamera-Licht) ----
  const stoppeKamera = useCallback(() => {
    aktivRef.current = false;
    // Robustheit: In-Flight-Sperre freigeben (nach erfolgreichem Start schon false).
    startendRef.current = false;
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    detektorBusyRef.current = false;
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {
        /* zxing bereits gestoppt — egal */
      }
      controlsRef.current = null;
    }
    detektorRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* egal */
      }
      video.srcObject = null;
    }
    setScanning(false);
  }, []);

  // --- Treffer: Token ziehen, Kamera stoppen, zur Bestätigungs-Seite navigieren -
  const navigiereZuProof = useCallback(
    (token: string) => {
      aktivRef.current = false;
      stoppeKamera();
      setNavigiert(true);
      // window.location.assign erzwingt einen sauberen Server-Load der
      // Bestätigungs-Ansicht (serverseitige proof-Prüfung). Der Token steht NUR
      // hier in der URL — niemals im Log.
      window.location.assign(
        `/${tenantSlug}/verifizieren/bestaetigen?proof=${encodeURIComponent(token)}`,
      );
    },
    [stoppeKamera, tenantSlug],
  );

  const handleErkannt = useCallback(
    (rohwert: string) => {
      if (!aktivRef.current) return;
      const token = extrahiereProofToken(rohwert);
      // Unbekannter/fremder Code: NICHT abbrechen, einfach weiterscannen.
      if (!token) return;
      navigiereZuProof(token);
    },
    [navigiereZuProof],
  );

  // BarcodeDetector-Poll (nur nativer Pfad): alle ~250 ms einen Frame prüfen.
  const scanneFrame = useCallback(async () => {
    if (!aktivRef.current || detektorBusyRef.current) return;
    const video = videoRef.current;
    const detektor = detektorRef.current;
    if (!video || !detektor || video.readyState < 2) return;
    detektorBusyRef.current = true;
    try {
      const codes = await detektor.detect(video);
      if (aktivRef.current && codes.length > 0 && codes[0]?.rawValue) {
        handleErkannt(codes[0].rawValue); // stoppt bei Treffer alles
      }
    } catch {
      // Einzelne detect-Fehler (z. B. Frame nicht bereit) tolerieren.
    } finally {
      detektorBusyRef.current = false;
    }
  }, [handleErkannt]);

  const starteKamera = useCallback(async () => {
    // Re-Entrancy-Sperre (O2-a): Auto-Start (permissions.query) + Nutzer-Klick oder
    // ein schneller Doppelklick dürfen getUserMedia NICHT parallel starten — sonst
    // überschreibt der zweite Stream streamRef.current und der erste Track läuft
    // ungestoppt weiter (Kamera-Leuchte bleibt an). Der Guard prüft ZUSÄTZLICH
    // startendRef, das SYNCHRON (vor jedem await) gesetzt wird — damit ist auch das
    // Fenster geschlossen, in dem aktivRef/streamRef nach dem ersten await noch nicht
    // gesetzt sind. Sobald getUserMedia aufgelöst ist, greift der Guard über
    // aktivRef/streamRef (Dauer-Sperre bis stoppeKamera); startendRef ist nur die
    // kurzlebige In-Flight-Sperre und wird via finally IMMER freigegeben.
    // stoppeKamera setzt alle drei Refs zurück (regulärer Neustart bleibt möglich).
    if (aktivRef.current || streamRef.current || startendRef.current) return;
    startendRef.current = true;
    setFehler(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      startendRef.current = false;
      setFehler(
        "Ihr Browser unterstützt keinen Kamerazugriff. Bitte geben Sie den Code unten manuell ein.",
      );
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
    } catch {
      setFehler(
        "Kein Kamerazugriff möglich. Bitte erlauben Sie die Kamera oder geben Sie den Code unten manuell ein.",
      );
    } finally {
      // In-Flight-Sperre IMMER freigeben — egal ob getUserMedia Erfolg, Fehler oder
      // (nach dem await) Unmount folgt. Ab hier hält bei Erfolg streamRef/aktivRef den
      // Guard; die Übergabe passiert synchron (kein await), also lückenlos.
      startendRef.current = false;
    }
    if (!stream) return;
    // Race-Guard: Seite während getUserMedia verlassen → Stream sofort stoppen.
    if (!montiertRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    aktivRef.current = true;
    setScanning(true);

    const video = videoRef.current;
    const BarcodeDetector = getBarcodeDetectorCtor();

    if (video && BarcodeDetector) {
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* Autoplay-Restriktionen — Bild kommt trotzdem, weiter */
      }
      // Nach dem video.play()-await erneut prüfen (Unmount-Race).
      if (!montiertRef.current) {
        stoppeKamera();
        return;
      }
      try {
        detektorRef.current = new BarcodeDetector({ formats: ["qr_code"] });
      } catch {
        detektorRef.current = null;
      }
      if (detektorRef.current) {
        pollRef.current = setInterval(() => void scanneFrame(), 250);
        return;
      }
    }

    // Fallback: @zxing/browser (dynamisch importiert).
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader();
      controlsRef.current = (await reader.decodeFromStream(
        stream,
        video ?? undefined,
        (result) => {
          if (result) handleErkannt(result.getText());
        },
      )) as ZxingControls;
      // Nach den await-Punkten (import + decodeFromStream) erneut prüfen: bei
      // zwischenzeitlichem Unmount Reader UND Stream sofort stoppen.
      if (!montiertRef.current) {
        stoppeKamera();
        return;
      }
    } catch {
      stoppeKamera();
      setFehler(
        "Der QR-Scanner konnte nicht gestartet werden. Bitte geben Sie den Code unten manuell ein.",
      );
    }
  }, [scanneFrame, handleErkannt, stoppeKamera]);

  // Auto-Start nur bei bereits erteilter Kamera-Berechtigung (siehe Kopf).
  useEffect(() => {
    let abgebrochen = false;
    async function vielleichtAutoStart() {
      try {
        const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
        if (!perms?.query) return;
        const status = await perms.query({ name: "camera" as PermissionName });
        if (!abgebrochen && status.state === "granted") {
          void starteKamera();
        }
      } catch {
        // Permissions-API nicht verfügbar (Firefox/Safari): bewusst Button-Start.
      }
    }
    void vielleichtAutoStart();
    return () => {
      abgebrochen = true;
      stoppeKamera();
    };
  }, [starteKamera, stoppeKamera]);

  function handleManuell() {
    const token = extrahiereProofToken(manuellCode);
    if (!token) {
      setFehler("Bitte geben Sie einen gültigen Code ein.");
      return;
    }
    navigiereZuProof(token);
  }

  if (navigiert) {
    return (
      <div className="pz-card p-6 text-center">
        <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Code erkannt
        </h1>
        <p className="mt-2 text-sm" role="status" style={{ color: "var(--pz-body)" }}>
          Weiter zur Bestätigung …
        </p>
      </div>
    );
  }

  return (
    <div className="pz-card p-6">
      <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Person scannen
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        Bitten Sie die Person, ihren Verifizierungs-QR zu zeigen, und scannen Sie
        ihn mit der Kamera. Danach öffnet sich die Bestätigungs-Seite.
      </p>

      {/* Kamera-Bereich. Das <video> ist IMMER gemountet (nur bei aktivem Scan
          sichtbar), damit videoRef beim Kamera-Start bereits gesetzt ist —
          sonst liefe der Ref-Zugriff direkt nach setScanning ins Leere. */}
      <div className="mt-4">
        <div
          className={`relative overflow-hidden rounded-lg border ${scanning ? "block" : "hidden"}`}
          style={{ borderColor: "var(--pz-line)", backgroundColor: "#000" }}
        >
          {/* muted + playsInline: für Autoplay auf iOS/Safari nötig. */}
          <video
            ref={videoRef}
            className="block w-full"
            style={{ maxHeight: "60vh" }}
            muted
            autoPlay
            playsInline
            aria-label="Live-Kamerabild zum Scannen des Konto-QR-Codes"
          />
          <span className="sr-only" role="status" aria-live="polite">
            {scanning ? "Kamera aktiv. Richten Sie sie auf den QR-Code der Person." : ""}
          </span>
        </div>

        {scanning ? (
          <button
            type="button"
            onClick={stoppeKamera}
            className="pz-btn pz-btn-secondary pz-btn-sm mt-3 w-full"
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          >
            <X aria-hidden className="mr-1.5 h-4 w-4" strokeWidth={2} />
            Scan abbrechen
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void starteKamera()}
            className="pz-btn pz-btn-primary w-full"
          >
            <Camera aria-hidden className="mr-1.5 h-4 w-4" strokeWidth={2} />
            Person scannen
          </button>
        )}
      </div>

      {fehler && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {fehler}
        </div>
      )}

      {/* Manuelle Eingabe — IMMER erreichbar (Bürger liest den Klartext-Code vor). */}
      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--pz-line)" }}>
        <label
          htmlFor="proof-manuell"
          className="block text-xs font-medium"
          style={{ color: "var(--pz-body)" }}
        >
          Code manuell eingeben
        </label>
        <p id="proof-manuell-hint" className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
          Falls der QR nicht scannbar ist: Lassen Sie sich den Klartext-Code
          vorlesen und tippen Sie ihn hier ein.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            id="proof-manuell"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={manuellCode}
            onChange={(e) => setManuellCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleManuell();
              }
            }}
            aria-describedby="proof-manuell-hint"
            placeholder="Code"
            className="w-full rounded-md border px-3 py-2 font-mono text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          />
          <button
            type="button"
            onClick={handleManuell}
            disabled={manuellCode.trim().length === 0}
            className="pz-btn pz-btn-secondary shrink-0"
            style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
          >
            <ScanLine aria-hidden className="mr-1.5 h-4 w-4" strokeWidth={2} />
            Prüfen
          </button>
        </div>
      </div>
    </div>
  );
}
