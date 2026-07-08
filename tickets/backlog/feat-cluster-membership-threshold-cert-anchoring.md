description: Right now each node decides who is responsible for a piece of data by re-deriving that group itself from network state; a stronger design would have the whole responsible group jointly sign a certificate of its own membership that any node can verify without re-deriving. Adopt that certificate as the anchor for cluster identity — once the machinery it depends on exists.
prereq: cluster-membership-admission-gate
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts (CachingMembershipVerifier, trust gate)
  - packages/db-core/src/cohort-topic/membership/source.ts (IMembershipSourceRouter — T0/T1 committed vs T2/T3 FRET)
  - packages/db-core/src/cohort-topic/sig/threshold.ts (CohortSigner threshold verify)
  - packages/db-core/src/cohort-topic/wire/types.ts (MembershipCertV1 ~431-438)
  - packages/db-p2p/src/cluster/cluster-repo.ts (where cluster records would consume a cert)
----

## Why this is backlog, not an implement ticket

Two tickets — `bind-cluster-membership-into-signed-record` and `cluster-membership-admission-gate` — make
cluster membership *agreed*: the responsible peer set is bound into the signed transaction identity, and
each member independently admits or rejects the declared set against its own confident view of the
network. That is sufficient for the correctness properties in `docs/correctness.md` (Theorem 1, Theorem 2).

Those two tickets establish agreement through **local re-derivation plus tolerance** — each honest member
computes its own expected cluster and checks the declared set against it. A stronger model exists: anchor
cluster identity on a **threshold-signed membership certificate** (`MembershipCertV1`,
`packages/db-core/src/cohort-topic/wire/types.ts`), so the responsible group is a single artifact the
whole cluster jointly signed (a `k − x` quorum over its own member set) that any node verifies without
re-deriving. This removes the tolerance fuzziness and the reliance on each verifier's private FRET view.

**It is deferred because the source it would depend on does not exist yet.** The membership-verifier's own
documentation (`membership/verifier.ts`, `membership/source.ts`) states that committed work — tiers T0/T1,
which is exactly what cluster transactions are — anchors membership in the **transaction-log commit
certificate**, and that this "committed-index binding" has **not landed**: for T0/T1 the verifier is still
trust-on-first-use until it does (tracked by the cohort-topic `...-txlog-committed-binding` /
`...-membership-cert-trust-anchoring` work). Building cluster-record identity on a certificate source that
is itself a stub would be building on sand. When that source is real, this becomes actionable.

## What "done" would look like (for whoever promotes this)

- A block's cluster identity is a verifiable `MembershipCertV1`-shaped certificate (coord + epoch +
  member set + threshold signature), not a per-node re-derivation.
- Cluster records reference the membership certificate (or its epoch/coord) instead of / in addition to
  the raw `peers` map; members verify the cert via the existing `CohortSigner.verifyThreshold` +
  trust-gate path rather than re-deriving and comparing.
- The admission gate from the prereq ticket collapses into "does the record's membership cert verify and
  is it the current epoch for this block's coord" — a cryptographic check rather than a tolerance window.
- Membership rotation (churn) is handled by the cert's existing rotation-attestation chain
  (`prevEpoch` / `rotationSig` / `rotationSigners`) rather than the per-transaction tolerance.

## Open questions to resolve when promoting

- **Coord derivation for a block cluster.** Cohort certs are keyed by an opaque `RingCoord` (a hash); the
  cluster subsystem keys by `blockId` via FRET `findCluster`. How does a block map to a cert coord/epoch,
  and who publishes/rotates that cert for a block cluster?
- **Which membership source.** Committed cluster work is T0/T1 → the tx-log commit-certificate source
  (the unfinished binding). Confirm that is the intended anchor rather than the FRET-cert (T2/T3) path.
- **Migration from the agreed-but-re-derived model.** The two implement tickets ship first; this replaces
  their local-derivation agreement with cert-anchored agreement. Define the coexistence/cutover.

Not urgent, not blocking any current correctness property. Promote once the committed-tier membership
source lands.
