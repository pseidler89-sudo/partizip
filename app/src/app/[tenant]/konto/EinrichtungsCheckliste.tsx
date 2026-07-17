/**
 * EinrichtungsCheckliste.tsx — „Ihr Konto einrichten" (Fläche A der
 * Einrichtungs-Checkliste, Konto-Seite).
 *
 * Rein präsentational (Status kommt aus /api/me → getEinrichtungsStatus).
 * Leise und ehrlich: Text-Zähler statt Prozentbalken, keine Abzeichen, kein
 * Konfetti (Anti-Empörungs-Linie) — und die Karte verschwindet VOLLSTÄNDIG,
 * sobald alle Schritte erledigt sind (der Aufrufer rendert sie nur bei
 * !alleErledigt). Erledigte Schritte zeigen einen Haken (mit sr-Text),
 * offene sind Links zum jeweiligen Ort der Erledigung.
 */

"use client";

import Link from "next/link";
import type { EinrichtungsStatus } from "@/lib/konto/einrichtung";

interface Props {
  einrichtung: EinrichtungsStatus;
  tenantSlug: string;
}

/** Ein Eintrag der Checkliste: erledigt mit Haken, offen als Link + Nutzentext. */
function Schritt({
  erledigt,
  titel,
  nutzen,
  href,
}: {
  erledigt: boolean;
  titel: string;
  /** Was der Schritt konkret erweitert — nur bei offenen Schritten gezeigt. */
  nutzen?: string;
  /** Ziel des offenen Schritts (erledigte Schritte sind kein Link mehr). */
  href?: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      {erledigt ? (
        <span
          aria-hidden
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
          style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
        >
          ✓
        </span>
      ) : (
        <span
          aria-hidden
          className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2"
          style={{ borderColor: "var(--pz-line)" }}
        />
      )}
      <div className="min-w-0 text-sm">
        {erledigt ? (
          <span style={{ color: "var(--pz-body)" }}>
            <span className="sr-only">Erledigt: </span>
            {titel}
          </span>
        ) : (
          <>
            {href ? (
              <Link
                href={href}
                className="font-medium underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                style={{ color: "var(--pz-brand-strong)" }}
              >
                {titel} →
              </Link>
            ) : (
              <span className="font-medium" style={{ color: "var(--pz-ink)" }}>
                {titel}
              </span>
            )}
            {nutzen && (
              <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                {nutzen}
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function EinrichtungsCheckliste({ einrichtung, tenantSlug }: Props) {
  // Text-Zähler über die vier Einrichtungs-Schritte (Konto-erstellt zählt
  // nicht mit — es ist der Startpunkt, kein offener Schritt).
  const erledigt = [
    einrichtung.wohnortGesetzt,
    einrichtung.verifiziert,
    einrichtung.benachrichtigungAn,
    einrichtung.ersteTeilnahme,
  ].filter(Boolean).length;

  return (
    <section className="pz-card mb-6 p-5" aria-label="Ihr Konto einrichten">
      <h2 className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
        Ihr Konto einrichten
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
        {erledigt} von 4 Schritten erledigt
      </p>
      <ul className="mt-3 space-y-2.5">
        <Schritt erledigt titel="Konto erstellt" />
        <Schritt
          erledigt={einrichtung.wohnortGesetzt}
          titel="Wohnort festlegen"
          nutzen="Sie sehen zuerst die Fragen aus Ihrem Ortsteil und Ihrer Kommune."
          href={`/${tenantSlug}/umfragen`}
        />
        <Schritt
          erledigt={einrichtung.verifiziert}
          titel="Wohnsitz bestätigen"
          nutzen="Nur mit bestätigtem Wohnsitz zählen Sie bei verbindlichen Abstimmungen."
          href={`/${tenantSlug}/verifizieren`}
        />
        <Schritt
          erledigt={einrichtung.benachrichtigungAn}
          titel="Benachrichtigungen einschalten"
          nutzen="Sie erfahren per E-Mail, wenn eine neue Abstimmung in Ihrem Gebiet startet."
          href="#benachrichtigungen"
        />
        <Schritt
          erledigt={einrichtung.ersteTeilnahme}
          titel="Erste Abstimmung mitmachen"
          nutzen="Probieren Sie es einfach aus — unverbindliche Stimmungsbilder gehen ab Stufe 1."
          href={`/${tenantSlug}/umfragen`}
        />
      </ul>
    </section>
  );
}
