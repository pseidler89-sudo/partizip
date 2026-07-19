/**
 * oeffnungszeiten-format.test.ts — reiner Unit-Test des gruppierenden
 * Öffnungszeiten-Formatters (Verifizierung 2.0 / V2). Ruft die ECHTE Funktion,
 * keine gespiegelte Logik. Läuft OHNE DB.
 */

import { describe, it, expect } from "vitest";
import type { OeffnungszeitFenster } from "@/db/schema";
import { formatOeffnungszeiten } from "@/lib/verification/oeffnungszeiten-format";

describe("formatOeffnungszeiten (Unit)", () => {
  it("leer / null / undefined → leerer String", () => {
    expect(formatOeffnungszeiten(null)).toBe("");
    expect(formatOeffnungszeiten(undefined)).toBe("");
    expect(formatOeffnungszeiten([])).toBe("");
  });

  it("gruppiert aufeinanderfolgende Tage gleicher Zeit zu einem Bereich (Mo–Fr)", () => {
    const f: OeffnungszeitFenster[] = [
      { tag: 1, von: "08:00", bis: "16:00" },
      { tag: 2, von: "08:00", bis: "16:00" },
      { tag: 3, von: "08:00", bis: "16:00" },
      { tag: 4, von: "08:00", bis: "16:00" },
      { tag: 5, von: "08:00", bis: "16:00" },
      { tag: 6, von: "09:00", bis: "12:00" },
    ];
    expect(formatOeffnungszeiten(f)).toBe("Mo–Fr 08:00–16:00, Sa 09:00–12:00");
  });

  it("einzelner Tag bleibt ohne Bereich", () => {
    expect(formatOeffnungszeiten([{ tag: 3, von: "10:00", bis: "12:00" }])).toBe(
      "Mi 10:00–12:00",
    );
  });

  it("mehrere Fenster am selben Tag werden mit Slash verbunden", () => {
    const f: OeffnungszeitFenster[] = [
      { tag: 1, von: "14:00", bis: "16:00" },
      { tag: 1, von: "08:00", bis: "12:00" },
    ];
    // Innerhalb des Tages nach Beginn sortiert.
    expect(formatOeffnungszeiten(f)).toBe("Mo 08:00–12:00 / 14:00–16:00");
  });

  it("bündelt nur Tage mit IDENTISCHer Signatur (unterschiedliche Zeiten bleiben getrennt)", () => {
    const f: OeffnungszeitFenster[] = [
      { tag: 1, von: "08:00", bis: "16:00" },
      { tag: 2, von: "08:00", bis: "16:00" },
      { tag: 3, von: "08:00", bis: "18:00" }, // andere Bis-Zeit
    ];
    expect(formatOeffnungszeiten(f)).toBe("Mo–Di 08:00–16:00, Mi 08:00–18:00");
  });

  it("nicht zusammenhängende Tage gleicher Zeit bleiben getrennte Läufe (Mo, Mi)", () => {
    const f: OeffnungszeitFenster[] = [
      { tag: 1, von: "09:00", bis: "12:00" },
      { tag: 3, von: "09:00", bis: "12:00" },
    ];
    expect(formatOeffnungszeiten(f)).toBe("Mo 09:00–12:00, Mi 09:00–12:00");
  });

  it("ignoriert Fenster mit ungültigem Wochentag (defensiv)", () => {
    const f: OeffnungszeitFenster[] = [
      { tag: 0, von: "08:00", bis: "12:00" },
      { tag: 8, von: "08:00", bis: "12:00" },
      { tag: 2, von: "08:00", bis: "12:00" },
    ];
    expect(formatOeffnungszeiten(f)).toBe("Di 08:00–12:00");
  });

  it("So (Tag 7) wird korrekt beschriftet und schließt an Sa an", () => {
    const f: OeffnungszeitFenster[] = [
      { tag: 6, von: "10:00", bis: "14:00" },
      { tag: 7, von: "10:00", bis: "14:00" },
    ];
    expect(formatOeffnungszeiten(f)).toBe("Sa–So 10:00–14:00");
  });
});
