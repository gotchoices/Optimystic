description: RESOLVED-CORE / residual only. The original self-vs-H(self) routing/wire mismatch was fixed by `cohort-topic-peer-key-signing` (it adopted Option A — `participantCoord` now carries `self`, the routing coordinate, so the participant's FRET routing key and the host's recomputed served coord are equal for all `d`). What remains is a *distribution* concern, not a correctness mismatch: `P = self` is the participant's **dialable peer-id string bytes**, so `prefix(P, …)` over an Ed25519 peer id is non-uniform (every id shares the `12D3Koo…` prefix), which skews `coord_d` sharding for `d ≥ 1`. Must be reconciled before any live multi-tier work.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts (participantId = deps.self at L179; participantCoord = bytesToB64url(participantId) in messageFactory)
  - packages/db-core/src/cohort-topic/walk.ts (routes with addressing.coord(d, deps.self, topicId) at L162)
  - packages/db-core/src/cohort-topic/addressing.ts (coordD: H(d ‖ prefix(P, d·log₂F) ‖ topicId))
  - packages/db-p2p/src/cohort-topic/host.ts (self = selfMemberBytes into the service; dispatchRegister recomputes servedCoord = addressing.coord(reg.treeTier, participantCoord, topicId))
  - packages/db-p2p/src/cohort-topic/peer-sig.ts (verifyPeerSig — the signer id must be recoverable from whatever `participantCoord` carries)
  - docs/cohort-topic.md (§Register — the participant-signature note already states this caveat; §Tier addressing)
----

# Reconcile the `coord_d` sharding key `P` with the verifiable signer id `participantCoord`

## Status: core mismatch RESOLVED; only the `d ≥ 1` uniformity residual remains

The original bug this ticket was filed for — the participant routing on `coord_d(self, …)` while the
host recomputed `coord_d(H(self), …)` because `participantCoord` carried `H(self)` — **no longer
exists.** `cohort-topic-peer-key-signing` changed `service.ts` so `participantId = deps.self` and the
wire `participantCoord` is `bytesToB64url(self)` (it had to be a recoverable peer id, since the
cohort verifies the participant's peer-key signature against it). That is exactly "Option A" from the
original analysis: routing (`deps.self`) and the host recompute (`participantCoord`) now use the same
`self` bytes, so they are equal for **all** `d`, not just `d = 0`. The acceptance check below for
routing-key equality is therefore satisfied by construction; `crossCheckCohort` no longer warns on a
correctly-routed register.

## The residual: `prefix(P, …)` is non-uniform when `P` is a peer-id string

`P = self` is now the participant's **dialable peer-id string** encoded as UTF-8 bytes (the peer-codec
form, so the embedded Ed25519 key is recoverable with no lookup). For `coord_0` this is exact —
`coord_0` ignores `P`. But for `d ≥ 1`, `coord_d` feeds `prefix(P, d·log₂F)` into the hash, and the
high bits of an Ed25519 peer-id string are a near-constant (`12D3Koo…`) shared by every node, so the
tier-`d` shard prefix barely varies between participants. Sharding uniformity across the `F^d`
tier-`d` coordinates degrades. Nothing *working* regresses today (multi-tier is non-functional:
`cohort-topic-followon-derivation` + multi-tier promotion are still open), but this must be settled
before a `d ≥ 1` cohort is ever served.

## What to decide

Keep the verifiable signer id and fix the sharding input independently:

- **Hash `P` for the `coord_d` input only.** Feed `coord_d` a uniform value (e.g. `H(self)` or the
  raw decoded peer-id key bytes) for the `prefix(...)` argument, while the wire `participantCoord`
  keeps carrying the recoverable peer id the signature verifies against. Both the walk's routing call
  and the host's recompute must apply the identical transform so they stay equal.
- **Or add a dedicated signer field.** Carry a separate `participantSig`/signer-id field so
  `participantCoord` can revert to a uniform ring coord while the signature still names a recoverable
  key. Heavier (new wire field) — only if a single value can't serve both roles cleanly.

Whichever is chosen, the transform must be applied in **both** `WalkEngine` (routing) and
`host.dispatchRegister` (recompute) so the equality the peer-key-signing ticket established is
preserved.

## Acceptance

- For `d ≥ 1`, the participant routing key and the value the host recomputes `servedCoord` from are
  provably equal (already true for the current `P = self`; preserve it through whatever transform is
  chosen). Add a db-core test at `d = 1`.
- The value fed to `prefix(P, …)` is uniformly distributed across participants (not a peer-id-string
  prefix). Add a distribution/property test over many generated peer ids.
- The wire `participantCoord` (or its replacement signer field) remains a value `verifyPeerSig` can
  recover an Ed25519 key from.
- `docs/cohort-topic.md` §Register / §Tier addressing reflect the final decision (the current note
  already records the open caveat).

## Notes

- Surfaced first by `cohort-topic-per-coord-scoping` (gap #5) as a correctness mismatch; the
  correctness half was resolved by `cohort-topic-peer-key-signing` (gap #1 in its handoff, and its
  review), which intentionally chose `participantCoord = self` for signature verifiability and
  documented this residual in `docs/cohort-topic.md` §Register.
- Intersects `cohort-topic-followon-derivation` (the other multi-tier walk gap) — coordinate the
  wire-field decision with it. It is a **gate** for the multi-tier promotion / live-tier-multi-tier
  work.
