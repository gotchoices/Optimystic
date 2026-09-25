description: Every fake-network test spreads all of a write's data across all its nodes, so the code that handles a write split across two different groups of nodes has never actually run in a test — three separate places in the writing code now carry a comment saying exactly that.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (createMesh, MockMeshKeyNetwork.findCluster, responsibilityK, and the block-to-node helper near the bottom of the file)
  - packages/db-core/src/transactor/network-transactor.ts (consolidateCoordinators — the greedy grouping that collapses; cancelAbandonedSweepBlocks — its `confirmed` filter and the NOTE above it; cancelBatch — the seed round)
  - packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts (the spec whose own comment records that it cannot reach the case)
  - packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts (same limitation, from the cancel side)
difficulty: medium
tradeoffs: Every one of the uncovered branches is small, individually reviewed, and only reachable on a failure path, so a maintainer could reasonably say the cost of standing up a differently-shaped fake network outweighs pinning three `if`s that have never been reported wrong.

# No test fixture ever produces a write that spans two groups of nodes

## The plain version

When a client writes several blocks at once, it does not contact every node separately. It first
asks, for each block, which nodes are responsible for it, then picks the smallest set of contact
points that covers all the blocks — usually **one** node, because in the fake network used by the
tests every node is responsible for every block. The write then goes out as a single request.

Everything downstream of that grouping has two shapes: the one-request shape, and the
more-than-one-request shape where the requests can succeed and fail independently. **Only the
one-request shape has ever run in a test.** The multi-request shape is where partial failure lives —
one group answers, the other does not — and that is precisely the shape the failure-handling code
was written for.

## The three places that say so in their own comments

Each of these was noticed independently, by a different change, and each carries a comment recording
that no test can reach it. That is three instances of one missing fixture, not three problems:

- **Deciding which blocks a half-finished write abandoned.** After a write that committed some
  blocks and lost the rest, the client cancels the ones that never confirmed. The filter that
  separates confirmed from abandoned can only ever do real work when the write went out as more than
  one request; with one request the set is empty and the filter is a no-op. The comment above it in
  `cancelAbandonedSweepBlocks` says this in full and names what a fixture would need.
- **The first cancel round after a failed write.** The cancel reuses the contact points the failed
  write already talked to. Where the write went out as several requests and some of them were
  themselves retried onto a different node, the reused mapping can under-cover — the retried request
  is remembered by only one of the blocks it carried, so the others fall through to the next cancel
  round instead of being cancelled immediately. Correct, but a round slower, and untested.
- **Aggregating a partial commit.** The error a partly-failed commit reports is assembled across
  requests; with one request there is nothing to assemble.

## What a fixture has to do

Force a write whose blocks are not all covered by any single node. The fake network already has the
knob — `createMesh`'s `responsibilityK` makes each block's responsible set the K nodes nearest it by
address distance rather than all of them — so this is a matter of choosing a node count, a K, and
block identifiers whose responsible sets do not overlap, then asserting that the write really did go
out as more than one request before asserting anything else. Two constraints to respect: consensus
needs at least two nodes per block, and the grouping step is a greedy cover, so a single node
appearing in both blocks' responsible sets is enough to collapse it back to one request and make the
test silently vacuous again.

The fixture belongs in the shared harness rather than in one spec, because all three sites above
want it. `debt-torn-commit-mesh-coverage-drops-no-blocks` is already arguing about which layer the
shared failure-injection helpers belong at; whoever picks this up should read that ticket first and
land the fixture beside them.

## What this is not

It is not a claim that any of the three sites is wrong. They were each read carefully and two of
them have direct unit-level coverage of their own logic. This is about the composed behaviour on a
real network shape, which nothing exercises.

## Arm (2026-09-11): production never produces two batches either, for a different reason

Found while reproducing `blocked/writer-and-servers-disagree-on-where-a-block-lives`. In the fake network the grouping collapses to one request because every node is responsible for every block. On a real node it collapses to one request because the node's own key network (`Libp2pKeyPeerNetwork.findCluster`) puts **itself first in every block's responsible set**, and the greedy cover picks the first peer covering the most blocks — so the writer's own node wins for every block, every time. Measured on six real nodes with `clusterSize: 2`: 24 of 24 pends were coordinated locally by the writer, none went out as more than one request, and none passed through a redirect check. So the multi-request shape is unreachable in production today, not only untested — and a fixture built on the fake network's `responsibilityK` knob will exercise it (the fake key network does not put self first) while production still cannot. Whoever builds the fixture should know the two will disagree until D2 in that blocked ticket is decided; a wider-than-cohort mesh is already supported by the harness with no changes (`createMesh(16, { responsibilityK: 4, clusterSize: 4 })` runs as-is in `test/routing-key-convention-divergence.spec.ts`).

## Arm (2026-09-15): multi-collection transactions are untested above three machines, and this fixture is why

A coverage map of every transaction-driving spec, taken while the maintainer's focus was transactions at each node count, found multi-collection coverage stops at three machines: one machine in the plugin's legacy and session-mode specs, two in `two-node-multi-collection-commit.spec.ts` (data tree plus unique index plus schema catalog, on a mock mesh — the strongest case there is), and three in `distributed-transaction-validation.spec.ts` (table plus index, real sockets). Nothing above three, in any package.

That is the same fixture hole seen from the other side. A multi-collection transaction at four or more machines is interesting precisely when the collections' blocks land on *different* cohorts, which is the shape this ticket says nothing can produce. `packages/db-core/test/durability.spec.ts` already records the consequence in its own words: the multi-cohort shape is unreachable on the mesh, so `mergeDurability` and `isFullyDurable` are pinned as pure units instead of through a transaction.

So whoever builds the fixture should treat "a multi-collection commit at four or more machines, whose collections have disjoint cohorts" as one of its first users, alongside the three partial-failure sites above. Until then the gap is recorded here rather than as its own ticket, because a separate ticket would be blocked on exactly this fixture.

## Arm (2026-09-16): production and the fake network now agree, and both produce the two-request shape

The 2026-09-11 arm above is out of date. Since `cohort-assembly-self-only-when-nearest` and `writer-and-harness-route-to-the-cohort`, a real node is in a block's responsible set only when it is among the nearest `clusterSize` serving nodes, and the writer prefers its own node only when it ties another member on how many blocks it covers (`localPeerId` on `NetworkTransactor`). So on a network wider than one responsible set, a write whose blocks have no responsible node in common goes out as one request per set in production too.

The fake network also places blocks by the same rule now: `MockMeshKeyNetwork` ranks nodes with FRET's own ring walk (`assembleCohort`) rather than by address XOR, and a node no longer adds itself to its own view. `test/mesh-harness-cohort-parity.spec.ts` pins the fake network's responsible sets equal to production's over a seeded 16-node ring. Where the body above says "nearest it by address distance", read "nearest it on the ring".

The shape itself is therefore settled and exercised once, end to end: `test/routing-key-convention-divergence.integration.spec.ts` (six real nodes, `clusterSize` 2) drives a two-block pend and commit whose blocks have disjoint responsible sets and asserts two coordinators and exact placement. It does not inject a failure. The harness now has `responsibleNodes` and `nodeWithBlocksInCohort` for choosing such blocks without assuming node indices. What remains of this ticket is the failure fixture on the mesh: a two-request write where one request fails, reaching the three partial-failure sites listed above.
