"use client";

/**
 * LoginEntry.tsx — der „Anmelden"-Einstieg in der Navigation (ADR-017).
 *
 * Rendert den Nav-Button + das globale LoginModal. Öffnet bei Klick UND bei einem
 * `pz:open-login`-Custom-Event, sodass beliebige andere Stellen (z. B. der
 * „Zum Mitstimmen anmelden"-CTA in PollMitmachen) dasselbe Modal öffnen können —
 * ohne geteilten React-State. Liegt im Layout → auf JEDER Seite verfügbar.
 */

import { useEffect, useState } from "react";
import { LoginModal } from "./LoginModal";

/** Custom-Event-Name, mit dem das Login-Modal von überall geöffnet werden kann. */
export const OPEN_LOGIN_EVENT = "pz:open-login";

export function LoginEntry({ tenantSlug }: { tenantSlug: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_LOGIN_EVENT, handler);
    return () => window.removeEventListener(OPEN_LOGIN_EVENT, handler);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md px-3 py-1.5 font-semibold text-white shadow-sm transition-opacity hover:opacity-90 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
        style={{ backgroundColor: "var(--tenant-primary)" }}
      >
        Anmelden
      </button>
      <LoginModal tenantSlug={tenantSlug} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
