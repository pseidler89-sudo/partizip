"use client";

/**
 * StellenListe.tsx — Bürger-Liste „Stellen in Ihrer Nähe" (Verifizierung 2.0 / V2).
 *
 * Walk-in-first: zeigt aktive Verifizierungs-Stellen mit Öffnungszeiten,
 * Kurz-Hinweis, Barrierefrei-Badge, Kontakt und (falls vorhanden) Distanz.
 * Standorte OHNE Termin-Pflicht sind ohne Termin während der Öffnungszeiten
 * nutzbar; Standorte MIT Termin-Pflicht führen zum bestehenden K1-Termin-Flow.
 *
 * Distanz-Referenzpunkt (Priorität, siehe SPEC V2):
 *  (a) Browser-Geolocation, OPT-IN — vollständig clientseitig: die Koordinaten
 *      verlassen den Browser NIE (nur die öffentlichen Standort-Koordinaten aus
 *      der Liste werden lokal via Haversine verglichen und neu sortiert).
 *  (b) sonst Region-Zentrum (serverseitig vorberechnete `distanzKm`).
 *  (c) sonst keine Distanz → einfache Liste (Reihenfolge vom Server).
 *
 * A11y: Liste als <ul>/<li>, Badges mit Text, Termin-CTA als echter Link,
 * Geolocation-Opt-in als Button mit aria-busy und role="status"-Rückmeldung.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { MapPin, Clock, Accessibility, Phone, Navigation } from "lucide-react";
import { haversineKm } from "@/lib/region/core";

export interface StelleVM {
  locationId: string;
  name: string;
  address: string | null;
  /** Server-formatierte, gruppierte Öffnungszeiten ("" = keine Angabe). */
  oeffnungszeitenText: string;
  /** Kurz-Hinweis (server-gekürzt, ~120). */
  hinweiseKurz: string | null;
  barrierefrei: boolean | null;
  kontakt: string | null;
  terminErforderlich: boolean;
  /** Öffentliche Standort-Koordinaten (für die clientseitige Geo-Sortierung). */
  lat: number | null;
  lon: number | null;
  /** Server-Distanz aus dem Region-Zentrum (Referenzpunkt b) — km oder null. */
  distanzKm: number | null;
}

/** „ca. N km" bzw. „weniger als 1 km"; null → kein Text. */
function distanzText(km: number | null): string | null {
  if (km == null) return null;
  if (km < 1) return "weniger als 1 km entfernt";
  return `ca. ${Math.round(km)} km entfernt`;
}

export default function StellenListe({
  stellen,
  tenantSlug,
}: {
  stellen: StelleVM[];
  tenantSlug: string;
}) {
  // Optionaler, rein clientseitiger Geo-Referenzpunkt (Opt-in). Wird NIE an den
  // Server gesendet.
  const [geo, setGeo] = useState<{ lat: number; lon: number } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoFehler, setGeoFehler] = useState<string | null>(null);

  // Wenn ein Geo-Referenzpunkt vorliegt, Distanzen clientseitig neu berechnen
  // und sortieren; sonst die Server-Reihenfolge/-Distanzen beibehalten.
  const sortiert = useMemo<StelleVM[]>(() => {
    if (!geo) return stellen;
    const mitDistanz = stellen.map((s) => ({
      ...s,
      distanzKm:
        s.lat != null && s.lon != null
          ? haversineKm(geo.lat, geo.lon, s.lat, s.lon)
          : null,
    }));
    mitDistanz.sort((a, b) => {
      if (a.distanzKm != null && b.distanzKm != null) {
        return a.distanzKm - b.distanzKm || a.name.localeCompare(b.name, "de");
      }
      if (a.distanzKm != null) return -1;
      if (b.distanzKm != null) return 1;
      return a.name.localeCompare(b.name, "de");
    });
    return mitDistanz;
  }, [geo, stellen]);

  function standortVerwenden() {
    setGeoFehler(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoFehler("Standort wird von Ihrem Browser nicht unterstützt.");
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGeoBusy(false);
      },
      () => {
        setGeoBusy(false);
        setGeoFehler("Standort-Freigabe nicht möglich. Die Liste bleibt wie sie ist.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  }

  // Nur anbieten, wenn mindestens ein Standort Koordinaten hat (sonst nutzlos).
  const geoMoeglich = stellen.some((s) => s.lat != null && s.lon != null);

  return (
    <div>
      {geoMoeglich && (
        <div className="mb-4">
          <button
            type="button"
            onClick={standortVerwenden}
            disabled={geoBusy}
            aria-busy={geoBusy}
            className="pz-btn pz-btn-secondary disabled:opacity-60"
            style={{ color: "var(--pz-ink)" }}
          >
            <Navigation aria-hidden className="h-[18px] w-[18px]" strokeWidth={2} />
            {geoBusy
              ? "Standort wird ermittelt…"
              : geo
                ? "Nach meinem Standort sortiert"
                : "Nach meinem Standort sortieren"}
          </button>
          <p className="mt-1.5 text-xs" style={{ color: "var(--pz-muted)" }}>
            Ihr Standort wird nur in Ihrem Browser verwendet und nicht gespeichert
            oder übertragen.
          </p>
          {geoFehler && (
            <p className="mt-1.5 text-xs" role="alert" style={{ color: "#b42318" }}>
              {geoFehler}
            </p>
          )}
        </div>
      )}

      <ul className="space-y-3">
        {sortiert.map((s) => {
          const dist = distanzText(s.distanzKm);
          return (
            <li key={s.locationId} className="pz-card p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
                  {s.name}
                </h3>
                {dist && (
                  <span
                    className="shrink-0 whitespace-nowrap text-xs font-medium"
                    style={{ color: "var(--pz-brand-strong)" }}
                  >
                    {dist}
                  </span>
                )}
              </div>

              {s.address && (
                <p className="mt-1 flex items-start gap-1.5 text-sm" style={{ color: "var(--pz-body)" }}>
                  <MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
                  <span>{s.address}</span>
                </p>
              )}

              {s.oeffnungszeitenText && (
                <p className="mt-1 flex items-start gap-1.5 text-sm" style={{ color: "var(--pz-body)" }}>
                  <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
                  <span>{s.oeffnungszeitenText}</span>
                </p>
              )}

              {/* Walk-in vs. Termin-Pflicht */}
              {s.terminErforderlich ? (
                <p className="mt-2 text-sm font-medium" style={{ color: "var(--pz-body)" }}>
                  Nur mit Termin.
                </p>
              ) : (
                <p className="mt-2 text-sm font-medium" style={{ color: "var(--pz-success-ink)" }}>
                  Ohne Termin während der Öffnungszeiten.
                </p>
              )}

              {(s.barrierefrei === true || s.kontakt) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--pz-muted)" }}>
                  {s.barrierefrei === true && (
                    <span className="flex items-center gap-1">
                      <Accessibility aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
                      Barrierefrei
                    </span>
                  )}
                  {s.kontakt && (
                    <span className="flex items-center gap-1">
                      <Phone aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
                      {s.kontakt}
                    </span>
                  )}
                </div>
              )}

              {s.hinweiseKurz && (
                <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>{s.hinweiseKurz}</p>
              )}

              {s.terminErforderlich && (
                <Link
                  href={`/${tenantSlug}/verifizieren/termin`}
                  className="pz-btn pz-btn-primary mt-3"
                >
                  Termin buchen
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
