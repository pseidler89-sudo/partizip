/**
 * not-found.tsx — Globale 404-Seite
 *
 * Wird aufgerufen wenn notFound() in einem Layout/Page geworfen wird.
 * Neutraler Text — kein Hinweis ob Tenant existiert oder nicht.
 */

import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-semibold text-zinc-900">Seite nicht gefunden</h1>
      <p className="mt-3 text-zinc-500">
        Diese Kommune ist auf Partizip nicht aktiv.
      </p>
      <Link href="/" className="mt-6 text-sm text-[color:var(--pz-brand-strong)] underline">
        Zur Startseite
      </Link>
    </main>
  );
}
