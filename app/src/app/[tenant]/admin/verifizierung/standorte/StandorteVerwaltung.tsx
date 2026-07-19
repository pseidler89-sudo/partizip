/**
 * StandorteVerwaltung.tsx — Client-Komponente der Standort-/Sprechzeiten-
 * Verwaltung (Block K1, NUR Admins — die Seite und alle Actions erzwingen das
 * serverseitig; diese UI ist nur Komfort).
 *
 * - Liste aller Standorte als Karten (Name, Adresse, Hinweise, aktiv/inaktiv,
 *   Kennzahlen) + Inline-Bearbeiten + Deaktivieren/Aktivieren mit
 *   BestaetigungsDialog (Deaktivieren erklärt: keine NEUEN Buchungen,
 *   bestehende Termine bleiben gültig — Standorte sind bewusst NICHT löschbar).
 * - Je Standort ausklappbar: kommende Sprechzeiten (Belegung „1/2 belegt"),
 *   Löschen NUR ohne Buchungen (sonst Hinweistext), Kapazität ändern.
 * - Sprechzeiten anlegen: Umschalter „Einzeltermin" | „Wochenserie" mit
 *   Ergebnis-Feedback „N Termine angelegt, M übersprungen".
 *
 * A11y: alle Felder mit Label, aria-busy auf laufenden Aktionen, Fehler mit
 * role="alert", Umschalter/Details rein per Button (tastatur-bedienbar).
 */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OeffnungszeitFenster } from "@/db/schema";
import BestaetigungsDialog from "../../../BestaetigungsDialog";
import {
  slotKapazitaetAendern,
  slotLoeschen,
  sprechzeitenAnlegen,
  standortAktivSetzen,
  standortBearbeiten,
  standortErstellen,
} from "@/lib/verification/standort-actions";

export interface SlotVM {
  slotId: string;
  /** Server-formatiertes Zeit-Label (formatSlotLabel, Europe/Berlin). */
  label: string;
  capacity: number;
  bookedCount: number;
}

export interface StandortVM {
  locationId: string;
  name: string;
  address: string | null;
  hinweise: string | null;
  isActive: boolean;
  lat: number | null;
  lon: number | null;
  oeffnungszeiten: OeffnungszeitFenster[] | null;
  terminErforderlich: boolean;
  barrierefrei: boolean | null;
  kontakt: string | null;
  kommendeSlots: number;
  freiePlaetze: number;
  offeneBuchungen: number;
  slots: SlotVM[];
  /** Gesamtzahl künftiger Slots — kann über slots.length (Kappung 300) liegen. */
  slotsGesamt: number;
}

interface Props {
  standorte: StandortVM[];
}

const DAUER_OPTIONEN = [15, 20, 30, 45, 60] as const;

/** Wochentags-Checkboxen Mo–So (Werte = JS-getDay-Konvention, 0=So). */
const WOCHENTAGE: { wert: number; label: string }[] = [
  { wert: 1, label: "Mo" },
  { wert: 2, label: "Di" },
  { wert: 3, label: "Mi" },
  { wert: 4, label: "Do" },
  { wert: 5, label: "Fr" },
  { wert: 6, label: "Sa" },
  { wert: 0, label: "So" },
];

/** ISO-Wochentage (Mo=1 … So=7) für die strukturierten Öffnungszeiten. */
const ISO_WOCHENTAGE: { wert: number; label: string }[] = [
  { wert: 1, label: "Mo" },
  { wert: 2, label: "Di" },
  { wert: 3, label: "Mi" },
  { wert: 4, label: "Do" },
  { wert: 5, label: "Fr" },
  { wert: 6, label: "Sa" },
  { wert: 7, label: "So" },
];

const inputKlasse =
  "mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]";

/** Barrierefrei-Tri-State ↔ Select-Wert. */
type BarrierefreiWahl = "unbekannt" | "ja" | "nein";
function barrierefreiZuWahl(b: boolean | null): BarrierefreiWahl {
  return b === true ? "ja" : b === false ? "nein" : "unbekannt";
}
function wahlZuBarrierefrei(w: BarrierefreiWahl): boolean | null {
  return w === "ja" ? true : w === "nein" ? false : null;
}

const ISO_TAG_KURZ = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Kompakte, menschenlesbare Öffnungszeiten-Zusammenfassung für die Karte. */
function formatOeffnungKurz(fenster: OeffnungszeitFenster[] | null): string {
  if (!fenster || fenster.length === 0) return "";
  return fenster
    .slice()
    .sort((a, b) => a.tag - b.tag || a.von.localeCompare(b.von))
    .map((f) => `${ISO_TAG_KURZ[f.tag] ?? f.tag} ${f.von}–${f.bis}`)
    .join(", ");
}

/** Leeres Koordinatenfeld → null; sonst die Zahl (NaN → null, fail-closed). */
function parseKoord(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Zeilen-Editor für strukturierte Öffnungszeiten (V1): je Zeile Wochentag-Select
 * (Mo=1 … So=7) + von/bis (HH:MM). Mehrere Zeilen / mehrere Fenster je Tag
 * erlaubt. Rein clientseitig; die serverseitige zod-Prüfung (von<bis, HH:MM,
 * Tag 1–7) bleibt maßgeblich.
 */
function OeffnungszeitenEditor({
  wert,
  onChange,
  idPrefix,
}: {
  wert: OeffnungszeitFenster[];
  onChange: (next: OeffnungszeitFenster[]) => void;
  idPrefix: string;
}) {
  function setzeFeld(i: number, feld: keyof OeffnungszeitFenster, v: string | number) {
    const next = wert.map((f, idx) => (idx === i ? { ...f, [feld]: v } : f));
    onChange(next);
  }
  return (
    <div className="space-y-2">
      {wert.length === 0 && (
        <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
          Noch keine Öffnungszeiten. Fügen Sie ein Zeitfenster hinzu — oder
          aktivieren Sie die Termin-Pflicht.
        </p>
      )}
      {wert.map((f, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`${idPrefix}-tag-${i}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              Wochentag
            </label>
            <select
              id={`${idPrefix}-tag-${i}`}
              value={f.tag}
              onChange={(e) => setzeFeld(i, "tag", Number(e.target.value))}
              className="mt-1 rounded-md border px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              style={{ borderColor: "var(--pz-line)" }}
            >
              {ISO_WOCHENTAGE.map((w) => (
                <option key={w.wert} value={w.wert}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-von-${i}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              von
            </label>
            <input
              id={`${idPrefix}-von-${i}`}
              type="time"
              value={f.von}
              onChange={(e) => setzeFeld(i, "von", e.target.value)}
              className="mt-1 rounded-md border px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              style={{ borderColor: "var(--pz-line)" }}
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-bis-${i}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              bis
            </label>
            <input
              id={`${idPrefix}-bis-${i}`}
              type="time"
              value={f.bis}
              onChange={(e) => setzeFeld(i, "bis", e.target.value)}
              className="mt-1 rounded-md border px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
              style={{ borderColor: "var(--pz-line)" }}
            />
          </div>
          <button
            type="button"
            onClick={() => onChange(wert.filter((_, idx) => idx !== i))}
            className="pz-btn pz-btn-secondary pz-btn-sm"
            aria-label={`Zeitfenster ${i + 1} entfernen`}
          >
            Entfernen
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...wert, { tag: 1, von: "09:00", bis: "12:00" }])}
        className="pz-btn pz-btn-secondary pz-btn-sm"
      >
        Zeitfenster hinzufügen
      </button>
    </div>
  );
}

/**
 * Gemeinsame V1-Zusatzfelder (Koordinaten, Öffnungszeiten, Termin-Pflicht,
 * Barrierefreiheit, Kontakt) für das Anlegen- UND das Bearbeiten-Formular.
 */
function StandortZusatzFelder(props: {
  idPrefix: string;
  lat: string;
  setLat: (v: string) => void;
  lon: string;
  setLon: (v: string) => void;
  oeffnung: OeffnungszeitFenster[];
  setOeffnung: (v: OeffnungszeitFenster[]) => void;
  termin: boolean;
  setTermin: (v: boolean) => void;
  barrierefrei: BarrierefreiWahl;
  setBarrierefrei: (v: BarrierefreiWahl) => void;
  kontakt: string;
  setKontakt: (v: string) => void;
}) {
  const { idPrefix } = props;
  return (
    <>
      <fieldset>
        <legend className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
          Öffnungszeiten (für Verifizierung ohne Termin)
        </legend>
        <div className="mt-1">
          <OeffnungszeitenEditor
            wert={props.oeffnung}
            onChange={props.setOeffnung}
            idPrefix={`${idPrefix}-oz`}
          />
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm" style={{ color: "var(--pz-body)" }}>
        <input
          type="checkbox"
          checked={props.termin}
          onChange={(e) => props.setTermin(e.target.checked)}
        />
        Verifizierung nur mit Termin — kein Walk-in
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-lat`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
            Breitengrad (optional)
          </label>
          <input
            id={`${idPrefix}-lat`}
            type="number"
            step="any"
            min={-90}
            max={90}
            value={props.lat}
            onChange={(e) => props.setLat(e.target.value)}
            placeholder="z. B. 50.1409"
            className={inputKlasse}
            style={{ borderColor: "var(--pz-line)" }}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-lon`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
            Längengrad (optional)
          </label>
          <input
            id={`${idPrefix}-lon`}
            type="number"
            step="any"
            min={-180}
            max={180}
            value={props.lon}
            onChange={(e) => props.setLon(e.target.value)}
            placeholder="z. B. 8.1508"
            className={inputKlasse}
            style={{ borderColor: "var(--pz-line)" }}
          />
        </div>
      </div>
      <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
        Koordinaten aus der Karten-App kopieren — ermöglicht später die Sortierung
        nach Nähe. Beide Felder gemeinsam ausfüllen oder beide leer lassen.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-barrierefrei`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
            Barrierefrei
          </label>
          <select
            id={`${idPrefix}-barrierefrei`}
            value={props.barrierefrei}
            onChange={(e) => props.setBarrierefrei(e.target.value as BarrierefreiWahl)}
            className={inputKlasse}
            style={{ borderColor: "var(--pz-line)" }}
          >
            <option value="unbekannt">unbekannt</option>
            <option value="ja">ja</option>
            <option value="nein">nein</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-kontakt`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
            Kontakt (optional, z. B. Telefon)
          </label>
          <input
            id={`${idPrefix}-kontakt`}
            type="text"
            maxLength={120}
            value={props.kontakt}
            onChange={(e) => props.setKontakt(e.target.value)}
            placeholder="z. B. 06128 / 000-0"
            className={inputKlasse}
            style={{ borderColor: "var(--pz-line)" }}
          />
        </div>
      </div>
    </>
  );
}

export function StandorteVerwaltung({ standorte }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Neuen Standort anlegen
  const [neuName, setNeuName] = useState("");
  const [neuAddress, setNeuAddress] = useState("");
  const [neuHinweise, setNeuHinweise] = useState("");
  const [neuLat, setNeuLat] = useState("");
  const [neuLon, setNeuLon] = useState("");
  const [neuOeffnung, setNeuOeffnung] = useState<OeffnungszeitFenster[]>([]);
  const [neuTermin, setNeuTermin] = useState(false);
  const [neuBarrierefrei, setNeuBarrierefrei] = useState<BarrierefreiWahl>("unbekannt");
  const [neuKontakt, setNeuKontakt] = useState("");
  const [neuFehler, setNeuFehler] = useState<string | null>(null);

  // Je-Standort-UI-Zustand
  const [bearbeiteId, setBearbeiteId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editHinweise, setEditHinweise] = useState("");
  const [editLat, setEditLat] = useState("");
  const [editLon, setEditLon] = useState("");
  const [editOeffnung, setEditOeffnung] = useState<OeffnungszeitFenster[]>([]);
  const [editTermin, setEditTermin] = useState(false);
  const [editBarrierefrei, setEditBarrierefrei] = useState<BarrierefreiWahl>("unbekannt");
  const [editKontakt, setEditKontakt] = useState("");
  const [aufgeklappt, setAufgeklappt] = useState<Set<string>>(new Set());
  const [standortFehler, setStandortFehler] = useState<Record<string, string>>({});
  const [standortInfo, setStandortInfo] = useState<Record<string, string>>({});

  // Bestätigungs-Dialoge
  const [aktivDialog, setAktivDialog] = useState<{ id: string; name: string; aktiv: boolean } | null>(null);
  const [loeschDialog, setLoeschDialog] = useState<{ standortId: string; slotId: string; label: string } | null>(null);

  // Kapazitäts-Eingaben je Slot (kleines Zahlenfeld + Speichern)
  const [kapWerte, setKapWerte] = useState<Record<string, string>>({});

  // Sprechzeiten-Formular je Standort
  const [szArt, setSzArt] = useState<Record<string, "einzeln" | "serie">>({});
  const [szDatum, setSzDatum] = useState<Record<string, string>>({});
  const [szZeit, setSzZeit] = useState<Record<string, string>>({});
  const [szDauer, setSzDauer] = useState<Record<string, string>>({});
  const [szKapazitaet, setSzKapazitaet] = useState<Record<string, string>>({});
  const [szVonDatum, setSzVonDatum] = useState<Record<string, string>>({});
  const [szBisDatum, setSzBisDatum] = useState<Record<string, string>>({});
  const [szVonZeit, setSzVonZeit] = useState<Record<string, string>>({});
  const [szBisZeit, setSzBisZeit] = useState<Record<string, string>>({});
  const [szWochentage, setSzWochentage] = useState<Record<string, Set<number>>>({});

  function setzeFehler(standortId: string, fehler: string | null) {
    setStandortFehler((prev) => {
      const next = { ...prev };
      if (fehler) next[standortId] = fehler;
      else delete next[standortId];
      return next;
    });
  }

  function setzeInfo(standortId: string, info: string | null) {
    setStandortInfo((prev) => {
      const next = { ...prev };
      if (info) next[standortId] = info;
      else delete next[standortId];
      return next;
    });
  }

  function handleAnlegen(e: React.FormEvent) {
    e.preventDefault();
    setNeuFehler(null);
    startTransition(async () => {
      const r = await standortErstellen({
        name: neuName.trim(),
        address: neuAddress.trim(),
        hinweise: neuHinweise.trim() || null,
        lat: parseKoord(neuLat),
        lon: parseKoord(neuLon),
        oeffnungszeiten: neuOeffnung,
        terminErforderlich: neuTermin,
        barrierefrei: wahlZuBarrierefrei(neuBarrierefrei),
        kontakt: neuKontakt.trim() || null,
      });
      if (!r.ok) {
        setNeuFehler(r.error ?? "Anlegen fehlgeschlagen.");
        return;
      }
      setNeuName("");
      setNeuAddress("");
      setNeuHinweise("");
      setNeuLat("");
      setNeuLon("");
      setNeuOeffnung([]);
      setNeuTermin(false);
      setNeuBarrierefrei("unbekannt");
      setNeuKontakt("");
      router.refresh();
    });
  }

  function starteBearbeiten(s: StandortVM) {
    setBearbeiteId(s.locationId);
    setEditName(s.name);
    setEditAddress(s.address ?? "");
    setEditHinweise(s.hinweise ?? "");
    setEditLat(s.lat == null ? "" : String(s.lat));
    setEditLon(s.lon == null ? "" : String(s.lon));
    setEditOeffnung(s.oeffnungszeiten ?? []);
    setEditTermin(s.terminErforderlich);
    setEditBarrierefrei(barrierefreiZuWahl(s.barrierefrei));
    setEditKontakt(s.kontakt ?? "");
    setzeFehler(s.locationId, null);
    setzeInfo(s.locationId, null);
  }

  function handleBearbeiten(e: React.FormEvent, standortId: string) {
    e.preventDefault();
    setzeFehler(standortId, null);
    startTransition(async () => {
      const r = await standortBearbeiten(standortId, {
        name: editName.trim(),
        address: editAddress.trim(),
        hinweise: editHinweise.trim() || null,
        lat: parseKoord(editLat),
        lon: parseKoord(editLon),
        oeffnungszeiten: editOeffnung,
        terminErforderlich: editTermin,
        barrierefrei: wahlZuBarrierefrei(editBarrierefrei),
        kontakt: editKontakt.trim() || null,
      });
      if (!r.ok) {
        setzeFehler(standortId, r.error ?? "Speichern fehlgeschlagen.");
        return;
      }
      setBearbeiteId(null);
      router.refresh();
    });
  }

  function handleAktivSetzen() {
    if (!aktivDialog) return;
    const { id, aktiv } = aktivDialog;
    setzeFehler(id, null);
    startTransition(async () => {
      const r = await standortAktivSetzen(id, aktiv);
      setAktivDialog(null);
      if (!r.ok) {
        setzeFehler(id, r.error ?? "Aktion fehlgeschlagen.");
        return;
      }
      router.refresh();
    });
  }

  function handleSlotLoeschen() {
    if (!loeschDialog) return;
    const { standortId, slotId } = loeschDialog;
    setzeFehler(standortId, null);
    startTransition(async () => {
      const r = await slotLoeschen(slotId);
      setLoeschDialog(null);
      if (!r.ok) {
        setzeFehler(standortId, r.error ?? "Löschen fehlgeschlagen.");
        return;
      }
      router.refresh();
    });
  }

  function handleKapazitaet(standortId: string, slot: SlotVM) {
    const roh = kapWerte[slot.slotId];
    const neu = Number(roh);
    setzeFehler(standortId, null);
    if (!Number.isInteger(neu) || neu < 1 || neu > 20) {
      setzeFehler(standortId, "Kapazität muss eine ganze Zahl zwischen 1 und 20 sein.");
      return;
    }
    startTransition(async () => {
      const r = await slotKapazitaetAendern(slot.slotId, neu);
      if (!r.ok) {
        setzeFehler(standortId, r.error ?? "Kapazität ändern fehlgeschlagen.");
        return;
      }
      setKapWerte((prev) => {
        const next = { ...prev };
        delete next[slot.slotId];
        return next;
      });
      router.refresh();
    });
  }

  function handleSprechzeiten(e: React.FormEvent, standortId: string) {
    e.preventDefault();
    setzeFehler(standortId, null);
    setzeInfo(standortId, null);

    const art = szArt[standortId] ?? "einzeln";
    const kapazitaet = Number(szKapazitaet[standortId] ?? "1");
    if (!Number.isInteger(kapazitaet) || kapazitaet < 1) {
      setzeFehler(standortId, "Kapazität muss eine ganze Zahl ≥ 1 sein.");
      return;
    }

    startTransition(async () => {
      const r =
        art === "einzeln"
          ? await sprechzeitenAnlegen({
              art: "einzeln",
              locationId: standortId,
              datum: szDatum[standortId] ?? "",
              zeit: szZeit[standortId] ?? "",
              dauerMinuten: Number(szDauer[standortId] ?? "30"),
              kapazitaet,
            })
          : await sprechzeitenAnlegen({
              art: "serie",
              locationId: standortId,
              vonDatum: szVonDatum[standortId] ?? "",
              bisDatum: szBisDatum[standortId] ?? "",
              wochentage: Array.from(szWochentage[standortId] ?? []),
              vonZeit: szVonZeit[standortId] ?? "",
              bisZeit: szBisZeit[standortId] ?? "",
              slotDauerMinuten: Number(szDauer[standortId] ?? "30"),
              kapazitaet,
            });
      if (!r.ok) {
        setzeFehler(standortId, r.error ?? "Anlegen fehlgeschlagen.");
        return;
      }
      setzeInfo(
        standortId,
        `${r.angelegt ?? 0} Termin${(r.angelegt ?? 0) === 1 ? "" : "e"} angelegt` +
          ((r.uebersprungen ?? 0) > 0
            ? `, ${r.uebersprungen} übersprungen (bereits vorhanden)`
            : "") +
          ".",
      );
      router.refresh();
    });
  }

  function toggleAufgeklappt(id: string) {
    setAufgeklappt((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleWochentag(standortId: string, wert: number) {
    setSzWochentage((prev) => {
      const next = { ...prev };
      const set = new Set(next[standortId] ?? []);
      if (set.has(wert)) set.delete(wert);
      else set.add(wert);
      next[standortId] = set;
      return next;
    });
  }

  return (
    <div className="space-y-10">
      {/* Neuen Standort anlegen */}
      <section className="pz-card p-5">
        <h2 className="text-lg font-medium" style={{ color: "var(--pz-ink)" }}>
          Neuen Standort anlegen
        </h2>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
          Zum Beispiel das Bürgerbüro oder ein Rathaus-Schalter. Sprechzeiten
          legen Sie danach am Standort fest.
        </p>
        <form onSubmit={handleAnlegen} className="mt-4 space-y-4">
          <div>
            <label htmlFor="neu-name" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              Name (3–120 Zeichen)
            </label>
            <input
              id="neu-name"
              type="text"
              required
              minLength={3}
              maxLength={120}
              value={neuName}
              onChange={(e) => setNeuName(e.target.value)}
              placeholder="z. B. Bürgerbüro Rathaus"
              className={inputKlasse}
              style={{ borderColor: "var(--pz-line)" }}
            />
          </div>
          <div>
            <label htmlFor="neu-address" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              Adresse
            </label>
            <input
              id="neu-address"
              type="text"
              required
              maxLength={200}
              value={neuAddress}
              onChange={(e) => setNeuAddress(e.target.value)}
              placeholder="z. B. Aarstraße 150, 65232 Taunusstein"
              className={inputKlasse}
              style={{ borderColor: "var(--pz-line)" }}
            />
          </div>
          <div>
            <label htmlFor="neu-hinweise" className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
              Hinweise für Bürger:innen (optional)
            </label>
            <input
              id="neu-hinweise"
              type="text"
              maxLength={500}
              value={neuHinweise}
              onChange={(e) => setNeuHinweise(e.target.value)}
              placeholder="z. B. Bitte Personalausweis mitbringen; Eingang Seitenstraße"
              className={inputKlasse}
              style={{ borderColor: "var(--pz-line)" }}
            />
          </div>
          <StandortZusatzFelder
            idPrefix="neu"
            lat={neuLat}
            setLat={setNeuLat}
            lon={neuLon}
            setLon={setNeuLon}
            oeffnung={neuOeffnung}
            setOeffnung={setNeuOeffnung}
            termin={neuTermin}
            setTermin={setNeuTermin}
            barrierefrei={neuBarrierefrei}
            setBarrierefrei={setNeuBarrierefrei}
            kontakt={neuKontakt}
            setKontakt={setNeuKontakt}
          />
          {neuFehler && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {neuFehler}
            </div>
          )}
          <button
            type="submit"
            disabled={isPending}
            aria-busy={isPending}
            className="pz-btn pz-btn-primary"
          >
            {isPending ? "…" : "Standort anlegen"}
          </button>
        </form>
      </section>

      {/* Standort-Liste */}
      <section>
        <h2 className="text-lg font-medium" style={{ color: "var(--pz-ink)" }}>
          Bestehende Standorte
        </h2>
        {standorte.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--pz-muted)" }}>
            Noch keine Standorte angelegt.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {standorte.map((s) => {
              const offen = aufgeklappt.has(s.locationId);
              const bearbeitet = bearbeiteId === s.locationId;
              const art = szArt[s.locationId] ?? "einzeln";
              return (
                <li key={s.locationId} className="pz-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
                        {s.name}
                      </p>
                      {s.address && (
                        <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                          {s.address}
                        </p>
                      )}
                      {s.hinweise && (
                        <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                          {s.hinweise}
                        </p>
                      )}
                      {s.terminErforderlich ? (
                        <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                          Nur mit Termin (kein Walk-in)
                        </p>
                      ) : (
                        s.oeffnungszeiten &&
                        s.oeffnungszeiten.length > 0 && (
                          <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                            Öffnungszeiten: {formatOeffnungKurz(s.oeffnungszeiten)}
                          </p>
                        )
                      )}
                      {(s.barrierefrei !== null || s.kontakt || (s.lat != null && s.lon != null)) && (
                        <p className="mt-0.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                          {s.barrierefrei !== null && (s.barrierefrei ? "barrierefrei" : "nicht barrierefrei")}
                          {s.barrierefrei !== null && (s.kontakt || (s.lat != null && s.lon != null)) ? " · " : ""}
                          {s.kontakt}
                          {s.kontakt && s.lat != null && s.lon != null ? " · " : ""}
                          {s.lat != null && s.lon != null ? `${s.lat}, ${s.lon}` : ""}
                        </p>
                      )}
                      <p className="mt-1.5 text-xs" style={{ color: "var(--pz-muted)" }}>
                        {s.kommendeSlots} kommende Sprechzeit{s.kommendeSlots === 1 ? "" : "en"} ·{" "}
                        {s.freiePlaetze} freie Plätze · {s.offeneBuchungen} offene Buchung
                        {s.offeneBuchungen === 1 ? "" : "en"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                        style={
                          s.isActive
                            ? { backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }
                            : { backgroundColor: "var(--pz-line)", color: "var(--pz-muted)" }
                        }
                      >
                        {s.isActive ? "Aktiv" : "Deaktiviert"}
                      </span>
                      <button
                        type="button"
                        onClick={() => (bearbeitet ? setBearbeiteId(null) : starteBearbeiten(s))}
                        disabled={isPending}
                        className="pz-btn pz-btn-secondary pz-btn-sm"
                      >
                        {bearbeitet ? "Bearbeiten schließen" : "Bearbeiten"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setAktivDialog({ id: s.locationId, name: s.name, aktiv: !s.isActive })
                        }
                        disabled={isPending}
                        className={`pz-btn pz-btn-sm ${s.isActive ? "pz-btn-danger" : "pz-btn-secondary"}`}
                      >
                        {s.isActive ? "Deaktivieren" : "Aktivieren"}
                      </button>
                    </div>
                  </div>

                  {standortFehler[s.locationId] && (
                    <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                      {standortFehler[s.locationId]}
                    </div>
                  )}
                  {standortInfo[s.locationId] && (
                    <div
                      role="status"
                      className="mt-3 rounded-md border px-4 py-2 text-sm"
                      style={{
                        borderColor: "var(--pz-line)",
                        backgroundColor: "var(--pz-brand-soft)",
                        color: "var(--pz-ink)",
                      }}
                    >
                      {standortInfo[s.locationId]}
                    </div>
                  )}

                  {/* Inline-Bearbeiten */}
                  {bearbeitet && (
                    <form
                      onSubmit={(e) => handleBearbeiten(e, s.locationId)}
                      className="mt-4 space-y-3 rounded-lg border p-4"
                      style={{ borderColor: "var(--pz-line)" }}
                    >
                      <div>
                        <label htmlFor={`edit-name-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                          Name
                        </label>
                        <input
                          id={`edit-name-${s.locationId}`}
                          type="text"
                          required
                          minLength={3}
                          maxLength={120}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className={inputKlasse}
                          style={{ borderColor: "var(--pz-line)" }}
                        />
                      </div>
                      <div>
                        <label htmlFor={`edit-address-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                          Adresse
                        </label>
                        <input
                          id={`edit-address-${s.locationId}`}
                          type="text"
                          required
                          maxLength={200}
                          value={editAddress}
                          onChange={(e) => setEditAddress(e.target.value)}
                          className={inputKlasse}
                          style={{ borderColor: "var(--pz-line)" }}
                        />
                      </div>
                      <div>
                        <label htmlFor={`edit-hinweise-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                          Hinweise
                        </label>
                        <input
                          id={`edit-hinweise-${s.locationId}`}
                          type="text"
                          maxLength={500}
                          value={editHinweise}
                          onChange={(e) => setEditHinweise(e.target.value)}
                          className={inputKlasse}
                          style={{ borderColor: "var(--pz-line)" }}
                        />
                      </div>
                      <StandortZusatzFelder
                        idPrefix={`edit-${s.locationId}`}
                        lat={editLat}
                        setLat={setEditLat}
                        lon={editLon}
                        setLon={setEditLon}
                        oeffnung={editOeffnung}
                        setOeffnung={setEditOeffnung}
                        termin={editTermin}
                        setTermin={setEditTermin}
                        barrierefrei={editBarrierefrei}
                        setBarrierefrei={setEditBarrierefrei}
                        kontakt={editKontakt}
                        setKontakt={setEditKontakt}
                      />
                      <div className="flex gap-2">
                        <button type="submit" disabled={isPending} aria-busy={isPending} className="pz-btn pz-btn-primary pz-btn-sm">
                          {isPending ? "…" : "Speichern"}
                        </button>
                        <button type="button" disabled={isPending} onClick={() => setBearbeiteId(null)} className="pz-btn pz-btn-secondary pz-btn-sm">
                          Abbrechen
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Sprechzeiten auf-/zuklappen */}
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => toggleAufgeklappt(s.locationId)}
                      aria-expanded={offen}
                      className="pz-btn pz-btn-secondary pz-btn-sm"
                    >
                      {offen ? "Sprechzeiten verbergen" : `Sprechzeiten anzeigen (${s.slotsGesamt})`}
                    </button>
                  </div>

                  {offen && (
                    <div className="mt-4 space-y-5">
                      {/* Gekappte Liste ausweisen (Gate-B): weitere Slots sind
                          buchbar — nie still verschweigen. */}
                      {s.slotsGesamt > s.slots.length && (
                        <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
                          Zeige die nächsten {s.slots.length} von {s.slotsGesamt} Terminen.
                        </p>
                      )}
                      {/* Kommende Sprechzeiten */}
                      {s.slots.length === 0 ? (
                        <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
                          Keine kommenden Sprechzeiten.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {s.slots.map((slot) => (
                            <li
                              key={slot.slotId}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                              style={{ borderColor: "var(--pz-line)" }}
                            >
                              <div>
                                <p className="text-sm" style={{ color: "var(--pz-ink)" }}>{slot.label}</p>
                                <p className="text-xs" style={{ color: "var(--pz-muted)" }}>
                                  {slot.bookedCount}/{slot.capacity} belegt
                                </p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <label htmlFor={`kap-${slot.slotId}`} className="text-xs" style={{ color: "var(--pz-body)" }}>
                                  Kapazität
                                </label>
                                <input
                                  id={`kap-${slot.slotId}`}
                                  type="number"
                                  min={Math.max(1, slot.bookedCount)}
                                  max={20}
                                  value={kapWerte[slot.slotId] ?? String(slot.capacity)}
                                  onChange={(e) =>
                                    setKapWerte((prev) => ({ ...prev, [slot.slotId]: e.target.value }))
                                  }
                                  className="w-16 rounded-md border px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
                                  style={{ borderColor: "var(--pz-line)" }}
                                />
                                <button
                                  type="button"
                                  onClick={() => handleKapazitaet(s.locationId, slot)}
                                  disabled={isPending}
                                  className="pz-btn pz-btn-secondary pz-btn-sm"
                                >
                                  Speichern
                                </button>
                                {slot.bookedCount === 0 ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setLoeschDialog({
                                        standortId: s.locationId,
                                        slotId: slot.slotId,
                                        label: slot.label,
                                      })
                                    }
                                    disabled={isPending}
                                    className="pz-btn pz-btn-danger pz-btn-sm"
                                  >
                                    Löschen
                                  </button>
                                ) : (
                                  <span className="text-xs" style={{ color: "var(--pz-muted)" }}>
                                    Nicht löschbar (gebucht)
                                  </span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* Sprechzeiten anlegen */}
                      <form
                        onSubmit={(e) => handleSprechzeiten(e, s.locationId)}
                        className="rounded-lg border p-4"
                        style={{ borderColor: "var(--pz-line)" }}
                      >
                        <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
                          Sprechzeiten anlegen
                        </p>
                        {/* Umschalter Einzeltermin | Wochenserie */}
                        <div className="mt-2 flex gap-2" role="group" aria-label="Art der Sprechzeit">
                          <button
                            type="button"
                            onClick={() => setSzArt((prev) => ({ ...prev, [s.locationId]: "einzeln" }))}
                            aria-pressed={art === "einzeln"}
                            className={`pz-btn pz-btn-sm ${art === "einzeln" ? "pz-btn-primary" : "pz-btn-secondary"}`}
                          >
                            Einzeltermin
                          </button>
                          <button
                            type="button"
                            onClick={() => setSzArt((prev) => ({ ...prev, [s.locationId]: "serie" }))}
                            aria-pressed={art === "serie"}
                            className={`pz-btn pz-btn-sm ${art === "serie" ? "pz-btn-primary" : "pz-btn-secondary"}`}
                          >
                            Wochenserie
                          </button>
                        </div>

                        {art === "einzeln" ? (
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <div>
                              <label htmlFor={`sz-datum-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                                Datum
                              </label>
                              <input
                                id={`sz-datum-${s.locationId}`}
                                type="date"
                                required
                                value={szDatum[s.locationId] ?? ""}
                                onChange={(e) => setSzDatum((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                                className={inputKlasse}
                                style={{ borderColor: "var(--pz-line)" }}
                              />
                            </div>
                            <div>
                              <label htmlFor={`sz-zeit-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                                Uhrzeit
                              </label>
                              <input
                                id={`sz-zeit-${s.locationId}`}
                                type="time"
                                required
                                value={szZeit[s.locationId] ?? ""}
                                onChange={(e) => setSzZeit((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                                className={inputKlasse}
                                style={{ borderColor: "var(--pz-line)" }}
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3 space-y-3">
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div>
                                <label htmlFor={`sz-von-datum-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                                  Zeitraum von
                                </label>
                                <input
                                  id={`sz-von-datum-${s.locationId}`}
                                  type="date"
                                  required
                                  value={szVonDatum[s.locationId] ?? ""}
                                  onChange={(e) => setSzVonDatum((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                                  className={inputKlasse}
                                  style={{ borderColor: "var(--pz-line)" }}
                                />
                              </div>
                              <div>
                                <label htmlFor={`sz-bis-datum-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                                  Zeitraum bis
                                </label>
                                <input
                                  id={`sz-bis-datum-${s.locationId}`}
                                  type="date"
                                  required
                                  value={szBisDatum[s.locationId] ?? ""}
                                  onChange={(e) => setSzBisDatum((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                                  className={inputKlasse}
                                  style={{ borderColor: "var(--pz-line)" }}
                                />
                              </div>
                            </div>
                            <fieldset>
                              <legend className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                                Wochentage
                              </legend>
                              <div className="mt-1 flex flex-wrap gap-3">
                                {WOCHENTAGE.map((w) => (
                                  <label
                                    key={w.wert}
                                    className="inline-flex items-center gap-1.5 text-sm"
                                    style={{ color: "var(--pz-body)" }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={(szWochentage[s.locationId] ?? new Set()).has(w.wert)}
                                      onChange={() => toggleWochentag(s.locationId, w.wert)}
                                    />
                                    {w.label}
                                  </label>
                                ))}
                              </div>
                            </fieldset>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div>
                                <label htmlFor={`sz-von-zeit-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                                  Von Uhrzeit
                                </label>
                                <input
                                  id={`sz-von-zeit-${s.locationId}`}
                                  type="time"
                                  required
                                  value={szVonZeit[s.locationId] ?? ""}
                                  onChange={(e) => setSzVonZeit((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                                  className={inputKlasse}
                                  style={{ borderColor: "var(--pz-line)" }}
                                />
                              </div>
                              <div>
                                <label htmlFor={`sz-bis-zeit-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                                  Bis Uhrzeit
                                </label>
                                <input
                                  id={`sz-bis-zeit-${s.locationId}`}
                                  type="time"
                                  required
                                  value={szBisZeit[s.locationId] ?? ""}
                                  onChange={(e) => setSzBisZeit((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                                  className={inputKlasse}
                                  style={{ borderColor: "var(--pz-line)" }}
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div>
                            <label htmlFor={`sz-dauer-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                              {art === "einzeln" ? "Dauer" : "Slot-Dauer"}
                            </label>
                            <select
                              id={`sz-dauer-${s.locationId}`}
                              value={szDauer[s.locationId] ?? "30"}
                              onChange={(e) => setSzDauer((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                              className={inputKlasse}
                              style={{ borderColor: "var(--pz-line)" }}
                            >
                              {DAUER_OPTIONEN.map((d) => (
                                <option key={d} value={d}>
                                  {d} Minuten
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label htmlFor={`sz-kap-${s.locationId}`} className="block text-xs font-medium" style={{ color: "var(--pz-body)" }}>
                              Kapazität je Termin (1–20)
                            </label>
                            <input
                              id={`sz-kap-${s.locationId}`}
                              type="number"
                              min={1}
                              max={20}
                              required
                              value={szKapazitaet[s.locationId] ?? "1"}
                              onChange={(e) => setSzKapazitaet((prev) => ({ ...prev, [s.locationId]: e.target.value }))}
                              className={inputKlasse}
                              style={{ borderColor: "var(--pz-line)" }}
                            />
                          </div>
                        </div>

                        <button
                          type="submit"
                          disabled={isPending}
                          aria-busy={isPending}
                          className="pz-btn pz-btn-primary mt-4"
                        >
                          {isPending ? "…" : "Sprechzeiten anlegen"}
                        </button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Deaktivieren/Aktivieren — bewusste zweite Handlung (Block E) */}
      <BestaetigungsDialog
        offen={aktivDialog !== null}
        titel={
          aktivDialog?.aktiv
            ? `Standort „${aktivDialog?.name}" aktivieren?`
            : `Standort „${aktivDialog?.name}" deaktivieren?`
        }
        beschreibung={
          aktivDialog?.aktiv
            ? "Der Standort nimmt wieder neue Terminbuchungen an."
            : "Es können keine neuen Termine mehr gebucht werden. Bereits gebuchte Termine bleiben gültig und erscheinen weiterhin in der Terminliste — sagen Sie sie bei Bedarf persönlich ab."
        }
        bestaetigenLabel={aktivDialog?.aktiv ? "Aktivieren" : "Deaktivieren"}
        variante={aktivDialog?.aktiv ? "normal" : "gefahr"}
        busy={isPending}
        onBestaetigen={handleAktivSetzen}
        onAbbrechen={() => setAktivDialog(null)}
      />

      {/* Slot löschen — nur ohne Buchungen (Server erzwingt es atomar) */}
      <BestaetigungsDialog
        offen={loeschDialog !== null}
        titel="Sprechzeit löschen?"
        beschreibung={
          loeschDialog
            ? `Die Sprechzeit „${loeschDialog.label}" wird entfernt. Sie hat keine Buchungen.`
            : undefined
        }
        bestaetigenLabel="Löschen"
        variante="gefahr"
        busy={isPending}
        onBestaetigen={handleSlotLoeschen}
        onAbbrechen={() => setLoeschDialog(null)}
      />
    </div>
  );
}
