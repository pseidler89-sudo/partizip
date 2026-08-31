/**
 * zwei-faktor-hinweis.test.tsx — Ausweg aus einem abgelehnten Step-up
 * (Review #59, Befund 2).
 *
 * Zwei Ebenen: die reine Ableitung (Ziel-Pfad, Texte) direkt, und die Komponente
 * über renderToStaticMarkup — ohne DOM-Umgebung, weil hier nichts geklickt wird
 * (die Vitest-Umgebung des Repos ist "node"). next/navigation ist gemockt; die
 * Komponente liest Mandant und Pfad ausschließlich von dort.
 */

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let mockPfad: string | null = "/musterstadt/admin/rollen";
let mockParams: { tenant?: string } = { tenant: "musterstadt" };

vi.mock("next/navigation", () => ({
  usePathname: () => mockPfad,
  useParams: () => mockParams,
}));

const { default: ZweiFaktorHinweis, zweiFaktorHinweisDaten } = await import(
  "../ZweiFaktorHinweis"
);

describe("zweiFaktorHinweisDaten", () => {
  it("führt bei fehlendem Code auf die Bestätigungsseite und wieder zurück", () => {
    const daten = zweiFaktorHinweisDaten({
      bedarf: "code",
      tenantSlug: "musterstadt",
      weiter: "/musterstadt/admin/rollen",
    });
    expect(daten.href).toBe(
      "/musterstadt/anmelden/bestaetigen?weiter=%2Fmusterstadt%2Fadmin%2Frollen"
    );
  });

  it("kodiert das Rückkehrziel samt Query", () => {
    const daten = zweiFaktorHinweisDaten({
      bedarf: "code",
      tenantSlug: "musterstadt",
      weiter: "/musterstadt/admin/digest?id=7&tab=pruefung",
    });
    expect(daten.href).toContain("weiter=%2Fmusterstadt%2Fadmin%2Fdigest%3Fid%3D7%26tab%3Dpruefung");
    // Der Rohwert darf den Query-String der Bestätigungsseite nicht aufbrechen.
    expect(daten.href!.split("?")).toHaveLength(2);
  });

  it("führt bei fehlender Einrichtung auf die Einrichtungsseite (ohne weiter)", () => {
    const daten = zweiFaktorHinweisDaten({
      bedarf: "einrichten",
      tenantSlug: "musterstadt",
      weiter: "/musterstadt/admin/rollen",
    });
    expect(daten.href).toBe("/musterstadt/konto/zwei-faktor");
    expect(daten.href).not.toContain("weiter");
  });

  it("kommt ohne Rückkehrziel aus", () => {
    const daten = zweiFaktorHinweisDaten({
      bedarf: "code",
      tenantSlug: "musterstadt",
      weiter: null,
    });
    expect(daten.href).toBe("/musterstadt/anmelden/bestaetigen");
  });

  it("zeigt ohne Mandanten keinen geratenen Pfad", () => {
    const daten = zweiFaktorHinweisDaten({ bedarf: "code", tenantSlug: null, weiter: "/x" });
    expect(daten.href).toBeNull();
    expect(daten.text.length).toBeGreaterThan(0);
  });
});

describe("<ZweiFaktorHinweis />", () => {
  it("rendert nichts ohne Ergebnis", () => {
    expect(renderToStaticMarkup(<ZweiFaktorHinweis ergebnis={null} />)).toBe("");
  });

  it("rendert nichts bei einem Ergebnis ohne zweiFaktor-Feld", () => {
    expect(renderToStaticMarkup(<ZweiFaktorHinweis ergebnis={{}} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <ZweiFaktorHinweis ergebnis={{ ok: false, error: "Keine Berechtigung." } as never} />
      )
    ).toBe("");
  });

  it("rendert bei zweiFaktor: code den Link auf die Bestätigungsseite", () => {
    const html = renderToStaticMarkup(<ZweiFaktorHinweis ergebnis={{ zweiFaktor: "code" }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      'href="/musterstadt/anmelden/bestaetigen?weiter=%2Fmusterstadt%2Fadmin%2Frollen"'
    );
    expect(html).toContain("Jetzt bestätigen");
  });

  it("rendert bei zweiFaktor: einrichten den Link auf die Einrichtungsseite", () => {
    const html = renderToStaticMarkup(
      <ZweiFaktorHinweis ergebnis={{ zweiFaktor: "einrichten" }} />
    );
    expect(html).toContain('href="/musterstadt/konto/zwei-faktor"');
  });

  it("nimmt abweichenden Mandanten und abweichendes Ziel als Prop", () => {
    const html = renderToStaticMarkup(
      <ZweiFaktorHinweis
        ergebnis={{ zweiFaktor: "code" }}
        tenantSlug="taunusstein"
        weiter="/taunusstein/admin"
      />
    );
    expect(html).toContain(
      'href="/taunusstein/anmelden/bestaetigen?weiter=%2Ftaunusstein%2Fadmin"'
    );
  });

  it("bleibt ohne Mandant in der Route ein Hinweis ohne Link", () => {
    const vorherParams = mockParams;
    const vorherPfad = mockPfad;
    mockParams = {};
    mockPfad = null;
    try {
      const html = renderToStaticMarkup(<ZweiFaktorHinweis ergebnis={{ zweiFaktor: "code" }} />);
      expect(html).not.toContain("<a ");
      expect(html).toContain("Bestätigung erforderlich");
    } finally {
      mockParams = vorherParams;
      mockPfad = vorherPfad;
    }
  });
});
