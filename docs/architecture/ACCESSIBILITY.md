> **Herkunft:** Übernommen aus den autonomen Loop-Iterationen (Ralph/Self-Improvement, `origin/main` b08e8af) und am 2026-06-15 gegen den überparteilich-kommunalen Mitmachen-Pivot bereinigt. Ergänzende Referenz; bei Widerspruch gilt der real gebaute Code + `docs/decisions/`.

# Accessibility & Mobile-First (Loop 5)

Invariant #7: **mobile first, German UI, Narrensicherheit**. The audience includes
non-technical and low-digital-literacy citizens on phones — accessibility is a core feature,
not a polish step. Target: **WCAG 2.2 AA**.

> **Übergeordnetes Leitbild:** [`UX_LEITBILD.md`](./UX_LEITBILD.md) („iPhone/Tesla der
> Bürgerbeteiligung") ist der North Star; dieses Dokument konkretisiert das *Wie* der Bedienbarkeit,
> das UX-Wording-Dokument (intern) die *Worte*, das Design-Profil (`globals.css`) den *Look*.
> Insbesondere Prinzip 7 („für alle bedienbar = Teil von einfach") und der **Litmus-Test** (eine
> nicht-technikaffine Person schafft den Kernpfad am Smartphone ohne Hilfe) sind hier verankert.

## Non-negotiables
- **Contrast** ≥ 4.5:1 for normal text, ≥ 3:1 for large text (≥ 24px, or 18.7px bold) and for
  UI component/state boundaries.
- **Touch targets** ≥ 44×44 px with spacing; primary action reachable one-handed (bottom of viewport).
- **Keyboard + screen reader**: full operability, logical focus order, visible focus ring,
  semantic landmarks/headings, labelled form fields, `aria-live` for async errors/status.
- **No color-only meaning**: pair color with text/icon (e.g. verification status, vote result).
- **Respect** `prefers-reduced-motion`; avoid motion on critical actions.
- **Zoom/reflow** to 200% without horizontal scroll; no fixed tiny fonts (base ≥ 16px).
- **Forms**: one concept per screen where possible, inline validation, errors tied to fields
  (`aria-describedby`), never rely on placeholder as label.

## Contrast — computation method
Compute contrast from the **relative luminance** of the two colors (WCAG formula):
ratio `= (L_lighter + 0.05) / (L_darker + 0.05)`, where `L` is the linearized,
sRGB-corrected luminance of each color. Check every text/background and component/state pair
against the thresholds above (≥ 4.5:1 normal text, ≥ 3:1 large text and UI boundaries).

**Civic design tokens (project design profile):** the pilot uses a neutral civic palette,
not tenant brand colors — accent Teal `--pz-brand` `#0e6e74`, text `--pz-ink`, page surface
`--pz-page`. Example: `--pz-brand` `#0e6e74` reaches ≥ 4.5:1 against white, so white text on a
`--pz-brand` button and `--pz-brand` text on a white card both pass AA for normal text.

> **Rule for the design system:** derive each accessible text/action pairing from the design
> tokens — never paint text in a raw primary that fails 4.5:1. If a tenant ever supplies its own
> `--tenant-primary`, validate the derived text/action pairing the same way before use.
> Add an automated contrast check to CI when the UI lands.

## Mobile-first interaction
- Single-column, thumb-zone primary actions, sticky progress in multi-step flows (verification,
  poll composer), large tap areas for vote options.
- Live smartphone preview in the Poll Composer must reflect real rendering.
- Offline/slow-network: clear loading and retry states; never lose entered data on error.

## Language & comprehension
- Plain German, short sentences, active voice; explain trust/security in one line, not a wall.
- Provide a *Leichte-Sprache*-friendly variant for the critical paths (register, verify, vote)
  where feasible. Microcopy-Details stehen in einem internen UX-Wording-Dokument.

## Definition of done (for the build session)
- [ ] Automated axe/contrast checks in CI; manual screen-reader pass on register→verify→vote.
- [ ] All interactive elements keyboard-operable with visible focus.
- [ ] Status/results never color-only; redaction (k-anonymity) explained in text (K_ANONYMITY.md).
