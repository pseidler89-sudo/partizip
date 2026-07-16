/**
 * [tenant]/faq/page.tsx — eigenständige FAQ-Seite.
 *
 * Die FAQ lebte bisher nur als Landing-Sektion und war nach dem Setzen des
 * Region-Cookies unauffindbar. Diese Seite hält sie dauerhaft erreichbar
 * (Footer-Link); Inhalt aus der gemeinsamen Quelle faq-daten.ts.
 * Öffentlich (Stufe 0), im [tenant]-Layout gerendert.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { FAQ } from "../faq-daten";

export const metadata: Metadata = {
  title: "Häufige Fragen — Partizip",
  description:
    "Antworten auf häufige Fragen zu Partizip: Anonymität, Kosten, Anmeldung ohne Passwort, Mindestalter.",
};

export default async function FaqPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="text-center">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Häufige Fragen
        </h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Kurz beantwortet — ohne Fachsprache. Ihre Frage fehlt? Schreiben Sie uns
          über die Angaben im Impressum.
        </p>
      </header>

      <div className="mt-8 space-y-3">
        {FAQ.map((q) => (
          <details key={q.f} className="pz-card p-4">
            <summary
              className="cursor-pointer text-sm font-semibold marker:text-[color:var(--pz-brand-strong)]"
              style={{ color: "var(--pz-ink)" }}
            >
              {q.f}
            </summary>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
              {q.a}
            </p>
          </details>
        ))}
      </div>

      <p className="mt-10 text-center text-sm" style={{ color: "var(--pz-body)" }}>
        <Link
          href={`/${slug}/umfragen`}
          className="font-semibold underline-offset-4 hover:underline"
          style={{ color: "var(--pz-brand-strong)" }}
        >
          Zu den aktuellen Abstimmungen →
        </Link>
      </p>
    </main>
  );
}
