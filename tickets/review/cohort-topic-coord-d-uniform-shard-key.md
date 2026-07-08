---
description: Review the uniform shard-key fix for coord_d — peers now spread evenly across the ring at depth ≥ 1 by ring-hashing P before the prefix.
files:
  - packages/db-core/src/cohort-topic/addressing.ts
  - packages/db-core/test/cohort-topic/addressing.spec.ts
  - docs/cohort-topic.md
---

## What landed

`HashTierAddressing.coordD` now feeds `prefixBits(this.hash.H(peerId), d * log₂F)` instead of
`prefixBits(peerId, d * log₂F)`. The formula is `coord_d = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)`.
One line changed in the implementation; everything downstream (walk routing, host recompute,
parentCoord, child-link recompute) inherits the fix automatically because all call sites go through
`coord(d, ...)`.

## Why

The raw peer-id string bytes (`"12D3KooW…"`) share near-constant high bytes across every Ed25519
node, so `prefix(P, d·log₂F)` was identical for all participants and every tier-`d` probe collapsed
to one coordinate. SHA-256(`P`) produces uniformly distributed high bits, so `prefix(H(P), …)` fans
correctly. Wire field `participantCoord` is unchanged (still the recoverable peer id); the hash is
applied only inside the addressing math.

## Tests

All 1255 existing tests pass. Tests updated/added in `addressing.spec.ts`:

- **Updated:** `sibling convergence` — now finds two seeded peers with matching first-nibble of `H(P)` (d=1, 4-bit shard); verifies convergence on H(P) prefix, divergence when H(P) prefix differs.
- **Updated:** `deeper tiers require a longer shared H(P) prefix to converge` — searches for a pair sharing 8 bits but not 12 bits of H(P); asserts convergence at d=2, divergence at d=3.
- **Updated:** `coord_d collision rate` — shard key now uses `prefixBits(hash.H(peer), d*log₂F)` matching the actual convergence criterion.
- **Updated:** `accepts power-of-two fan-out` construction guard — finds H(P)-converging pair with F=4.
- **New:** `routing-vs-recompute equality` — b64url round-trip of `self` produces identical `coord(d, …)` at d=0,1,2.
- **New:** `parent/child recompute equality` — confirms child's self-routed coord equals parent's recompute at d=1 and d=2.
- **New:** `H(P) shard is uniform / raw prefix collapses` — 100 peer ids with constant first byte: `H(P)` shard fans to >12 of 16 buckets; raw prefix collapses to exactly 1 bucket (negative control documents the pre-fix behaviour).

## Docs

- `docs/cohort-topic.md` §Tier addressing: formula updated to `H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)`, rationale for ring-hashing P added, implementation note updated, simulator alignment explained.
- §Wire "Participant signature": Tier-0 caveat / follow-on hedge removed; note now describes the resolved design.
- §Anti-flood claim-1 fan `it.skip` note: blocker reference to `cohort-topic-participant-coord-routing-key-mismatch` removed; note says the collapse is resolved, fan test still skipped pending live multi-tier promotion.

## Known gaps / review focus

- The `deeper tiers` search loop iterates up to 2000 seeds — deterministic (LCG + SHA-256) but not instantly readable. Confirm the test is fast enough in CI (should be well under 1s).
- The `H(P) shard is uniform` test asserts `> 12 of 16 buckets` with 100 samples. The probability of getting ≤12 distinct buckets is very low (birthday bound), but the bound isn't proven in the test. Consider whether a tighter assertion or a comment explaining the bound is warranted.
- The simulator (`packages/substrate-simulator`) still feeds `hashKey(peerId)` as P — already a uniform ring position, so no change needed there. Confirm reviewer agrees with that assessment.

## Review findings

- Tripwire (parked in addressing.ts comment): `H(P)` is 32 bytes at 256-bit ring; `prefixBits` left-pads if `d·log₂F` exceeds 256 bits (only at d ≥ 65 with F=16 — far above any real d_max, identical to pre-existing behaviour for raw P). No new failure mode; noted in addressing.ts.
