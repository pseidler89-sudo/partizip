/**
 * [tenant]/impressum/page.tsx — Impressum (§ 5 DDG, § 18 MStV)
 *
 * Inhalt zentral aus lib/legal/anbieter.ts; Volltext-Entwurf + Anwalts-Anmerkungen
 * in docs/legal/IMPRESSUM_ENTWURF.md. Solange Platzhalter offen sind, wird ein
 * Entwurfs-Hinweis angezeigt (Launch-Gate P0-5).
 */

import type { Metadata } from "next";
import { ANBIETER, ANGABEN_VOLLSTAENDIG } from "@/lib/legal/anbieter";

export const metadata: Metadata = {
  title: "Impressum — Partizip",
  robots: { index: false },
};

export default function ImpressumPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Impressum</h1>

      {!ANGABEN_VOLLSTAENDIG && (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Entwurfsfassung — die endgültigen Angaben werden vor dem Start der
          Plattform veröffentlicht.
        </p>
      )}

      <section className="mt-6 space-y-1">
        <h2 className="font-medium" style={{ color: "var(--pz-ink)" }}>Diensteanbieter (§ 5 DDG)</h2>
        <p>{ANBIETER.name}</p>
        <p>{ANBIETER.strasse}</p>
        <p>{ANBIETER.ort}</p>
        <p>{ANBIETER.land}</p>
      </section>

      <section className="mt-6 space-y-1">
        <h2 className="font-medium" style={{ color: "var(--pz-ink)" }}>Kontakt</h2>
        <p>E-Mail: {ANBIETER.email}</p>
        {ANBIETER.telefon && <p>Telefon: {ANBIETER.telefon}</p>}
      </section>

      <section className="mt-6 space-y-1">
        <h2 className="font-medium" style={{ color: "var(--pz-ink)" }}>
          Verantwortlich für journalistisch-redaktionelle Inhalte
          (§ 18 Abs. 2 MStV)
        </h2>
        <p>{ANBIETER.visdp}</p>
      </section>

      <section className="mt-6 space-y-1">
        <h2 className="font-medium" style={{ color: "var(--pz-ink)" }}>Verbraucherstreitbeilegung (§ 36 VSBG)</h2>
        <p>
          Wir sind nicht bereit und nicht verpflichtet, an
          Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle
          teilzunehmen.
        </p>
      </section>
    </main>
  );
}
