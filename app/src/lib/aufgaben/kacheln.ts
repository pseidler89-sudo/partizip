/**
 * aufgaben/kacheln.ts — Welche Aufgaben-Kacheln sieht ein Rollenträger?
 *
 * REINE, unit-testbare Funktion über den echten Rollen-Achsen aus
 * lib/auth/roles.ts (canVerify/canRedaktion/isAdmin/canBeobachten). Sie ist der
 * EINZIGE Ort, an dem die Kachel-Sichtbarkeit der Aufgaben-Ansicht entschieden
 * wird — die Zielseiten behalten IHRE eigenen serverseitigen Guards. Damit gilt:
 * angezeigt wird ausschließlich, was der Nutzer serverseitig auch darf
 * (Discoverability = exaktes Spiegeln des Server-Enforcements, nichts lockern).
 *
 * Wichtig zur Vermeidung doppelter Kacheln: die Achsen sind geschachtelt
 * (ADMIN_ROLES ⊂ REDAKTION_ROLES ⊂ BEOBACHTUNG_ROLES). Deshalb:
 *   - Digests/Ratsinfos hängt an canRedaktion (deckt Admin UND redakteur ab).
 *   - /admin bekommt GENAU eine Kachel: Admin → „Verwaltung öffnen"; ein reiner
 *     `beobachter` (kein Admin) → „Übersicht" (Lese-Sicht).
 *
 * ACHTUNG zur /admin-Übersichts-Kachel: der Guard von /admin lässt AUSSCHLIESSLICH
 * Admins und die LITERALE Rolle `beobachter` zu (`roleTypes.includes("beobachter")`)
 * — NICHT canBeobachten (das schlösse auch `redakteur` ein). Ein reiner
 * `redakteur` wird von /admin weg-redirectet; deshalb bekommt er hier KEINE
 * Übersichts-Kachel (nur seine Digests-Kachel). Die Kachel spiegelt exakt den
 * echten Guard.
 */

import { canVerify, canRedaktion, isAdmin } from "@/lib/auth/roles";

export interface AufgabenKachel {
  /** Stabiler Schlüssel (React-key, Tests). */
  key: string;
  /** Dekoratives Emoji (aria-hidden in der UI). */
  icon: string;
  titel: string;
  beschreibung: string;
  /** Pfad OHNE Tenant-Präfix (die Seite setzt `/${slug}` davor). */
  href: string;
  cta: string;
}

/**
 * Trägt der Nutzer mit diesen Rollen überhaupt eine Aufgabe? Guard der
 * /aufgaben-Route und Sichtbarkeit des Perspektiv-Umschalters. Deckt sich mit
 * `aufgabenKacheln(...).length > 0`.
 */
export function hatAufgaben(roleTypes: string[]): boolean {
  return (
    canVerify(roleTypes) ||
    canRedaktion(roleTypes) ||
    isAdmin(roleTypes) ||
    // Literale `beobachter`-Rolle: der einzige canBeobachten-Fall, der nicht
    // schon von canRedaktion/isAdmin abgedeckt ist. Deckungsgleich mit
    // „aufgabenKacheln(...).length > 0".
    roleTypes.includes("beobachter")
  );
}

/**
 * Liste der Aufgaben-Kacheln für diese Rollen — in stabiler Anzeige-Reihenfolge
 * (Verifizieren zuerst = v1-Fokus, dann Erstellen/Verwalten, dann Lese-Sicht).
 * Nicht-Rollenträger erhalten [] (die Route redirectet sie ohnehin weg).
 */
export function aufgabenKacheln(roleTypes: string[]): AufgabenKachel[] {
  const kacheln: AufgabenKachel[] = [];
  const admin = isAdmin(roleTypes);

  // --- Verifizieren (canVerify: verifier/kommune_admin/super_admin) ---------
  if (canVerify(roleTypes)) {
    kacheln.push({
      key: "verifizieren",
      icon: "🪪",
      titel: "Personen verifizieren",
      beschreibung:
        "Öffnen Sie den Scanner und bestätigen Sie den Wohnsitz vor Ort — die " +
        "Person zeigt ihren persönlichen Konto-QR, Sie scannen ihn.",
      href: "/verifizieren/bestaetigen",
      cta: "Scanner öffnen",
    });
    kacheln.push({
      key: "termine",
      icon: "📅",
      titel: "Termine bestätigen",
      beschreibung:
        "Verifizierungs-Termine und -Aktivität Ihrer Stelle einsehen und bestätigen.",
      href: "/admin/verifizierung",
      cta: "Verifizierung öffnen",
    });
  }

  // --- Erstellen & verwalten (isAdmin) --------------------------------------
  if (admin) {
    kacheln.push({
      key: "umfrage",
      icon: "🗳️",
      titel: "Umfrage erstellen",
      beschreibung:
        "Abstimmungen für Kommune oder Ortsteil erstellen, aktivieren und schließen.",
      href: "/admin/abstimmungen",
      cta: "Abstimmungen verwalten",
    });
    kacheln.push({
      key: "standorte",
      icon: "📍",
      titel: "Standorte & Sprechzeiten",
      beschreibung:
        "Verifizierungs-Standorte Ihrer Kommune und deren Sprechzeiten pflegen.",
      href: "/admin/verifizierung/standorte",
      cta: "Standorte pflegen",
    });
  }

  // --- Ratsinfos / Digests (canRedaktion: deckt Admin + redakteur ab) -------
  if (canRedaktion(roleTypes)) {
    kacheln.push({
      key: "digests",
      icon: "📰",
      titel: "Ratsinfos / Digests",
      beschreibung:
        "Sitzungszusammenfassungen bearbeiten, Quellen prüfen und veröffentlichen.",
      href: "/admin/digests",
      cta: "Ratsinfos öffnen",
    });
  }

  // --- Lese-Sicht auf /admin: GENAU eine Kachel -----------------------------
  if (admin) {
    kacheln.push({
      key: "verwaltung",
      icon: "🛠️",
      titel: "Verwaltung öffnen",
      beschreibung:
        "Das vollständige Verwaltungs-Dashboard: Kennzahlen, Rollen, Anliegen, Protokoll.",
      href: "/admin",
      cta: "Verwaltung öffnen",
    });
  } else if (roleTypes.includes("beobachter")) {
    kacheln.push({
      key: "uebersicht",
      icon: "👁️",
      titel: "Übersicht",
      beschreibung:
        "Lesende Übersicht über Ergebnisse und Digest-Entwürfe in Ihrem Bereich.",
      href: "/admin",
      cta: "Übersicht öffnen",
    });
  }

  return kacheln;
}
