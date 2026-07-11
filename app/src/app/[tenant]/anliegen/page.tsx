/**
 * [tenant]/anliegen/page.tsx — Öffentliche Anliegen-Tracker-Seite (Stufe 0)
 *
 * Eingabefeld für Tracking-Code + Erklärtext was der Tracker ist.
 * Keine Authentifizierung erforderlich.
 * Kein Vorwurf, nur Status (Kernprinzip 6).
 */

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getTenantFromHost } from "@/lib/tenant";
import AnliegenTrackerForm from "./AnliegenTrackerForm";

interface PageProps {
  params: Promise<{ tenant: string }>;
}

export default async function AnliegenPage({ params }: PageProps) {
  const { tenant: slugFromPath } = await params;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);

  if (!tenant || tenant.slug !== slugFromPath) notFound();

  return (
    <main className="min-h-screen px-4 py-12 max-w-lg mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>Anliegen verfolgen</h1>
        <p className="text-sm mt-2" style={{ color: "var(--pz-body)" }}>
          Hier können Sie den Status eines Anliegens mit dem Tracking-Code verfolgen —
          ohne Anmeldung. Geben Sie dazu den Code ein, den Sie bei der Einreichung
          (und per E-Mail) erhalten haben.
        </p>
        <p className="text-sm mt-3 pz-card p-3" style={{ color: "var(--pz-muted)" }}>
          Der Tracker zeigt den aktuellen Bearbeitungsstand und eine Zeitleiste der Statusänderungen.
          Alle Angaben sind neutral — der Tracker informiert, bewertet nicht.
        </p>
      </div>

      <AnliegenTrackerForm tenantSlug={slugFromPath} />

      {/* H4: Hinweis auf E-Mail-Code + eingeloggte Anliegen-Übersicht */}
      <p className="text-sm mt-4" style={{ color: "var(--pz-muted)" }}>
        Den Code haben wir Ihnen auch per E-Mail geschickt. Wenn Sie angemeldet sind, finden Sie Ihre
        Anliegen außerdem in Ihrem{" "}
        <a
          href={`/${slugFromPath}/konto`}
          className="hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Konto unter „Meine Anliegen“
        </a>
        .
      </p>

      <div className="mt-10 pt-6 border-t border-[color:var(--pz-line)]">
        <p className="text-sm" style={{ color: "var(--pz-muted)" }}>
          Sie haben noch kein Anliegen eingereicht?{" "}
          <a
            href={`/${slugFromPath}/anliegen/neu`}
            className="hover:underline font-medium rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]"
            style={{ color: "var(--pz-brand-strong)" }}
          >
            Jetzt Anliegen einreichen
          </a>
        </p>
      </div>
    </main>
  );
}
