/**
 * [tenant]/konto/zwei-faktor/page.tsx — Einrichtung der Zwei-Faktor-Anmeldung (#59).
 *
 * Die Seite selbst ist reines Server-Rendering und entscheidet NUR, welcher der
 * drei Zustände gilt: bereits aktiv, Einrichtung offen, oder Einrichtung
 * verpflichtend (`?pflicht=1`, gesetzt vom Admin-Layout). Der eigentliche
 * Ablauf (Secret erzeugen, QR zeigen, Code bestätigen, Wiederherstellungscodes)
 * liegt in der Client-Komponente daneben — er braucht Zustand über mehrere
 * Schritte und ruft die Server Actions aus lib/auth/totp-actions.ts auf.
 *
 * Der Aktiv-Zustand bietet BEWUSST keine Neu-Einrichtung an: Ein aktiver zweiter
 * Faktor darf nicht durch einen Klick in einer übernommenen Session ersetzt
 * werden. Gerätewechsel läuft über den Betreiber (Wiederherstellungscode bzw.
 * Zurücksetzen), nicht über diese Seite.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { getOptionalAuthContext } from "@/lib/auth/action-context";
import { totpAktiv } from "@/lib/auth/zwei-faktor";
import ZweiFaktorEinrichtung from "./ZweiFaktorEinrichtung";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Zwei-Faktor-Anmeldung",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ pflicht?: string | string[] }>;
}

function datum(d: Date): string {
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
}

export default async function ZweiFaktorPage({ params, searchParams }: PageProps) {
  const { tenant: slug } = await params;
  const { pflicht } = await searchParams;

  const ctx = await getOptionalAuthContext();
  if (!ctx || ctx.tenant.slug !== slug) notFound();

  // Nicht angemeldet → Anmeldung mit Rückkehr auf genau diese Seite.
  if (!ctx.user) {
    redirect(`/${slug}/anmelden?next=${encodeURIComponent(`/${slug}/konto/zwei-faktor`)}`);
  }

  const aktiv = totpAktiv(ctx.user);
  const rohPflicht = Array.isArray(pflicht) ? pflicht[0] : pflicht;
  const istPflicht = rohPflicht === "1";
  const frist = ctx.user.totpGraceUntil;

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
        Zwei-Faktor-Anmeldung
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
        Zusätzlich zum Anmeldelink per E-Mail geben Sie einen sechsstelligen Code aus einer
        Authenticator-App ein. Wer Ihr E-Mail-Postfach übernimmt, kommt damit trotzdem nicht in
        Ihr Konto.
      </p>

      {istPflicht && !aktiv && (
        <div
          role="alert"
          className="mt-6 flex items-start gap-2.5 rounded-xl p-4"
          style={{ backgroundColor: "var(--pz-warning-soft)", color: "var(--pz-warning-ink)" }}
        >
          <ShieldAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={2} />
          <div className="text-sm">
            <p className="font-semibold">Für Ihr Admin-Konto ist die Einrichtung verpflichtend.</p>
            <p className="mt-1">
              Die Verwaltungsbereiche sind gesperrt, bis Sie die Zwei-Faktor-Anmeldung
              eingerichtet haben. Sie brauchen dafür eine Authenticator-App auf Ihrem Telefon und
              etwa zwei Minuten.
            </p>
          </div>
        </div>
      )}

      {!istPflicht && !aktiv && frist && (
        <p className="mt-6 text-sm" style={{ color: "var(--pz-body)" }}>
          Für Admin-Konten ist die Einrichtung ab dem {datum(frist)} zwingend erforderlich.
        </p>
      )}

      <div className="pz-card mt-6 p-6">
        {aktiv && ctx.user.totpConfirmedAt ? (
          <div className="flex items-start gap-3">
            <ShieldCheck
              aria-hidden
              className="mt-0.5 h-5 w-5 shrink-0"
              style={{ color: "var(--pz-success)" }}
              strokeWidth={2}
            />
            <div>
              <p className="text-base font-semibold" style={{ color: "var(--pz-ink)" }}>
                Zwei-Faktor-Anmeldung ist aktiv
              </p>
              <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
                Aktiv seit {datum(ctx.user.totpConfirmedAt)}. Bei der Anmeldung und vor besonders
                folgenreichen Aktionen fragen wir nach Ihrem Einmalcode.
              </p>
              <p className="mt-3 text-sm" style={{ color: "var(--pz-muted)" }}>
                Haben Sie Ihr Telefon verloren, melden Sie sich mit einem Ihrer
                Wiederherstellungscodes an. Sind auch die weg, wenden Sie sich an den Betreiber —
                aus Sicherheitsgründen lässt sich der zweite Faktor hier nicht einfach ersetzen.
              </p>
            </div>
          </div>
        ) : (
          <ZweiFaktorEinrichtung tenantSlug={slug} />
        )}
      </div>

      <p className="mt-6 text-sm">
        <Link href={`/${slug}/konto`} style={{ color: "var(--pz-brand-strong)" }}>
          Zurück zum Konto
        </Link>
      </p>
    </main>
  );
}
