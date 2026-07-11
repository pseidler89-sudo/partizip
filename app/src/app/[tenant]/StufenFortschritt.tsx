/**
 * StufenFortschritt.tsx — positive Inszenierung des Stufenmodells (P1, CANNANAS_EVAL §Empf. 3).
 *
 * Statt eines reinen Verbots-Texts („nur verifizierte Bürger:innen") zeigt diese
 * Komponente den Weg als FORTSCHRITT: „Stufe 1 erreicht ✓ → Stufe 2 schaltet
 * verbindliche Abstimmungen frei". Rein präsentational (keine Hooks/Client-APIs) →
 * in Server- UND Client-Bäumen verwendbar (z. B. in PollMitmachen).
 *
 * DATENSPARSAM: zeigt NUR die Stufe + was sie freischaltet — keine Adresse, kein
 * Verifizierungsdatum, keine PII. Der Verweis nennt bewusst „nur, DASS der Wohnsitz
 * bestätigt ist".
 *
 * Aufgerufen nur für eingeloggte Nutzer (Stufe ≥ 1). Stufe 2 ist der Zielzustand;
 * bei `variant="inline"` zeigt Stufe 2 eine dezente Bestätigung statt einer CTA.
 */

import Link from "next/link";

interface Props {
  /** Aktuelle Stufe des eingeloggten Nutzers (1 = angemeldet, 2 = wohnsitz-verifiziert). */
  stufe: 1 | 2;
  tenantSlug: string;
  /**
   * "card"   — eigenständige Karte (Ersatz für die Abstimm-Buttons bei
   *            verbindlichen Polls, die Stufe 1 noch nicht abstimmen darf).
   * "inline" — schmaler Streifen (Startseite/Konto).
   */
  variant?: "card" | "inline";
}

const VERIFY_HINT =
  "Wir speichern dafür nur, DASS Ihr Wohnsitz bestätigt ist — keine Adresse.";

export default function StufenFortschritt({ stufe, tenantSlug, variant = "card" }: Props) {
  const verifyHref = `/${tenantSlug}/verifizieren`;

  // Stufe 2 erreicht: dezente Bestätigung (nur im schmalen Streifen sinnvoll).
  if (stufe >= 2) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium"
        style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
      >
        <span aria-hidden>✓</span>
        Wohnsitz bestätigt (Stufe 2) — Sie stimmen auch bei verbindlichen Abstimmungen mit.
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[color:var(--pz-line)] bg-[color:var(--pz-surface)] px-4 py-3">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
        >
          <span aria-hidden>✓</span> Stufe 1 erreicht
        </span>
        <span className="text-xs" style={{ color: "var(--pz-body)" }}>
          Wohnsitz bestätigen, um bei <strong>verbindlichen</strong> Abstimmungen mitzustimmen.
        </span>
        <Link
          href={verifyHref}
          className="ml-auto whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
          style={{ backgroundColor: "var(--pz-brand)" }}
        >
          Wohnsitz bestätigen →
        </Link>
      </div>
    );
  }

  // variant "card": Ersatz für die Abstimm-Buttons bei verbindlichen Polls.
  return (
    <div
      className="rounded-lg border border-[color:var(--pz-line)] p-4"
      style={{ backgroundColor: "var(--pz-surface)" }}
    >
      <p className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
        Noch ein Schritt bis zur verbindlichen Stimme
      </p>
      <ol className="mt-3 space-y-2.5">
        <li className="flex items-start gap-2.5">
          <span
            aria-hidden
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
          >
            ✓
          </span>
          <span className="text-sm" style={{ color: "var(--pz-body)" }}>
            <strong>Stufe 1 erreicht</strong> — Sie stimmen bei Stimmungsbildern mit.
          </span>
        </li>
        <li className="flex items-start gap-2.5">
          <span
            aria-hidden
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold"
            style={{ borderColor: "var(--pz-brand)", color: "var(--pz-brand-strong)" }}
          >
            2
          </span>
          <span className="text-sm" style={{ color: "var(--pz-body)" }}>
            <strong>Wohnsitz bestätigen (Stufe 2)</strong> — schaltet verbindliche Abstimmungen frei.
          </span>
        </li>
      </ol>
      <Link
        href={verifyHref}
        className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
        style={{ backgroundColor: "var(--pz-brand)" }}
      >
        Jetzt Wohnsitz bestätigen →
      </Link>
      <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        {VERIFY_HINT}
      </p>
    </div>
  );
}
