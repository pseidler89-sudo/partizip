"use client";

/**
 * NavLink — Header-Navigations-Link mit aria-current="page" für den aktiven
 * Abschnitt (A11y: Screenreader hören „aktuelle Seite"; visuell dezent fetter).
 * Aktiv = exakter Pfad ODER Unterseite des Abschnitts (z. B. /umfrage/… unter
 * „Abstimmungen" zählt nicht — Abschnitte sind bewusst per Prefix gematcht).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  className,
  activeClassName,
  children,
}: {
  href: string;
  className?: string;
  /** Zusätzliche Klassen NUR im aktiven Zustand. */
  activeClassName?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const aktiv = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={aktiv ? "page" : undefined}
      className={`${className ?? ""}${aktiv && activeClassName ? ` ${activeClassName}` : ""}`}
    >
      {children}
    </Link>
  );
}
