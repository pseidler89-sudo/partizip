/**
 * SpaeterKnopf.tsx — dezenter „Später"-Knopf des Einrichtungs-Hinweises
 * (Fläche B). Setzt ein reines UI-Präferenz-Cookie (30 Tage, KEIN httpOnly —
 * der Client schreibt es selbst) und lässt die Server-Seite per
 * router.refresh() neu rendern; die liest das Cookie und lässt die Zeile weg.
 * Bewusst KEINE Server Action: am Cookie hängt kein Recht, nur Anzeige.
 */

"use client";

import { useRouter } from "next/navigation";
import {
  EINRICHTUNG_SPAETER_COOKIE,
  EINRICHTUNG_SPAETER_MAX_AGE,
} from "@/lib/konto/constants";

export function SpaeterKnopf() {
  const router = useRouter();

  function handleSpaeter() {
    document.cookie = `${EINRICHTUNG_SPAETER_COOKIE}=1; Path=/; Max-Age=${EINRICHTUNG_SPAETER_MAX_AGE}; SameSite=Lax`;
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleSpaeter}
      aria-label="Einrichtungs-Hinweis für 30 Tage ausblenden"
      className="whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium underline-offset-4
                 hover:underline focus:outline-none focus-visible:ring-2
                 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2"
      style={{ color: "var(--pz-muted)" }}
    >
      Später
    </button>
  );
}
