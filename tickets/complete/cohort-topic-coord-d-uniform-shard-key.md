---
description: Fixed and reviewed — peers now spread evenly across the topic ring at tier ≥ 1 by hashing the peer id before taking the shard prefix, instead of collapsing to one coordinate.
files:
  - packages/db-core/src/cohort-topic/addressing.ts
  - packages/db-core/test/cohort-topic/addressing.spec.ts
  - docs/cohort-topic.md
  - docs/reactivity.md
---

## What landed

`HashTierAddressing.coordD` now shards on `prefixBits(this.hash.H(peerId), d·log₂F)` instead of
`prefixBits(peerId, …)`. Formula: `coord_d = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)` for `d ≥ 1`.
One functional line changed; every downstream coord derivation (walk routing `walk.ts:207`, host
recompute `host.ts:978`, `parentCoord` `host.ts:1832`, child-link recompute `host.ts:1287`) inherits
the fix because they all go through `addressing.coord(d, …)`.

**Why:** raw peer-id-string bytes (`"12D3KooW…"`) share near-constant high bytes on every Ed25519
node, so `prefix(P, …)` was identical for all participants and every tier-`d` probe collapsed to one
coordinate. `SHA-256(P)` fans uniformly. Wire field `participantCoord` unchanged (still the
recoverable raw peer id); the ring-hash is applied only inside the addressing math.

## Review findings

Reviewed the implement diff (`f51dd60`) with fresh eyes before the handoff summary. Scope is small
(one functional line + tests + docs), so the review focused on correctness of the fan-out claim,
call-site coverage, doc consistency across the repo, and test adequacy.

**Correctness / call-site coverage — checked, no issue.** Every coord derivation in db-core and
db-p2p flows through `addressing.coord()` → `coordD`, so the single-line fix covers walk routing,
host recompute, `parentCoord`, and child-link recompute. Verified by grepping all `.coord(` /
`coordD` / `parentCoord:` call sites. `H(P)` is deterministic (SHA-256) so routing and recompute
agree; the round-trip test proves the b64url wire encoding is lossless.

**Doc consistency — one drift found and FIXED inline (minor).** `docs/reactivity.md:53` restated the
cohort-topic tier formula but still showed the pre-fix `prefix(P, …)`. The implement pass updated the
canonical `docs/cohort-topic.md` but missed this duplicate. Updated to `prefix(H(P), …)`. Swept all
of `docs/` afterward — no other stale copies. The `docs/cohort-topic.md` edits from the implement
pass read correctly and match the new reality.

**Simulator assessment — checked, ticket's claim confirmed.** `packages/substrate-simulator` feeds
`P = ring.coordOf(peer.key)` (a hash-derived, already-uniform ring position — see
`topic-tree.spec.ts:33`, `walk.spec.ts:68`) into `coordForTier`, so `prefix(P, …)` there is already
equivalent to `prefix(H(peerId), …)`. No simulator change needed; its inline comment is accurate as
written. The implementer's assessment holds.

**Tests — adequate; happy path, negative control, round-trips, edge/error paths all covered.** 16
addressing specs pass (21 ms — the `deeper tiers` 2000-seed search is comfortably fast in CI, one of
the handoff's review asks). Coverage: sibling convergence on `H(P)` prefix, deeper-tier divergence,
cross-topic/cross-tier decorrelation, collision rate, routing-vs-recompute equality, parent/child
recompute equality, and a uniformity negative control (raw prefix collapses to 1 bucket, `H(P)` fans
to >12 of 16). Error/guard paths (`d < 1`, `d > 255`, non-power-of-two F) covered by pre-existing
specs. The `>12 of 16` bound is deterministic given seeded input + SHA-256 (not actually probabilistic
at runtime), and the birthday margin is enormous (expected empty buckets ≈ 0.03), so no tighter
assertion is warranted — the handoff's second review ask is resolved as "no change needed."

**Major findings:** none — no new ticket filed.

**Blocked/decision items:** none.

### Tripwires (conditional; parked in code, not filed as tickets)

- **`H(P)` recompute per `coordD` call** — added a `NOTE:` at `addressing.ts:101`. Each `coordD`
  re-hashes `peerId`; a walk over a tier ladder recomputes `H(self)` once per tier. Negligible today
  (walk steps are network-bound). If coord derivation ever becomes hot, cache `H(peerId)`.
- **`H(P)` prefix left-pad above 256 bits** — carried over from the implement pass (noted at the
  `prefixBits` call). `H(P)` is 32 bytes = 256 bits; `d·log₂F` exceeds that only at `d ≥ 65` (F=16),
  far above any real `d_max`. Identical to the pre-fix behaviour for raw `P`; no new failure mode.

## Validation

- `packages/db-core`: full suite **1255 passing** (6 s); addressing spec **16 passing** (21 ms).
- `eslint` on changed files: clean.
- `tsc --noEmit` on `packages/db-core`: clean (covers the new `wire/codec.js` import in the spec).
- Comment-only and docs-only edits added during review do not affect the test/lint results above.
