/**
 * [tenant]/admin/interessenten/page.tsx — Betreiber-Sicht auf „Mitmachen"-Leads
 * (Block N3). NUR super_admin (Plattform-Betreiber), NICHT kommune_admin.
 *
 * BESONDERHEIT (bewusste Ausnahme vom scopedDb-Zwang): `interessenten` ist
 * tenant-FREI (ein Lead entsteht vor der Tenant-Existenz). Deshalb greift die
 * Query hier ROH auf `db`/`interessenten` zu — es gibt keine tenant_id, nach der
 * gescoped werden könnte. Legitimiert durch das super_admin-Gate davor
 * (requireSuperAdminCtx); ein kommune_admin sieht diese Seite nie.
 */

import { notFound } from "next/navigation";
import { desc } from "drizzle-orm";
import { interessenten } from "@/db/schema";
import { requireSuperAdminCtx } from "@/lib/auth/action-context";
import InteressentenListe from "./InteressentenListe";

export const dynamic = "force-dynamic";

const QUELLE_LABELS: Record<string, string> = {
  formular: "Formular",
  tymeslot: "Termin",
};

export default async function AdminInteressentenPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slugFromPath } = await params;

  // super_admin-Gate. Jede Nicht-Berechtigung → 404 (kein Existenz-Leak).
  const gate = await requireSuperAdminCtx();
  if (!gate.ok) notFound();
  const { ctx } = gate;
  if (ctx.tenant.slug !== slugFromPath) notFound();

  // ROHER db-Zugriff (Begründung siehe Datei-Kopf): tenant-freie Betreiber-Tabelle.
  const rows = await ctx.db
    .select({
      id: interessenten.id,
      kommune: interessenten.kommune,
      ansprechpartner: interessenten.ansprechpartner,
      email: interessenten.email,
      quelle: interessenten.quelle,
      terminAm: interessenten.terminAm,
      status: interessenten.status,
      createdAt: interessenten.createdAt,
    })
    .from(interessenten)
    .orderBy(desc(interessenten.createdAt));

  const liste = rows.map((r: (typeof rows)[number]) => ({
    id: r.id,
    kommune: r.kommune,
    ansprechpartner: r.ansprechpartner,
    email: r.email,
    quelleLabel: QUELLE_LABELS[r.quelle] ?? r.quelle,
    termin: r.terminAm ? r.terminAm.toLocaleString("de-DE") : null,
    status: r.status,
    datum: r.createdAt.toLocaleDateString("de-DE"),
  }));

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Interessenten
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--pz-muted)" }}>
          Leads aus dem &bdquo;Mitmachen&ldquo;-Trichter und aus Terminbuchungen — {liste.length} gesamt.
          Neueste zuerst.
        </p>
      </header>

      {liste.length === 0 ? (
        <div className="pz-card p-8 text-center text-sm" style={{ color: "var(--pz-muted)" }}>
          Noch keine Interessenten.
        </div>
      ) : (
        <InteressentenListe eintraege={liste} />
      )}
    </main>
  );
}
