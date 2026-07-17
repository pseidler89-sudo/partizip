/**
 * [tenant]/demo-verwaltung/page.tsx — Einstieg in die Verwaltungs-Perspektive
 * der Demo-Spielwiese (ONBOARDING-Spec Teil 1 §1, Block I).
 *
 * Existiert NUR auf dem Demo-Mandanten (isDemoTenant aus dem Host, sonst 404) —
 * auf echten Mandanten gibt es keinen Wegwerf-Verwaltungszugang. Die Seite
 * erklärt ehrlich, was passiert (ephemeres kommune_admin-Konto, nächtlicher
 * Reset, KEINE echten E-Mails/Posts dank Side-Effect-Fences) und startet den
 * Hands-on-Track. Die eigentliche Berechtigung erzeugt serverseitig
 * demoVerwaltungStarten() — der Start-Button ist nur der Auslöser.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { CheckCircle2 } from "lucide-react";
import { getTenantFromHost } from "@/lib/tenant";
import { isDemoTenant } from "@/lib/demo/config";
import { DemoVerwaltungStart } from "./DemoVerwaltungStart";

export const metadata: Metadata = {
  title: "Verwaltungs-Perspektive ausprobieren — Partizip",
  robots: { index: false },
};

const WAS_PASSIERT: string[] = [
  "Sie erhalten einen Wegwerf-Verwaltungszugang (Rolle Kommune-Admin) — ohne Anmeldung, ohne E-Mail-Adresse.",
  "Sie erstellen eine eigene Frage, aktivieren sie, stimmen als Bürger:in mit ab und schließen sie — die ganze Kette.",
  "Es passiert nichts Echtes: keine E-Mails, keine Beiträge in sozialen Netzwerken, keine Einladungen.",
  "Jede Nacht wird die Spielwiese zurückgesetzt — Ihr Zugang und alle erstellten Fragen verschwinden.",
];

export default async function DemoVerwaltungPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slugFromPath } = await params;

  // Tenant AUSSCHLIESSLICH über den Host (Muster [tenant]/layout.tsx) — und
  // hart nur auf dem Demo-Mandanten: überall sonst existiert die Seite nicht.
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath || !isDemoTenant(tenant.slug)) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
        style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
      >
        Demo-Spielwiese
      </span>
      <h1
        className="mt-4 text-3xl font-semibold tracking-tight"
        style={{ color: "var(--pz-ink)" }}
      >
        Verwaltungs-Perspektive ausprobieren
      </h1>
      <p className="mt-3 text-base leading-relaxed" style={{ color: "var(--pz-body)" }}>
        Sehen Sie Musterstadt mit den Augen der Verwaltung: Erstellen Sie selbst
        eine Frage, aktivieren Sie sie und schließen Sie sie wieder — gefahrlos,
        alles hier ist fiktiv.
      </p>

      <ul className="mt-6 space-y-3">
        {WAS_PASSIERT.map((punkt) => (
          <li key={punkt} className="flex items-start gap-2.5 text-sm leading-relaxed">
            <CheckCircle2
              aria-hidden
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={2}
              style={{ color: "var(--pz-brand-strong)" }}
            />
            <span style={{ color: "var(--pz-body)" }}>{punkt}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        <DemoVerwaltungStart slug={slugFromPath} />
      </div>
    </main>
  );
}
