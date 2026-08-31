/**
 * [tenant]/anmelden/bestaetigen/page.tsx — Abfrage des Einmalcodes (#59).
 *
 * Deckt beide Fälle ab, weil beide dieselbe Frage stellen:
 *   - Anmeldung: Session besteht, wurde aber noch nie mit einem Code bestätigt.
 *   - Step-up:   die Bestätigung ist zu alt für eine folgenreiche Aktion.
 * Unterschieden wird nur im Text; die Prüfung selbst liegt serverseitig in
 * bestaetigeCode() bzw. loeseWiederherstellungscodeEin().
 *
 * OPEN-REDIRECT: `?weiter=` ist Nutzereingabe und wird HIER serverseitig durch
 * safeRedirectPath() geschickt (nur same-origin-relative Pfade). Die
 * Client-Komponente bekommt ausschließlich den geprüften Pfad — der Rohwert
 * verlässt diese Datei nicht.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getOptionalAuthContext } from "@/lib/auth/action-context";
import { totpAktiv } from "@/lib/auth/zwei-faktor";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";
import CodeBestaetigen from "./CodeBestaetigen";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Anmeldung bestätigen",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ weiter?: string | string[] }>;
}

export default async function BestaetigenPage({ params, searchParams }: PageProps) {
  const { tenant: slug } = await params;
  const { weiter } = await searchParams;

  const ctx = await getOptionalAuthContext();
  if (!ctx || ctx.tenant.slug !== slug) notFound();

  // Ohne Session gibt es nichts zu bestätigen → normale Anmeldung.
  if (!ctx.user) redirect(`/${slug}/anmelden`);

  // Ohne aktives TOTP führt kein Code weiter → erst einrichten.
  if (!totpAktiv(ctx.user)) redirect(`/${slug}/konto/zwei-faktor`);

  // Degenerierter Query-String (?weiter=a&weiter=b) → der erste Wert zählt,
  // wie bei ?next= auf der Magic-Link-Seite.
  const rohWeiter = Array.isArray(weiter) ? weiter[0] : weiter;
  const ziel = safeRedirectPath(rohWeiter, `/${slug}/admin`);

  return (
    <main className="mx-auto max-w-md px-4 py-14">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Anmeldung bestätigen
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Bitte geben Sie den sechsstelligen Code aus Ihrer Authenticator-App ein. Er wechselt
          alle 30 Sekunden.
        </p>
      </div>
      <div className="pz-card p-6">
        <CodeBestaetigen tenantSlug={slug} ziel={ziel} />
      </div>
    </main>
  );
}
