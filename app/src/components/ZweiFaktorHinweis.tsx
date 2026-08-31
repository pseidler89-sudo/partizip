/**
 * ZweiFaktorHinweis.tsx — Ausweg aus einem abgelehnten Step-up (Review #59, Befund 2).
 *
 * PROBLEM: Die Gates in lib/auth/action-context.ts geben bei fehlender frischer
 * Bestätigung ein Feld `zweiFaktor: "code" | "einrichten"` zurück. Wertet es
 * niemand aus, sieht der Nutzer nur den Satz „Diese Aktion verlangt eine frische
 * Bestätigung mit Ihrem Einmalcode." — ohne Knopf, ohne Pfad. Das trifft jeden
 * Arbeitsblock, der länger als 15 Minuten dauert.
 *
 * EINBINDUNG in eine Admin-UI: Das Ergebnis der Server Action im State halten
 * und unverändert durchreichen — die Komponente rendert NICHTS, wenn kein
 * `zweiFaktor`-Feld dabei ist:
 *
 *   const [ergebnis, setErgebnis] = useState<Awaited<ReturnType<typeof assignRole>> | null>(null);
 *   …
 *   const r = await assignRole(formData);
 *   setErgebnis(r);
 *   …
 *   <ZweiFaktorHinweis ergebnis={ergebnis} />
 *
 * Sie ersetzt die Fehlermeldung nicht, sondern ergänzt sie um den Weg dorthin.
 * `weiter` zeigt standardmäßig auf den aktuellen Pfad (usePathname), sodass die
 * Bestätigung genau hierher zurückführt. Wo der Query-String mitzählt, gibt die
 * einbindende Seite ihn als Prop mit — bewusst kein useSearchParams(): Der Hook
 * verlangt in Next eine Suspense-Grenze und würde jede einbindende Seite zu
 * ihrer Pflege zwingen, für einen Randfall.
 *
 * KEIN next/link: Ziel ist bewusst ein voller Dokument-Load. Nach der
 * Bestätigung müssen die Server-Layouts (u. a. das Zwei-Faktor-Gate unter
 * /admin) mit der frisch bestätigten Session neu rendern — eine
 * Client-Navigation liefe auf eine zwischengespeicherte, noch gesperrte Ansicht
 * (gleiche Begründung wie in anmelden/bestaetigen/CodeBestaetigen.tsx).
 */

"use client";

import { useParams, usePathname } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import type { ZweiFaktorBedarf } from "@/lib/auth/action-context";

/**
 * Nur ein Typ-Import (oben): `action-context` ist ein SERVER-Modul (next/headers,
 * Drizzle, DB-Client). `import type` wird beim Kompilieren restlos entfernt und
 * zieht nichts davon ins Client-Bündel — dafür bleibt der Bedarfs-Typ an genau
 * einer Stelle definiert.
 */
export interface ZweiFaktorErgebnis {
  zweiFaktor?: ZweiFaktorBedarf;
}

interface HinweisDaten {
  titel: string;
  text: string;
  linkText: string;
  href: string | null;
}

/**
 * Reine Ableitung aus Bedarf, Mandant und Rückkehrziel — ohne React testbar.
 *
 * Zwei Ziele, weil zwei verschiedene Lagen:
 *   - "code":       TOTP ist eingerichtet, die Bestätigung fehlt oder ist zu alt
 *                   → Bestätigungsseite, mit Rückkehr per ?weiter=.
 *   - "einrichten": Es gibt gar keinen zweiten Faktor → Einrichtungsseite. Ein
 *                   ?weiter= wäre dort sinnlos: Nach der Einrichtung steht der
 *                   Nutzer vor den Wiederherstellungscodes, die er erst sichern
 *                   soll — ihn davon wegzuleiten wäre der teuerste Klick der App.
 *
 * Ohne Mandanten-Slug (Komponente außerhalb von /[tenant] eingesetzt) bleibt
 * `href` null: Dann steht der Hinweis ohne Link da, statt auf einen geratenen
 * Pfad zu zeigen.
 */
export function zweiFaktorHinweisDaten(params: {
  bedarf: ZweiFaktorBedarf;
  tenantSlug: string | null;
  /** Rückkehrziel der Bestätigung — ein relativer Pfad, optional mit Query. */
  weiter: string | null;
}): HinweisDaten {
  const { bedarf, tenantSlug, weiter } = params;

  if (bedarf === "einrichten") {
    return {
      titel: "Zwei-Faktor-Anmeldung erforderlich",
      text: "Für Admin-Konten ist die Zwei-Faktor-Anmeldung Pflicht. Richten Sie sie einmalig ein — Sie brauchen dafür eine Authenticator-App und etwa zwei Minuten.",
      linkText: "Zwei-Faktor-Anmeldung einrichten",
      href: tenantSlug ? `/${tenantSlug}/konto/zwei-faktor` : null,
    };
  }

  // ?weiter= ist Nutzer-nahe Eingabe und wird auf der Zielseite serverseitig
  // durch safeRedirectPath() geprüft (nur same-origin-relative Pfade) — hier
  // wird nur kodiert.
  const ziel =
    tenantSlug === null
      ? null
      : weiter
        ? `/${tenantSlug}/anmelden/bestaetigen?weiter=${encodeURIComponent(weiter)}`
        : `/${tenantSlug}/anmelden/bestaetigen`;

  return {
    titel: "Bestätigung erforderlich",
    text: "Diese Aktion verlangt eine frische Bestätigung mit Ihrem Einmalcode. Bestätigen Sie kurz Ihre Anmeldung — danach kehren Sie hierher zurück.",
    linkText: "Jetzt bestätigen",
    href: ziel,
  };
}

export default function ZweiFaktorHinweis({
  ergebnis,
  tenantSlug,
  weiter,
}: {
  /** Ergebnis einer Server Action; ohne `zweiFaktor`-Feld wird nichts gerendert. */
  ergebnis: ZweiFaktorErgebnis | null | undefined;
  /** Überschreibt den Mandanten aus der Route (Normalfall: weglassen). */
  tenantSlug?: string;
  /** Überschreibt das Rückkehrziel (Normalfall: die aktuelle Seite). */
  weiter?: string;
}) {
  const params = useParams<{ tenant?: string }>();
  const pfad = usePathname();

  const slug = tenantSlug ?? params?.tenant ?? null;
  const bedarf = ergebnis?.zweiFaktor;
  if (!bedarf) return null;

  const daten = zweiFaktorHinweisDaten({
    bedarf,
    tenantSlug: slug,
    weiter: weiter ?? pfad ?? null,
  });

  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2.5 rounded-xl p-4"
      style={{ backgroundColor: "var(--pz-warning-soft)", color: "var(--pz-warning-ink)" }}
    >
      <ShieldAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={2} />
      <div className="text-sm">
        <p className="font-semibold">{daten.titel}</p>
        <p className="mt-1">{daten.text}</p>
        {daten.href && (
          <p className="mt-2">
            <a href={daten.href} className="font-medium underline">
              {daten.linkText}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
