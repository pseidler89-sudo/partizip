/**
 * TerminBuchen.tsx — Buchungs-Flow (D6): Standort → Termin → bestätigen.
 *
 * Reiner Client-Flow über die bereits server-seitig geladenen, frei buchbaren
 * Slots (mit fertigen Datums-Labels). Das Buchen selbst läuft über die Server
 * Action bookSlot (atomare Kapazität, Stufe-1-Pflicht serverseitig).
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MapPin, CalendarCheck, ChevronLeft, BadgeCheck, Info, Loader2 } from "lucide-react";
import { bookSlot } from "@/lib/verification/booking-actions";

interface SlotVM {
  slotId: string;
  label: string;
  frei: number;
}
interface StandortVM {
  locationId: string;
  name: string;
  address: string | null;
  hinweise: string | null;
  slots: SlotVM[];
}

interface Erfolg {
  code: string;
  slotLabel: string;
  locationName: string;
  locationAddress: string | null;
}

export default function TerminBuchen({
  standorte,
  tenantSlug,
}: {
  standorte: StandortVM[];
  tenantSlug: string;
}) {
  const router = useRouter();
  const [locId, setLocId] = useState<string | null>(
    standorte.length === 1 ? standorte[0].locationId : null,
  );
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [erfolg, setErfolg] = useState<Erfolg | null>(null);

  const loc = standorte.find((s) => s.locationId === locId) ?? null;

  async function buchen(slot: SlotVM) {
    if (!loc) return;
    setError(null);
    setBusySlot(slot.slotId);
    try {
      const r = await bookSlot(slot.slotId);
      if (!r.ok || !r.booking) {
        if (r.needLogin) setNeedLogin(true);
        // Race gegen das One-Open-UNIQUE: es existiert bereits ein Termin → zur
        // Übersicht, dort steht er (statt eines irreführenden Fehlers).
        else if (r.alreadyBooked) router.push(`/${tenantSlug}/verifizieren`);
        else setError(r.error ?? "Buchung fehlgeschlagen.");
        return;
      }
      setErfolg({
        code: r.booking.code,
        slotLabel: slot.label,
        locationName: r.booking.locationName,
        locationAddress: r.booking.locationAddress,
      });
      // KEIN router.refresh(): der Erfolgs-Screen rendert aus lokalem State. Ein
      // Refresh würde die Termin-Seite neu ausführen, die — jetzt mit offenem Termin —
      // auf den Hub redirectet und den Termin-Code-Screen sofort wegnähme.
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setBusySlot(null);
    }
  }

  // --- Erfolg --------------------------------------------------------------
  if (erfolg) {
    return (
      <div className="pz-card p-6">
        <div className="flex flex-col items-center gap-3 text-center" role="status">
          <span
            className="flex h-16 w-16 items-center justify-center rounded-full"
            style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
          >
            <BadgeCheck aria-hidden className="h-8 w-8" strokeWidth={2} />
          </span>
          <h2 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Termin gebucht
          </h2>
        </div>
        <dl className="mt-5 space-y-2 text-sm" style={{ color: "var(--pz-body)" }}>
          <div>
            <dt className="font-medium" style={{ color: "var(--pz-muted)" }}>Termin</dt>
            <dd>{erfolg.slotLabel}</dd>
          </div>
          <div>
            <dt className="font-medium" style={{ color: "var(--pz-muted)" }}>Ort</dt>
            <dd>
              {erfolg.locationName}
              {erfolg.locationAddress ? `, ${erfolg.locationAddress}` : ""}
            </dd>
          </div>
        </dl>
        <div
          className="mt-4 rounded-lg border border-dashed p-3 text-center"
          style={{ borderColor: "var(--pz-line-strong, var(--pz-line))", backgroundColor: "var(--pz-page)" }}
        >
          <p className="text-xs" style={{ color: "var(--pz-muted)" }}>Ihr Termin-Code (vor Ort zeigen)</p>
          <p className="mt-1 font-mono text-lg font-medium tracking-wide" style={{ color: "var(--pz-ink)" }}>
            {erfolg.code}
          </p>
        </div>
        <div className="mt-4 flex items-start gap-2 text-sm" style={{ color: "var(--pz-body)" }}>
          <Info aria-hidden className="mt-0.5 h-[17px] w-[17px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
          <p>
            Bitte bringen Sie Ihren <b>Personalausweis oder Reisepass</b> mit. Der
            Ausweis dient nur zum Abgleich vor Ort; gespeichert wird nichts davon,
            nur dass Ihr Wohnsitz bestätigt ist.
          </p>
        </div>
        <Link
          href={`/${tenantSlug}/verifizieren`}
          className="mt-5 inline-flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
          style={{ backgroundColor: "var(--tenant-primary)" }}
        >
          Zur Verifizierungs-Übersicht
        </Link>
      </div>
    );
  }

  if (needLogin) {
    return (
      <div className="pz-card p-6 text-center">
        <h2 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          Bitte zuerst anmelden
        </h2>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Zum Buchen eines Termins ist eine kurze Anmeldung per E-Mail-Link nötig.
        </p>
        <Link
          href={`/${tenantSlug}/anmelden`}
          className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
          style={{ backgroundColor: "var(--tenant-primary)" }}
        >
          Jetzt anmelden
        </Link>
      </div>
    );
  }

  // --- Schritt 2: Termin wählen -------------------------------------------
  if (loc) {
    return (
      <div className="pz-card p-6">
        {standorte.length > 1 && (
          <button
            type="button"
            onClick={() => setLocId(null)}
            className="inline-flex items-center gap-1 text-sm hover:underline"
            style={{ color: "var(--pz-muted)" }}
          >
            <ChevronLeft aria-hidden className="h-4 w-4" strokeWidth={2} /> Anderen Standort wählen
          </button>
        )}
        <h2 className="mt-2 flex items-center gap-2 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          <MapPin aria-hidden className="h-[18px] w-[18px]" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
          {loc.name}
        </h2>
        {loc.address && (
          <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>{loc.address}</p>
        )}
        {loc.hinweise && (
          <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>{loc.hinweise}</p>
        )}

        <h3 className="mt-5 text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
          Freien Termin wählen
        </h3>
        {loc.slots.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--pz-muted)" }}>
            Für diesen Standort sind derzeit keine freien Termine verfügbar.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {loc.slots.map((slot) => (
              <li key={slot.slotId}>
                <button
                  type="button"
                  onClick={() => buchen(slot)}
                  disabled={busySlot !== null}
                  aria-busy={busySlot === slot.slotId}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-[color:var(--pz-brand-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ borderColor: "var(--pz-line)", color: "var(--pz-ink)" }}
                >
                  <span className="flex items-center gap-2">
                    <CalendarCheck aria-hidden className="h-[17px] w-[17px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
                    {slot.label}
                  </span>
                  {busySlot === slot.slotId ? (
                    <Loader2 aria-hidden className="h-4 w-4 animate-spin" strokeWidth={2} />
                  ) : (
                    <span className="text-xs" style={{ color: "var(--pz-muted)" }}>
                      {slot.frei} {slot.frei === 1 ? "Platz" : "Plätze"} frei
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  // --- Schritt 1: Standort wählen -----------------------------------------
  return (
    <div className="pz-card p-6">
      <h2 className="text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
        Standort wählen
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
        Wählen Sie ein Bürgerbüro in Ihrer Nähe.
      </p>
      <ul className="mt-4 flex flex-col gap-2">
        {standorte.map((s) => {
          const frei = s.slots.length;
          return (
            <li key={s.locationId}>
              <button
                type="button"
                onClick={() => setLocId(s.locationId)}
                className="flex w-full items-start justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-[color:var(--pz-brand-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
                style={{ borderColor: "var(--pz-line)" }}
              >
                <span className="flex items-start gap-2">
                  <MapPin aria-hidden className="mt-0.5 h-[18px] w-[18px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
                  <span>
                    <span className="block text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>{s.name}</span>
                    {s.address && (
                      <span className="block text-xs" style={{ color: "var(--pz-muted)" }}>{s.address}</span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-xs" style={{ color: frei > 0 ? "var(--pz-success-ink)" : "var(--pz-muted)" }}>
                  {frei > 0 ? `${frei} Termin${frei === 1 ? "" : "e"} frei` : "ausgebucht"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
