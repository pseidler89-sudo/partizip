# ADR-016 — Verifizierbares Abstimmen (Roadmap)

**Status:** akzeptiert · **Datum:** 2026-06-15 · **Bezug:** ADR-014 (Abstimm-/Verifikationsmodell)

> **Herkunft:** Übernommen aus den autonomen Loop-Iterationen (Ralph/Self-Improvement, `origin/main` b08e8af) und am 2026-06-15 gegen den überparteilich-kommunalen Mitmachen-Pivot bereinigt. Ergänzende Referenz; bei Widerspruch gilt der real gebaute Code + `docs/decisions/`.

## Context
"Binding, anonymous" voting raises the question of **end-to-end verifiability** (E2E-V):
cast-as-intended, recorded-as-cast, counted-as-recorded — checkable without trusting the
operator. Full E2E-V (mixnets, homomorphic tallying, Benaloh cast-or-audit) is powerful but
heavy: significant cryptography, key custody/ceremonies, UX complexity for a non-technical,
mobile-first audience (invariant #7), and real implementation risk.

## Decision
- **v0 — pragmatic integrity (now):** per-poll pseudonymous `voter_ref` (HMAC), eligibility/
  ballot decoupling, append-only **hash-chained audit**, reproducible tally, and a
  **receipt-free** inclusion proof (VOTE_PRIVACY.md §2). This gives strong practical integrity
  and auditability for binding internal decisions and reflects the Stand der Technik.
- **Defer E2E-V crypto:** do **not** build mixnet/homomorphic voting speculatively. Evaluate it
  **before** enabling high-stakes binding use cases where the verifiability bar is highest.
- **Keep the path open:** the data model already separates identity from ballot, so a verifiable
  layer can be added later without reworking the core.

## Consequences
- Fast, comprehensible v0 that is usable for binding decisions in the pilot.
- High-stakes use cases stay out of scope until E2E-V is evaluated (or they use a confirming
  offline ballot).
- Coercion-resistance is addressed at the protocol/UX level now (vote-updating, receipt-freeness),
  not via heavyweight crypto. Pilot-Regel (ADR-014): Mitstimmen ab Stufe 1 (eingeloggt),
  verbindlich ab Stufe 2 (QR-Wohnsitz mit Ablauf).

## Alternatives considered
- **Full E2E-V from day one:** rejected for v0 — disproportionate complexity/UX risk for the
  pilot's internal-decision use case.
- **No verifiability beyond DB trust:** rejected — too weak for "binding"; hence the hash chain +
  receipt-free inclusion proof as the middle ground.

---
_Diese ADR wurde aus der gleichnamigen Loop-ADR-003 (nur auf `origin/main` `b08e8af`, nicht in dieser Linie vorhanden) übernommen und auf ADR-016 umnummeriert, weil jene mit der real gebauten `docs/decisions/ADR-003-rechtekonzept-kommune.md` kollidierte._
