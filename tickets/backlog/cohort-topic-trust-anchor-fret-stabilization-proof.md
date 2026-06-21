description: Let a node far from a cohort verify, on first contact, that a membership list really is that cohort — today only nearby nodes can check this, so distant subscribers still trust new membership certificates on faith.
prereq: cohort-topic-trust-anchor-fret-binding
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-core/src/cohort-topic/wire/types.ts (MembershipCertV1.fretAttestation)
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts
  - (p2p-fret — external package; needs a stabilization-proof API)
----

# Transferable FRET stabilization proof for distant first-sight anchoring

## Why

After `cohort-topic-trust-anchor-core` + `-fret-binding`, the membership trust gate fully anchors a
cert's `coord → keyset` binding **only on nodes whose FRET routing table covers the coord** (they can
run `assembleCohort` and compare). A node far from the coord — most importantly a reactivity subscriber
verifying a tail cohort it is nowhere near — gets `"unknown"` from the direct anchor and falls back to
**trust-on-first-use** (accept any self-consistent cert). That is the same exposure the original
trust-anchoring ticket set out to remove, narrowed to the distant first-sight case.

The original `cohortCoord → keyset` forgery is still possible against a distant verifier on a coord it
has never seen and cannot reach an epoch-rotation chain to. Closing it requires a **transferable**
proof: something a node *near* the coord can produce and a *distant* node can verify without holding the
routing table.

## Blocked on (the reason this is backlog, not plan)

p2p-fret 0.5.0 exposes **no** stabilization proof / membership-certificate / attestation API — only the
*local* `assembleCohort`/`expandCohort` ring selection and signed `NeighborSnapshotV1` gossip. The
`MembershipCertV1.fretAttestation` field exists in the wire type but is never populated. A transferable
proof is therefore a **p2p-fret feature**, not something db-core/db-p2p can synthesize:

- FRET would need to emit, at stabilization, a verifiable certificate that the `k` peers closest to
  `coord` are exactly `members` — e.g. a quorum of signed `NeighborSnapshotV1`s whose successor/
  predecessor links transitively pin the closest-`k` set, or a dedicated stabilization signature.
- db-core's `IMembershipTrustAnchor.directAnchor` (or a new transferable-proof check fed the cert's
  `fretAttestation`) would then return `"anchored"`/`"rejected"` for distant coords too, and the db-core
  interim TOFU fallback could be tightened.

## Requirements / expectations

- A node that does not cover a coord can verify, from the cert's `fretAttestation` alone, that `members`
  is the legitimate cohort for `cohortCoord` — no routing-table access required.
- Composes with the existing model: it is an additional way to reach `"anchored"`, alongside the local
  ring check and the epoch-rotation chain; it does not replace them.
- A forged cert from an unrelated keyset on a coord the verifier has never seen is rejected even on a
  distant node (the property the chain + local-ring anchor cannot give distant first-sight today).
- Bounded proof size and synchronous verification (the participant verify path is sync — see
  `threshold-crypto.ts` verify constraints).

## Notes

- Until this lands, the distant first-sight gap is the documented residual limit of the trust-anchor
  work; the epoch-rotation chain still protects rotations once any cert for a coord is trusted, and the
  `promote`/host path is fully anchored via the local ring check.
- Coordinate with whoever owns p2p-fret — this likely starts as a FRET RFC, not an Optimystic change.
