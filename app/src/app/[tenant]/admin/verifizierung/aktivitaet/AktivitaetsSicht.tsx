/**
 * AktivitaetsSicht.tsx — Darstellung der Team-Aktivität + Auffälligkeiten
 * (Block K4). REINE Server-Komponente (keine Mutationen, kein State) — sie
 * rendert die vom page.tsx geladenen Aggregate.
 *
 * Layout (Spec §7): (1) Auffälligkeiten zuoberst, (2) Verifier-Aktivität,
 * (3) QR-Ausschöpfung, (4) Standort-Termine. Zahlen rechtsbündig, Tabellen in
 * overflow-x-auto-Containern. Enthält KEINE Bürger-PII — nur Rollenträger-
 * E-Mails, QR-Labels und Standortnamen.
 */

import { regionTypLabel } from "@/lib/region/ebenen";
import type {
  QrAusschoepfung,
  StandortTermine,
  Auffaelligkeit,
} from "@/lib/verification/aktivitaet-queries";

interface VerifierZeile {
  email: string | null;
  hatVerifierRolle: boolean;
  qrGesamt: number;
  qrAktiv: number;
  einloesungen7d: number;
  einloesungen30d: number;
  einloesungenGesamt: number;
  /** ISO-String oder null. */
  letzteEinloesung: string | null;
}

interface Props {
  verifier: VerifierZeile[];
  ausschoepfung: QrAusschoepfung[];
  standorte: StandortTermine[];
  auffaelligkeiten: Auffaelligkeit[];
}

/** Deutsches Kurzdatum (Europe/Berlin) aus einem ISO-String. */
function kurzDatum(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(d);
}

const TH = "px-3 py-2 text-left font-medium";
const THR = "px-3 py-2 text-right font-medium";
const TD = "px-3 py-2";
const TDR = "px-3 py-2 text-right tabular-nums";

export function AktivitaetsSicht({ verifier, ausschoepfung, standorte, auffaelligkeiten }: Props) {
  return (
    <div className="space-y-10">
      {/* (1) Auffälligkeiten */}
      <section>
        <h2 className="mb-3 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          Auffälligkeiten
        </h2>
        {auffaelligkeiten.length === 0 ? (
          <div
            className="rounded-lg border p-4 text-sm"
            style={{ borderColor: "var(--pz-line)" }}
          >
            <p className="font-medium" style={{ color: "var(--pz-success)" }}>
              Keine Auffälligkeiten.
            </p>
            <p className="mt-1" style={{ color: "var(--pz-muted)" }}>
              Geprüft wird: fast ausgeschöpfte QR-Codes (ab {Math.round(0.8 * 100)}&nbsp;%),
              ungewöhnlich viele Einlösungen an einem Tag je Verifizierer:in
              (Spitzen im 7-Tage-Fenster) sowie Einlösungen über QR-Codes von
              Konten, die keine Verifizierer-Rolle mehr tragen.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {auffaelligkeiten.map((a, i) => (
              <li
                key={`${a.typ}-${i}`}
                className="rounded-lg border p-3 text-sm"
                style={{ borderColor: "var(--pz-line)" }}
              >
                <span
                  className={`mr-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium align-middle ${
                    a.typ === "rollen_entzug" ? "pz-badge-danger" : "pz-badge-warning"
                  }`}
                >
                  {a.typ === "qr_ausschoepfung"
                    ? "QR fast ausgeschöpft"
                    : a.typ === "einloese_spitze"
                      ? "Einlöse-Spitze"
                      : "Aktivität nach Rollen-Entzug"}
                </span>
                <span style={{ color: "var(--pz-body)" }}>{a.beschreibung}</span>
                <span className="block text-xs mt-1" style={{ color: "var(--pz-muted)" }}>
                  {a.bezug}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* (2) Verifier-Aktivität */}
      <section>
        <h2 className="mb-3 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          Verifizierer:innen-Aktivität
        </h2>
        {verifier.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
            Noch keine QR-Codes angelegt.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--pz-line)" }}>
            <table className="w-full text-sm" style={{ color: "var(--pz-body)" }}>
              <thead style={{ color: "var(--pz-muted)" }}>
                <tr className="border-b" style={{ borderColor: "var(--pz-line)" }}>
                  <th className={TH}>Verifizierer:in</th>
                  <th className={THR}>QR aktiv/ges.</th>
                  <th className={THR}>7 Tage</th>
                  <th className={THR}>30 Tage</th>
                  <th className={THR}>gesamt</th>
                  <th className={THR}>letzte Einlösung</th>
                </tr>
              </thead>
              <tbody>
                {verifier.map((v, i) => (
                  <tr key={i} className="border-b last:border-0" style={{ borderColor: "var(--pz-line)" }}>
                    <td className={TD}>
                      {v.email ?? <span style={{ color: "var(--pz-muted)" }}>(Ersteller entfernt)</span>}
                      {!v.hatVerifierRolle && v.email && (
                        <span className="ml-2 text-xs" style={{ color: "var(--pz-danger)" }}>
                          (Rolle entzogen)
                        </span>
                      )}
                    </td>
                    <td className={TDR}>
                      {v.qrAktiv}/{v.qrGesamt}
                    </td>
                    <td className={TDR}>{v.einloesungen7d}</td>
                    <td className={TDR}>{v.einloesungen30d}</td>
                    <td className={TDR}>{v.einloesungenGesamt}</td>
                    <td className={TDR}>{kurzDatum(v.letzteEinloesung)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* (3) QR-Ausschöpfung */}
      <section>
        <h2 className="mb-3 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          QR-Ausschöpfung (aktive Codes)
        </h2>
        {ausschoepfung.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
            Keine aktiven QR-Codes.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--pz-line)" }}>
            <table className="w-full text-sm" style={{ color: "var(--pz-body)" }}>
              <thead style={{ color: "var(--pz-muted)" }}>
                <tr className="border-b" style={{ borderColor: "var(--pz-line)" }}>
                  <th className={TH}>QR-Code</th>
                  <th className={TH}>Gebiet</th>
                  <th className={TH}>Ersteller:in</th>
                  <th className={THR}>Einlösungen</th>
                  <th className={THR}>Quote</th>
                </tr>
              </thead>
              <tbody>
                {ausschoepfung.map((q) => (
                  <tr key={q.qrCodeId} className="border-b last:border-0" style={{ borderColor: "var(--pz-line)" }}>
                    <td className={TD}>{q.label ?? <span style={{ color: "var(--pz-muted)" }}>(ohne Bezeichnung)</span>}</td>
                    <td className={TD}>
                      {regionTypLabel(q.regionTyp)}
                      {q.regionTyp === "ortsteil" ? ` (${q.regionName})` : ""}
                    </td>
                    <td className={TD}>
                      {q.createdByEmail ?? <span style={{ color: "var(--pz-muted)" }}>—</span>}
                    </td>
                    <td className={TDR}>
                      {q.redemptionCount}/{q.maxRedemptions}
                    </td>
                    <td
                      className={TDR}
                      style={q.quote >= 0.8 ? { color: "var(--pz-danger)", fontWeight: 600 } : undefined}
                    >
                      {Math.round(q.quote * 100)}&nbsp;%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* (4) Standort-Termine */}
      <section>
        <h2 className="mb-3 text-lg font-semibold" style={{ color: "var(--pz-ink)" }}>
          Termine je Standort
        </h2>
        {standorte.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
            Keine Standorte angelegt.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--pz-line)" }}>
            <table className="w-full text-sm" style={{ color: "var(--pz-body)" }}>
              <thead style={{ color: "var(--pz-muted)" }}>
                <tr className="border-b" style={{ borderColor: "var(--pz-line)" }}>
                  <th className={TH}>Standort</th>
                  <th className={THR}>wahrgen. 7 Tage</th>
                  <th className={THR}>30 Tage</th>
                  <th className={THR}>gesamt</th>
                  <th className={THR}>offen (künftig)</th>
                </tr>
              </thead>
              <tbody>
                {standorte.map((s) => (
                  <tr key={s.locationId} className="border-b last:border-0" style={{ borderColor: "var(--pz-line)" }}>
                    <td className={TD}>
                      {s.name}
                      {!s.isActive && (
                        <span className="ml-2 text-xs" style={{ color: "var(--pz-muted)" }}>
                          (inaktiv)
                        </span>
                      )}
                    </td>
                    <td className={TDR}>{s.wahrgenommen7d}</td>
                    <td className={TDR}>{s.wahrgenommen30d}</td>
                    <td className={TDR}>{s.wahrgenommenGesamt}</td>
                    <td className={TDR}>{s.offeneKuenftige}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
