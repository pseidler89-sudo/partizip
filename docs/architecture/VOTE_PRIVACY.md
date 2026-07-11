> **Herkunft:** Übernommen aus den autonomen Loop-Iterationen (Ralph/Self-Improvement, `origin/main` b08e8af) und am 2026-06-15 gegen den überparteilich-kommunalen Mitmachen-Pivot bereinigt. Ergänzende Referenz; bei Widerspruch gilt der real gebaute Code + `docs/decisions/`.

> **Pilot-Status (2026-06-15):** Gebaut = per-Poll-Pseudonym `voter_ref` (HMAC, Salt aktuell `ANLIEGEN_REF_SALT`) + `UNIQUE(poll_id, voter_ref)`-Dedup + receipt-freie, **unveränderliche** Einzelstimme (first-cast-wins). **NICHT gebaut (Roadmap):** Vote-Updating/„last ballot counts", `integrity_hash`, `ballot_secret`-Receipt, dediziertes `VOTE_REF_SECRET`, slider/ranked; Choices im Pilot nur `ja`/`nein`/`enthaltung`.

# Vote Privacy & Integrity (Loop 2)

How Partizip keeps votes **anonymous** yet **binding and verifiable**. This is the
core trust promise; implement it exactly.

## 1. Pseudonymous voter reference (`votes.voter_ref`)

A vote must never be stored against the user id. Instead store a per-poll pseudonym:

```
voter_ref = HMAC_SHA256(key = VOTE_REF_SECRET, message = poll_id || ":" || user_id)   // hex
```

Properties and why:
- **One-way:** HMAC is not reversible → a `voter_ref` cannot be turned back into a user id.
- **Per-poll, unlinkable:** including `poll_id` in the message means the *same* user gets a
  *different* `voter_ref` in every poll → votes cannot be correlated across polls.
- **Double-vote protection still works:** within one poll the derivation is deterministic,
  so the `UNIQUE (poll_id, voter_ref)` constraint enforces one vote per person (→ `ALREADY_VOTED`).
- **Keyed:** `VOTE_REF_SECRET` (env, ≥256-bit, never committed) stops an attacker who only has
  the DB from brute-forcing refs over the known user-id space.

Rules:
- Compute `voter_ref` server-side only, at cast time; never expose it to the client.
- `VOTE_REF_SECRET` rotation invalidates the link between old and new refs — rotate only
  between polls, never during an open poll (would break double-vote detection mid-poll).
- The eligibility check (auth, verified, tenant, PLZ, window) runs on the **user**; only the
  resulting `voter_ref` and choice are written to `votes`. Eligibility and ballot are decoupled.

## 2. Vote integrity / receipt — **receipt-free** (`votes.integrity_hash`)

> Receipt-freeness (Loop 4 / THREAT_MODEL T2): the published proof must let a voter verify their
> ballot is **included**, but must NOT let anyone prove **how** they voted — otherwise it enables
> vote-buying/coercion. The choice therefore must not be derivable from the published value.

```
ballot_secret = random per cast (returned only to the voter, never stored server-side in clear)
integrity_hash = SHA256(poll_id || ":" || voter_ref || ":" || ballot_secret)   // choice-independent
```

- The server returns `integrity_hash` (and `ballot_secret`) as the voter's **receipt** at cast time.
  A published, ordered list of `integrity_hash` values after the poll ends lets each voter confirm
  their ballot is counted (**recorded-as-cast**) and that the count covers exactly the cast ballots
  — **without** revealing identities and **without** revealing or proving any choice.
- The hash deliberately **excludes `choice_payload`**: a value that committed to the choice would be
  a transferable proof of the vote (vote-selling). The tally is still verifiable because the set of
  ballots is fixed and the count is reproducible from `votes` (T6), independent of the receipt.
- This supersedes the earlier (Loop 2) definition that hashed the choice into the receipt.

### 2a. As-built (D4, 2026-06-19) — `vote_receipts` Beleg-Code

The receipt-free inclusion proof is now **built**, but with a simpler, stronger decoupling than the
`integrity_hash` sketch above:

- A separate table `vote_receipts(id, poll_id, tenant_id, code)` holds ONE random `code`
  (`BELEG-XXXX-XXXX`, 40 bit CSPRNG, `app/src/lib/polls/beleg.ts`) per cast ballot, inserted in the
  **same transaction** as the `votes` row (invariant `#receipts == #votes`).
- The table carries **no `voter_ref`, no `choice`, no user FK, and deliberately no `created_at`** — the
  code is not derived from anything and is not linkable to person or choice. It is returned to the
  voter **exactly once** at cast time (`AbstimmenResult.beleg`), never re-fetchable per person.
- After the poll is `geschlossen`, `getBelegListe` publishes all codes **sorted by code** (not
  insertion order → no Abgabe-Reihenfolge leak) at `/[tenant]/umfrage/[id]/belege`. Finding your code
  proves **inclusion**, never **how** you voted → receipt-free (no vote-selling/coercion via the Beleg).
- **Residual, out of scope for v0 (operator-trust, consistent with ADR-016):** an adversary with raw
  heap access to the database could correlate the physical row order (`ctid`) of `votes` and
  `vote_receipts` (both inserted in the same tx order) to pair a code with a `(voter_ref, choice)`.
  Dropping `created_at` removes the timestamp vector but not `ctid`. This is the same operator-trust
  boundary the `votes` table itself already assumes (it stores `voter_ref`+`choice` together); it is
  not reachable through any app/SQL path in normal use. Full unlinkability (shuffle/mix) stays Roadmap.

## 3. Choice payload validation

Validate `choice_payload` per `poll_type` with zod before persisting (`VALIDATION_ERROR` / 422):
- `yes_no_abstain`: `{ choice: "yes" | "no" | "abstain" }`
- `slider`: `{ value: number }` within the poll's configured min/max
- `ranked`: `{ ranking: string[] }` — a permutation of the poll's options, no duplicates

## 4. What is NOT stored with a vote
No user id, email, email_hash, name, exact birth date, IP or user-agent in `votes`. Audit of
`vote.cast` references only the pseudonymous actor + `poll_id` (see SECURITY.md), never the choice.

## 5. Coercion resistance — vote updating (THREAT_MODEL T1)
Unsupervised remote voting cannot fully prevent a coercer from watching the cast. The standard
mitigation is **vote updating**: a participant may re-cast until the poll closes; **only the last
ballot counts**. A coerced ballot can then be silently overridden later in private.

_Pilot-Regel (ADR-014): Mitstimmen ab Stufe 1 (eingeloggt), verbindlich ab Stufe 2 (QR-Wohnsitz mit Ablauf)._

Design decision for the build session (per ADR-016):
- **Option A — vote-updating (coercion-resistant):** re-cast is an `UPDATE` on the existing
  `(poll_id, voter_ref)` row (last-write-wins), refreshing `ballot_secret`/`integrity_hash`. The
  `UNIQUE (poll_id, voter_ref)` constraint already supports this.
- **Option B — immutable single vote (simpler):** first cast wins, re-cast → `ALREADY_VOTED` (409).
- For high-coercion decisions prefer supervised/in-person voting regardless of the option chosen.
Whichever is chosen, audit records that *a* (re)cast happened, never the choice.
