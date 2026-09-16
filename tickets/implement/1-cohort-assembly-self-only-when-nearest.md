description: A machine currently puts itself into every block's replica group and picks itself as the coordinator, even when it is not one of the machines responsible for that block. Change the replica-group rule in the network layer so a machine is in a block's group only when it genuinely is among the nearest responsible machines, and make the coordinator choice come from that same ordered group.
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster` on both the membership-scoped and unscoped paths; `findCoordinator`'s FRET tier, connected-fallback tier and last-resort self tier; `getNeighborIdsForKey`, which goes away; `membershipOf`, which today calls self a server unconditionally; `shouldAllowSelfCoordination`, unchanged)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (the `findCluster` membership cases near "self is always kept", and every `findCoordinator` case whose mock FRET supplies `getNeighbors` rather than `assembleCohort`)
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts (`ringOf` builds a seeded FRET ring; reuse it for the small-network and wide-network invariants)
  - packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (write-side pins flip: no responsible-holder shortfall, no phantom copies, the writer's pick inside the cohort for every block)
  - packages/db-p2p/node_modules/p2p-fret/src/service/cohort.ts (`assembleCohort`: alternating successor/predecessor walk outward from the coordinate, live members only, includes this node when it is among the nearest) and packages/db-p2p/node_modules/p2p-fret/src/service/fret-service.ts (`getNeighbors` with direction `both` is successor-biased, which is why the coordinator pick could fall outside the cohort)
  - packages/db-p2p/src/repo/coordinator-repo.ts (comment only: the NOTE in `fetchBlockFromCluster` saying the production key network cannot produce an empty cohort because it always includes self)
  - packages/db-p2p/docs/cluster.md (§Network-Membership Scoping says "`findCluster` keeps self plus the nearest `serves` peers only"; §Self-Coordination Is Never Memoized)
difficulty: hard
----

# Decision this implements

Maintainer decision of 2026-09-14 (arm B of the blocked ticket about the writer and the servers disagreeing on where a block lives): a machine is in a block's cohort only when it is genuinely among the nearest `clusterSize` serving peers. "Self as an extra copy" was rejected because it bakes in the assumption that the writer holds every block it writes, which is exactly what fails once a network is wider than the replication factor.

At small sizes nothing changes: when the serving peers number at most `clusterSize`, the nearest `clusterSize` peers are all of them, self included. Every sereus deployment documented today is in that regime.

This is the first of three tickets. This one changes the network layer's answer. `writer-and-harness-route-to-the-cohort` makes the writer and the test harness use it. `coordinator-refuses-blocks-it-is-not-responsible-for` makes the server side enforce it.

# The rule, stated once

Both `findCluster` and `findCoordinator` must derive their candidates from one shared, ordered assembly. Define it as a private method (name it something like `assembleServingCohort`) returning the ordered peer-id list plus, on the scoped path, the peerStore records already read (so `findCluster`'s address backfill does not read them twice, as today):

```
coord   = hashKey(key)                                   // the one hash between a block id and its cohort
band    = fret.assembleCohort(coord, scoped ? membershipOverfetch() : clusterSize)
// FRET's ring store holds this node, so `band` already contains self whenever self is among the
// nearest live members. Absence from the band means self is farther than every band member.
if selfServes() and self not in band: append self to band
if not selfServes():                  remove self from band
serving = scoped ? band filtered to members whose membership is 'serves' (order preserved) : band
cohort  = first clusterSize entries of serving
```

`selfServes()` is true when no `protocolPrefix` is configured (the unscoped path, where every peer counts as serving, as `membershipOf` already does), or when `libp2p.getProtocols()` advertises this network's `cluster` or `repo` protocol. That is the same test applied to remote peers via their peerStore protocol lists, so self is classified on exactly the same footing. A libp2p double with no `getProtocols` counts as serving, the same convention `getConnections?.()` already follows for mocks. `membershipOf(self)` must call this instead of returning `'serves'` unconditionally.

Consequences that the implementer should confirm rather than assume:

- A node with no live ring members other than itself gets a self-only cohort. This keeps the solo short-circuit in `CoordinatorRepo` intact for a node with no peers, unchanged.
- On the scoped path, self is no longer placed first. It sits at its proximity position, and `nonSelfTarget` (`clusterSize - 1`) goes away: the cohort is simply the first `clusterSize` serving members.
- On the unscoped path the trailing `[...cohort, selfId]` union goes away.
- `findCluster` keeps everything after membership classification unchanged: address backfill, the addressless and self-relay-only diagnostics, self's memoized multiaddrs.
- Verify (with a unit case over a real `FretService` or by reading `isLiveMember` in p2p-fret) that this node's own ring entry passes the live-member filter `assembleCohort` applies, so self really does appear in the band when nearest. The integration spec's `driverInCohort` counts (about a third of blocks at six nodes and width two) say it does today.

# `findCoordinator` picks from the same ordered cohort

Today the FRET tier ranks `getNeighbors(coord, 'both', clusterSize)`, which lists successors first and then predecessors, while cohorts come from `assembleCohort`, which alternates outward. The two agree on the first entry and disagree on the second, so on a write where self heads the cohort and is not allowed to coordinate, the pick can land on a peer just outside the cohort. Observed as `writerPickOutsideCohort` in the integration spec (1 of 24 blocks on one run).

Replace the FRET tier's candidate list with the ordered cohort from the shared assembly, and delete `getNeighborIdsForKey`. Then:

- Candidates are the cohort filtered by `isSelectable`, then by "connected, or self and admissible", then stably sorted by reputation score so proximity order survives among equal scores. `filterByMembership` stays as the final scope check, and since cohort members were already classified on the scoped path it costs nothing new there.
- Self is admissible in the FRET tier exactly when self is in the cohort AND today's `shouldAllowSelfCoordination` guard allows it (or the existing isolated-read degrade applies). The guard is kept on top of the cohort condition rather than narrowed to the solo-cohort case: it is strictly more conservative, its every branch already has tests, and in a multi-member cohort with zero connections the remote members are unreachable anyway so the guard's denial costs nothing.
- The connected-fallback tier is kept as is. It can pick a serving peer outside the cohort when no cohort member is connected. That is a redirect hop, not a wrong placement: the third ticket makes the receiving node redirect to the cohort or refuse. Write a `NOTE:` at that tier saying a not-connected cohort member with a known address could be preferred over an out-of-cohort connected peer if redirect hops ever show up in profiles.
- The last-resort self tier runs only when self is in the cohort (compute the cohort once per attempt and keep the last attempt's answer for this tier). A node that does not serve storage therefore never self-coordinates: it fails with `NO_NETWORK_COORDINATOR` when the membership filter dropped unconfirmed candidates, otherwise `NO_COORDINATOR_AVAILABLE`. `SELF_COORDINATION_EXHAUSTED` keeps its meaning (the caller excluded self on a solo node).
- `retryCouldImprove` is fed the cohort's non-self ids, the same role `ids` plays today.
- The coordinator cache is unchanged: a cached coordinator is trusted without re-deriving the cohort. A cached peer that has since left the cohort is corrected on the next hop by the redirect the third ticket wires in (the redirect target overwrites the hint), or by exclusion when the dial fails. Record that as a `NOTE:` at `getCachedCoordinator`.

Production has no node that registers no storage protocols today (`createLibp2pNode` always registers both services, and sereus's transaction profile only changes the FRET edge/core choice and a Ring Zulu hint), so the non-serving branch is defence in depth, but it must be tested because the rule is what makes a future client-only node safe.

# What this does NOT change

- The transactor's coordinator choice among cohort members (`consolidateCoordinators`) and the tie-break toward self: second ticket.
- The mesh harness's key network, which still appends self: second ticket. Until it lands the harness models the old world; that is acceptable for one ticket because no harness spec asserts on the production key network.
- The server-side responsibility check's failure mode and the redirect check: third ticket.

# Edge cases & interactions

- Solo node, zero peers, serving: cohort is `[self]`; the solo short-circuit and single-signer proof are unchanged. Cover with a unit case whose mock `assembleCohort` returns `[]`.
- Ring no wider than `clusterSize`: every serving node is in every cohort, self included, in proximity order. This is the small-network invariant and the reason sereus's documented deployments see no change; pin it on a seeded FRET ring (`ringOf` in the unit divergence spec) at every width from 1 to `clusterSize`.
- Ring wider than `clusterSize`: self is in the cohort for a block if and only if self is among the nearest `clusterSize` live serving members. Pin against `assembleCohort` over the same store, independently of the key network, at widths past `clusterSize`.
- Membership-scoped path with a cross-network peer nearer than a serving peer: the over-fetch band still reaches the serving peer, self is classified by `selfServes()`, and the cohort holds the nearest `clusterSize` serving members whether or not self is one of them. The existing spec case "sizes the cohort to clusterSize (self counts toward it)" flips: with three serving peers nearer than self and `clusterSize` 2, self is now excluded. The case "excludes a cross-network cohort member when a serving cohort already exists" keeps self, because only one serving band member exists.
- Not-yet-identified (`unknown`) members are still never admitted, so a fresh mesh still writes self-only until identify completes. Unchanged.
- Self not serving (a client-only libp2p node): never in any cohort at any width, never picked by any tier, `findCoordinator` fails as described above rather than self-coordinating, and `findCluster` may legitimately return an empty map when no serving peer is known. Because of that, restate the NOTE in `CoordinatorRepo.fetchBlockFromCluster` ("cannot even produce one"): a serving node's `findCluster` always contains at least itself when it knows no nearer serving peer; only a non-serving node can see an empty cohort, and such a node runs no `CoordinatorRepo` today.
- Mocked FRET in the key-network spec: a mocked `assembleCohort` that omits self now means "self is farther than every listed peer". Cases that need self nearest must list self in the band at its position. Every `findCoordinator` case that mocks `getNeighbors` must mock `assembleCohort` instead, since the tier no longer calls `getNeighbors`.
- Cost on the scoped path: `findCoordinator` now classifies the whole over-fetch band (one peerStore read per band member, bounded by the number of live ring members) instead of only the connected neighbours. On a small network that is at most one read per known peer. Write a `NOTE:` tripwire at the shared assembly: if peerStore reads per lookup ever show in a profile, memoize the per-peer membership verdict with a short TTL rather than caching cohorts.
- The reputation sort must be stable, or an equal-score cohort loses its proximity order and two writers stop agreeing on the nearest coordinator. `Array.prototype.sort` is stable in every supported runtime; say so in a comment.
- Partitioned node whose ring table shrank to itself: it derives a self-only cohort and commits solo. That is the downsizing leak already recorded in `backlog/more-design/6.5-partition-healing.md`; the grace-period and partition-detected guards remain the mitigation. Do not widen scope and do not weaken the guard.

# Tests

- Unit (key network spec): the small-network invariant at widths 1 through `clusterSize`; self excluded when `clusterSize` serving peers are nearer; self included when it is among the nearest; a non-serving self never in a cohort and never a coordinator, failing with the named error codes; `findCoordinator` on a write whose cohort is `[self, A]` with self denied by the guard picks A (the cohort's second entry), not FRET's second successor; the connected-fallback tier still picks an out-of-cohort connected serving peer when no cohort member is connected.
- Unit (divergence spec, seeded ring): for every width from 1 to 32 and every block id, the key network's cohort equals `assembleCohort` over the same store filtered to serving members and cut to `clusterSize`, and its coordinator (self allowed) is the cohort's first selectable entry.
- Integration (six real nodes, `clusterSize` 2, gated on `OPTIMYSTIC_INTEGRATION=1`): `writerPickOutsideCohort` 0 of 24, `blocksWithCohortGap` 0, `blocksWithPhantomHolder` 0, `pendHandledLocally` at most `driverInCohort` (equality is the second ticket's pin), writes and reads complete. Run it once and paste the summary table into the handoff.

# TODO

- Add `selfServes()` and route `membershipOf(self)` through it.
- Extract the shared ordered serving-cohort assembly; rewrite both `findCluster` paths on it; delete the self-first and self-append logic.
- Rewrite `findCoordinator`'s FRET tier on the same assembly; gate the last-resort self tier on self being in the cohort; delete `getNeighborIdsForKey`.
- Add the two `NOTE:` tripwires (cache trust, band classification cost) and the connected-fallback `NOTE:`.
- Update the key-network spec: migrate `getNeighbors` mocks to `assembleCohort`, flip the "self counts toward it" case, add the new cases listed under Tests.
- Add the seeded-ring invariants to the unit divergence spec.
- Flip the integration spec's write-side pins; run it once.
- Restate the `fetchBlockFromCluster` NOTE; update `packages/db-p2p/docs/cluster.md` §Network-Membership Scoping and the self-coordination paragraph to the new rule.
- Build, lint, `yarn lint:docs`, db-p2p unit suite; hand off with the integration summary and any gap stated plainly.
