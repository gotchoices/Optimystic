description: Add a multi-node test where several peers share responsibility for the same data, to confirm the "you're not the right node" hand-off behaves correctly when the responsible group has more than one member.
files: packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-key-network.ts
difficulty: medium
----

# Multi-member cohort coverage for the repo redirect path

## Why

The repo-redirect key-derivation fix (`optimystic-repo-redirect-key-derivation`, completed) is
proven end-to-end only with `clusterSize: 1`. At size 1 the responsible group is a single peer, so
the test cannot exercise the case where a request lands on one member of a multi-peer responsible
group.

There is a known, **benign** divergence between the two code paths that decide responsibility:

- The cluster coordinator's `findCluster(encode(blockId))` assembles a cohort of exactly
  `clusterSize` peers (`libp2p-key-network.ts`).
- The redirect check's `getCluster(encode(blockId))` clamps the cohort to
  `min(clusterSize, networkSizeEstimate)` (`network-manager-service.ts:311`).

During a transient window where FRET's network-size estimate *underestimates* (cold-start / churn,
in a network with at least `clusterSize` peers), `getCluster` returns a smaller cohort than
`findCluster`. A boundary peer ranked between the estimate and `clusterSize` would then be a
coordinator-recognised member yet be excluded by its own redirect check.

This is **benign** and already reasoned about during review: FRET's `assembleCohort(coord, wants)`
(`p2p-fret/src/service/cohort.ts`) is a deterministic outward walk returning the first `wants`
peers, so `assembleCohort(coord, k)` is a prefix-subset of `assembleCohort(coord, k+m)`. Hence
`getCluster`'s cohort is always a subset of `findCluster`'s — a redirect can never point at a
non-responsible peer; the worst case is one extra, self-healing hop while the estimate converges.

## What to build

A gated integration test (alongside the existing `redirect round-trip` test) with `clusterSize ≥ 2`,
on a mesh sized so the FRET cohort is a **proper subset** of the membership (i.e. some nodes are in
the responsible group and some are not). Assert:

- a request dialed to a non-member node redirects to a member of the multi-peer cohort and completes;
- a request dialed to a genuine cohort member is handled locally (no spurious redirect), including the
  boundary-rank member — i.e. confirm the prefix-subset property holds in a live ring and the
  divergence stays benign;
- (optional, harder) deliberately drive the estimate-lag window if a test seam allows, to assert the
  extra-hop path still resolves within the client's max-2-hop budget rather than erroring.

Expected outcome: confirmation that the divergence is benign in a real multi-member ring. This is
hardening / defense-in-depth coverage, not a bug hunt — keep it low priority.

## Notes

- The existing `redirect round-trip` test in `real-libp2p.integration.spec.ts` is the template:
  FRET-derived block selection (probe `getCluster` for an id whose cohort excludes the entry node),
  fresh ids per probe iteration to dodge the per-key cluster cache, full-mesh dial + two-sided ring
  stabilization probe, and a distinct driver node so neither hop self-dials.
- Gated behind `OPTIMYSTIC_INTEGRATION=1`; not in default CI. Real-FRET small-N tests can be
  timing-sensitive — budget generous stabilization timeouts.
