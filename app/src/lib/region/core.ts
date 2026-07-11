/**
 * region/core.ts — reine Helfer für den PLZ-/Standort-Einstieg (ADR-015).
 *
 * BEWUSST ohne DB und ohne "use server": nur pure Funktionen (Cookie-Kodierung,
 * Haversine-Distanz, PLZ-Normalisierung). Direkt unit-testbar; von Server-
 * Komponenten, Queries und Actions gemeinsam genutzt.
 *
 * Das Region-Cookie `pz_region` ist KEIN Sicherheits-Token: es steuert nur,
 * welche Ortsteil-Ebenen-Umfragen ein ANONYMER Besucher sieht (reine
 * Personalisierung). Der Tenant ergibt sich aus dem Host (ADR-015), nicht aus
 * dem Cookie; Mitstimmen erfordert weiterhin Konto (Stufe 1) und nutzt den
 * echten `user.ortsteilId` — ein manipuliertes Cookie kann also nichts
 * freischalten, nur die Sicht eines nicht-eingeloggten Lesers verändern.
 */

/** Cookie-Name für die gemerkte Region/den Ortsteil. */
export const REGION_COOKIE_NAME = "pz_region";

/** Lebensdauer des Region-Cookies (1 Jahr). */
export const REGION_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Sentinel im Cookie für „Region bestätigt, aber kein Ortsteil" (Stadt-Ebene). */
const NO_ORTSTEIL = "-";

/** Plausibles Ortsteil-Code-Format (analog Seed-Codes: klein, a–z/0–9/-). */
const ORTSTEIL_CODE_RE = /^[a-z0-9-]{1,64}$/;

export interface RegionCookie {
  /** Gewählter Ortsteil-Code oder null (Region bestätigt, Stadt-Ebene). */
  ortsteilCode: string | null;
}

/**
 * Kodiert die Region für das Cookie. `null`/leer → Sentinel "-" (Region
 * bestätigt, kein Ortsteil). Sonst der Ortsteil-Code.
 */
export function serializeRegionCookie(ortsteilCode: string | null): string {
  return ortsteilCode && ortsteilCode.length > 0 ? ortsteilCode : NO_ORTSTEIL;
}

/**
 * Liest das Region-Cookie. Rückgabe:
 *   - null            → Cookie nicht gesetzt (→ Haustür anzeigen)
 *   - {ortsteilCode}  → Region bestätigt (ortsteilCode = null bei Stadt-Ebene)
 *
 * Defensiv: ein unplausibler Wert wird wie „Stadt-Ebene" behandelt (kein Fehler,
 * keine Ortsteil-Polls) — das Cookie ist nicht vertrauenswürdig.
 */
export function parseRegionCookie(raw: string | undefined | null): RegionCookie | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v === NO_ORTSTEIL) return { ortsteilCode: null };
  if (ORTSTEIL_CODE_RE.test(v)) return { ortsteilCode: v };
  // Unplausibler Wert → Region gilt als bestätigt, aber ohne Ortsteil.
  return { ortsteilCode: null };
}

/**
 * Normalisiert eine PLZ-Eingabe auf reine Ziffern (entfernt Leerzeichen etc.).
 */
export function normalizePlz(input: string): string {
  return input.replace(/\D/g, "");
}

/** Gültige deutsche PLZ = genau 5 Ziffern. */
export function isValidPlz(input: string): boolean {
  return /^\d{5}$/.test(normalizePlz(input));
}

/**
 * Tolerante PLZ-Korrektur für die Eingabe (P2 §Empf. 7, Fehlertoleranz): entfernt
 * Nicht-Ziffern und ergänzt bei genau 4 Ziffern eine führende 0 — PLZ wie 01067
 * (Dresden) werden oft ohne führende Null getippt. Andere Längen bleiben unverändert;
 * die endgültige Gültigkeit prüft weiterhin isValidPlz.
 */
export function coercePlz(input: string): string {
  const digits = normalizePlz(input);
  return digits.length === 4 ? `0${digits}` : digits;
}

/**
 * Haversine-Distanz zwischen zwei Koordinaten in Kilometern.
 * Reine Funktion (kein externer Geocoder) für die „Standort verwenden"-Auflösung.
 */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Erdradius km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Maximaler Abstand (km), bis zu dem ein Standort einer Region zugeordnet wird. */
export const STANDORT_MAX_KM = 30;
