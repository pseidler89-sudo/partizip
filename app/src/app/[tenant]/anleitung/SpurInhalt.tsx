/**
 * SpurInhalt.tsx — rendert EINE Anleitungs-Spur nach dem festen Muster:
 * erster Satz → „So läuft es ab" → „Das sollten Sie wissen" → Nachschlag-Fragen
 * → weiterführende Links.
 *
 * SERVER-KOMPONENTE OHNE JavaScript-Bedarf: Die Seiten müssen ohne JS vollständig
 * lesbar sein — das ist der Vorteil gegenüber einer Folienmechanik. Deshalb
 * natives details/summary statt Akkordeon-Skript, Listen statt Karussell, keine
 * Interaktion, die Zustand braucht.
 *
 * ÜBERSCHRIFTEN-HIERARCHIE: Der Aufrufer gibt über `ebene` an, auf welcher Stufe
 * die Abschnitts-Überschriften liegen — 2 auf der Ein-Spur-Seite (h1 ist dort der
 * Spur-Titel), 3 auf der Sammelseite (dort ist h2 der Spur-Titel). Damit
 * entstehen in beiden Fällen lückenlose Hierarchien (h1 → h2 → h3), was das
 * a11y-Gate der CI erwartet.
 */

import Link from "next/link";
import type { AnleitungLink, AnleitungSpur } from "./anleitung-daten";

/** Tenant-relative Pfade bekommen das Slug-Präfix; `absolut` bleibt unberührt. */
export function anleitungHref(link: AnleitungLink, slug: string): string {
  return link.absolut ? link.href : `/${slug}${link.href}`;
}

const LINK_KLASSEN =
  "font-medium underline-offset-4 hover:underline rounded-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)]";

/** Ein Sprung-Link in die App — intern über next/link, absolut als normales <a>. */
function SprungLink({ link, slug }: { link: AnleitungLink; slug: string }) {
  const href = anleitungHref(link, slug);
  const inhalt = (
    <>
      {link.label} <span aria-hidden>→</span>
    </>
  );
  if (link.absolut) {
    return (
      <a href={href} className={LINK_KLASSEN} style={{ color: "var(--pz-brand-strong)" }}>
        {inhalt}
      </a>
    );
  }
  return (
    <Link href={href} className={LINK_KLASSEN} style={{ color: "var(--pz-brand-strong)" }}>
      {inhalt}
    </Link>
  );
}

/**
 * Abschnitts-Überschrift auf der vom Aufrufer bestimmten Ebene. Bewusst nur h2/h3:
 * tiefer wird die Anleitung nicht, und h1 gehört immer der Seite.
 */
function AbschnittTitel({
  ebene,
  id,
  children,
}: {
  ebene: 2 | 3;
  id: string;
  children: React.ReactNode;
}) {
  const klassen = ebene === 2 ? "text-xl font-semibold" : "text-lg font-semibold";
  if (ebene === 2) {
    return (
      <h2 id={id} className={klassen} style={{ color: "var(--pz-ink)" }}>
        {children}
      </h2>
    );
  }
  return (
    <h3 id={id} className={klassen} style={{ color: "var(--pz-ink)" }}>
      {children}
    </h3>
  );
}

export default function SpurInhalt({
  spur,
  slug,
  ebene,
}: {
  spur: AnleitungSpur;
  slug: string;
  ebene: 2 | 3;
}) {
  return (
    <>
      <p className="mt-3 text-base leading-relaxed" style={{ color: "var(--pz-body)" }}>
        {spur.ersterSatz}
      </p>

      {/* --- So läuft es ab ------------------------------------------------ */}
      <section className="mt-8" aria-labelledby={`${spur.id}-ablauf`}>
        <AbschnittTitel ebene={ebene} id={`${spur.id}-ablauf`}>
          So läuft es ab
        </AbschnittTitel>
        {/* Die Nummerierung kommt aus dem <ol> (Screenreader lesen sie mit); die
            sichtbare Ziffer ist deshalb dekorativ und wird ausgeblendet. */}
        <ol className="mt-4 space-y-4">
          {spur.schritte.map((schritt, i) => (
            <li key={schritt.titel} className="pz-card flex gap-4 p-5">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums"
                style={{ backgroundColor: "var(--pz-brand-soft)", color: "var(--pz-brand-strong)" }}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="font-semibold" style={{ color: "var(--pz-ink)" }}>
                  {schritt.titel}
                </p>
                <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
                  {schritt.text}
                </p>
                {schritt.link && (
                  <p className="mt-2 text-sm">
                    <SprungLink link={schritt.link} slug={slug} />
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* --- Das sollten Sie wissen ---------------------------------------- */}
      <section className="mt-10" aria-labelledby={`${spur.id}-wissen`}>
        <AbschnittTitel ebene={ebene} id={`${spur.id}-wissen`}>
          Das sollten Sie wissen
        </AbschnittTitel>
        <ul className="mt-4 space-y-4">
          {spur.wissen.map((h) => (
            <li key={h.titel} className="pz-card p-5">
              <p className="font-semibold" style={{ color: "var(--pz-ink)" }}>
                {h.titel}
              </p>
              <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
                {h.text}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* --- Nachschlag-Fragen (details/summary, ohne JavaScript bedienbar) - */}
      <section className="mt-10" aria-labelledby={`${spur.id}-fragen`}>
        <AbschnittTitel ebene={ebene} id={`${spur.id}-fragen`}>
          Wenn etwas nicht klappt
        </AbschnittTitel>
        <div className="mt-4 space-y-3">
          {spur.fragen.map((q) => (
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
      </section>

      {/* --- Weiterlesen: verlinken statt Inhalte doppelt pflegen ----------- */}
      {spur.weiter.length > 0 && (
        <section className="mt-10" aria-labelledby={`${spur.id}-weiter`}>
          <AbschnittTitel ebene={ebene} id={`${spur.id}-weiter`}>
            Weiterlesen
          </AbschnittTitel>
          <ul className="mt-3 space-y-2 text-sm">
            {spur.weiter.map((w) => (
              <li key={w.href}>
                <SprungLink link={w} slug={slug} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
