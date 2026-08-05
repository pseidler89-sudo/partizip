/**
 * [tenant]/admin/layout.tsx — zentrales Zwei-Faktor-Gate für alle Admin-Flächen (#59).
 *
 * WARUM HIER UND NICHT IN JEDER SEITE: Unter /admin liegen zwölf Seiten, die
 * ihren Auth- und Rollen-Guard jeweils selbst mitbringen. Die Zwei-Faktor-Pflicht
 * dort ein dreizehntes Mal zu wiederholen, hieße, sie beim nächsten neuen
 * Unterverzeichnis genau einmal zu vergessen — und diese eine Lücke wäre das
 * ganze Feature. Das Layout läuft für jede Route darunter, auch für künftige.
 *
 * Das Gate ist BEWUSST schmal: Es prüft ausschließlich den zweiten Faktor.
 * Anmeldung und Rollen bleiben Sache der Seiten (die sie serverseitig ohnehin
 * prüfen), und die Server Actions sind unabhängig davon über requireAdminCtx
 * abgesichert. Ein Layout allein wäre kein ausreichender Schutz — es ist die
 * äußere von zwei Schichten, nicht die einzige.
 *
 * Nur ADMINS werden erfasst. `beobachter` haben eine reine Lesesicht auf das
 * Dashboard und fallen nicht unter die Pflicht aus #59.
 */

import { redirect } from "next/navigation";
import { getOptionalAuthContext, zweiFaktorLage } from "@/lib/auth/action-context";
import { getUserRoleTypes, isAdmin } from "@/lib/auth/roles";
import { zugangErlaubt } from "@/lib/auth/zwei-faktor";

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ tenant: string }>;
}

export default async function AdminLayout({ children, params }: LayoutProps) {
  const { tenant: slug } = await params;
  const ctx = await getOptionalAuthContext();

  // Kein Tenant oder nicht eingeloggt: durchreichen. Die Seiten darunter werfen
  // Ausgeloggte selbst auf /anmelden — hier doppelt umzuleiten würde nur die
  // Fehlermeldung verschlechtern.
  if (!ctx?.userId) return <>{children}</>;

  const admin = isAdmin(await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId));
  if (!admin) return <>{children}</>;

  const lage = await zweiFaktorLage(ctx, true);
  if (!zugangErlaubt(lage)) {
    redirect(
      lage.status === "code_faellig"
        ? `/${slug}/anmelden/bestaetigen?weiter=/${slug}/admin`
        : `/${slug}/konto/zwei-faktor?pflicht=1`
    );
  }

  return <>{children}</>;
}
