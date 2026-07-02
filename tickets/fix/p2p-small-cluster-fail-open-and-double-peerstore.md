----
description: When the node is unsure whether a cluster is large enough, it proceeds anyway instead of refusing, so undersized clusters reach agreement by default; also fixes a redundant per-operation peer lookup done twice.
files: packages/db-p2p/src/repo/cluster-coordinator.ts (validateSmallCluster ~347-380; caller ~254), packages/db-p2p/src/libp2p-key-network.ts (findCluster ~589, ~627)
difficulty: medium
----

# validateSmallCluster fails open; hot-path double peerStore reads

Two independent issues in the same area.

## (a) validateSmallCluster fails open (correctness / security)

`validateSmallCluster` (`repo/cluster-coordinator.ts:347-380`) is meant to reject
clusters smaller than the safe minimum. But when the network-size estimator
(FRET) has no confident estimate, the fallback returns `true` — so any
sub-minimum cluster proceeds to consensus. The "development/testing" carve-out
this fallback was written for is actually the **default production path** whenever
estimator confidence is at or below 0.5, i.e. it fails open exactly when it
should fail closed.

Expected: gate the permissive fallback behind an explicit config flag that
defaults to off, so that with no confident estimate an undersized cluster is
rejected rather than admitted.

## (b) Double peerStore read on the hot path (perf)

`findCluster` (`libp2p-key-network.ts:589, 627`) fetches each cohort member from
the peerStore **twice** — once for protocols and once for addresses — on the
per-pend/per-commit hot path. A single `store.get(pid)` can serve both.

Expected: one peerStore read per member, reused for both protocols and addresses.

## TODO
- Add a config flag (default off) gating the low-confidence permissive fallback;
  reject sub-minimum clusters when confidence is low and the flag is off.
- Collapse the two `findCluster` peerStore lookups per member into one.
- Test: low-confidence + undersized cluster is rejected unless the flag is set.
