/**
 * [tenant]/not-found.tsx — Tenant-spezifische 404-Seite
 *
 * Wird aufgerufen, wenn notFound() innerhalb eines gültigen Tenants geworfen wird,
 * z. B. bei ungültigen Pfaden wie /admin ohne Index-Seite.
 * Der Tenant ist bekannt → allgemeiner „Seite nicht gefunden"-Text (kein Tenant-Hinweis).
 *
 * Die Root-not-found.tsx mit „Diese Kommune ist auf Partizip nicht aktiv"
 * bleibt davon unberührt.
 */

import Link from "next/link";

export default function TenantNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-semibold text-zinc-900">Seite nicht gefunden</h1>
      <p className="mt-3 text-zinc-500">
        Diese Seite existiert leider nicht. Möglicherweise wurde der Link geändert oder die Adresse falsch eingegeben.
      </p>
      <Link href="/" className="mt-6 text-sm text-[color:var(--pz-brand-strong)] underline">
        Zur Startseite
      </Link>
    </main>
  );
}
