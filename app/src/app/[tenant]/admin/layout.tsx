/**
 * [tenant]/admin/layout.tsx — zentrales Zwei-Faktor-Gate für alle Admin-Flächen (#59).
 *
 * WARUM HIER UND NICHT IN JEDER SEITE: Unter /admin liegen zwölf Seiten, die
 * ihren Auth- und Rollen-Guard jeweils selbst mitbringen. Die Zwei-Faktor-Pflicht
 * dort ein dreizehntes Mal zu wiederholen, hieße, sie beim nächsten neuen
 * Unterverzeichnis genau einmal zu vergessen — und diese eine Lücke wäre das
 * ganze Feature. Das Layout läuft für jede Route darunter, auch für künftige.
 *
 * DIESES LAYOUT IST NICHT DER SCHUTZ, SONDERN NUR SEINE SICHTBARE SEITE.
 * Ein Layout wird beim RENDERN ausgewertet — ein Server-Action-POST führt die
 * Aktion aus, bevor irgendein Layout rendert, und ein `redirect()` hier käme
 * nach der Mutation. Der eigentliche Schutz sitzt deshalb in den Gates
 * (`requireAdminCtx` / `requireAdminStepUpCtx` in lib/auth/action-context.ts),
 * durch die JEDE mutierende Admin-Action laufen muss.
 *
 * Der Gate-B-Review vom 2026-08-05 hat genau hier einen BLOCKER gefunden: An
 * dieser Stelle stand, die Server Actions seien „unabhängig davon abgesichert" —
 * für rund die Hälfte stimmte das nicht, weil sie eigene Kopien des
 * Session-Lookups mitbrachten. Diese Kopien sind entfernt; ein Wächter-Test
 * (lib/auth/__tests__/kein-eigener-session-resolver.test.ts) verhindert, dass
 * die nächste neue Action-Datei die Lücke wieder aufreißt.
 *
 * Nur ADMINS werden erfasst. `beobachter` haben eine reine Lesesicht auf das
 * Dashboard und fallen nicht unter die Pflicht aus #59.
 */

import { redirect } from "next/navigation";
import { getOptionalAuthContext, zweiFaktorLage } from "@/lib/auth/action-context";
import { getUserRoleTypes, isAdmin } from "@/lib/auth/roles";
import { zugangErlaubt } from "@/lib/auth/zwei-faktor";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getOptionalAuthContext();

  // Kein Tenant oder nicht eingeloggt: durchreichen. Die Seiten darunter werfen
  // Ausgeloggte selbst auf /anmelden — hier doppelt umzuleiten würde nur die
  // Fehlermeldung verschlechtern.
  if (!ctx?.userId) return <>{children}</>;

  const admin = isAdmin(await getUserRoleTypes(ctx.db, ctx.tenant.id, ctx.userId));
  if (!admin) return <>{children}</>;

  const lage = zweiFaktorLage(ctx, true);
  if (!zugangErlaubt(lage)) {
    // Slug aus dem aufgelösten Tenant, NICHT aus dem Pfadsegment: Beide stimmen
    // im Pilotbetrieb überein, aber der Tenant der Prüfung kommt aus dem Host —
    // weichen sie ab, führte eine Umleitung auf das Pfadsegment ins Leere.
    const slug = ctx.tenant.slug;
    redirect(
      lage.status === "code_faellig"
        ? `/${slug}/anmelden/bestaetigen?weiter=/${slug}/admin`
        : `/${slug}/konto/zwei-faktor?pflicht=1`
    );
  }

  return <>{children}</>;
}
