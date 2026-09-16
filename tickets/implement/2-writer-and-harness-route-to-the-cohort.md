description: Once a machine is in a block's group only when it is genuinely nearest, the code that chooses where to send a write must prefer the writer's own machine only when it is in the group, and the fake network used by the test suite must place blocks by the same rule as the real one so tests model the world production now lives in.
prereq: cohort-assembly-self-only-when-nearest
files:
  - packages/db-core/src/transactor/network-transactor.ts (`NetworkTransactorInit`; `consolidateCoordinators`'s greedy cover, whose first-seen tie-break is why self always won until now)
  - packages/reference-peer/src/cli.ts and packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (the two production transactor constructions; both already compare a peer id to `node.peerId` inside `getRepo`)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MockMeshKeyNetwork`, which ranks by XOR distance via `sortPeersByDistance`; the per-node wrapper in `makeNodeKeyNetwork`, which appends self; `buildNetworkTransactor` and `buildNetworkTransactors`)
  - packages/db-p2p/test/mesh-sanity.spec.ts and packages/db-p2p/test/coordinator-repo-integration.spec.ts (three-node meshes with a responsibility width of one that call a node's coordinator repo directly by index, which only works today because the harness adds self to every node's cohort)
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts (`ringOf`, the seeded FRET ring the parity spec compares against) and packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (pin local coordination equal to cohort membership; add a multi-block pend whose blocks have disjoint cohorts)
  - packages/db-core/test/network-transactor.spec.ts (§cluster intersection consolidation, where the tie-break case belongs)
  - tickets/backlog/debt-no-mesh-fixture-forces-two-coordinator-batches.md (carries an arm recording that production and the harness now agree on producing the two-batch shape)
difficulty: medium
----

# Why the writer needs a tie-break

`consolidateCoordinators` asks the key network for each block's cohort, then greedily assigns blocks to the peer covering the most still-uncovered blocks, with ties going to the peer seen first. Self used to be first in every cohort, so self always won and every pend was coordinated locally. After the first ticket, cohorts are in proximity order and self is present only when it is among the nearest. For a single-block pend whose cohort is `[A, self]`, A and self tie at one block each and A is seen first, so the writer would send the pend over the network to A even though its own node is a perfectly good coordinator. On a small network, where every serving node is in every cohort, that would turn every write into a remote hop, which the maintainer's decision explicitly says must not happen at those sizes.

So: on a coverage tie, prefer self. Never prefer self over a peer that covers more blocks, because fewer batches is the point of the greedy cover. Coverage of zero never wins.

The transactor does not know who "self" is today. Add an optional `localPeerId` to `NetworkTransactorInit` (the type already carries the optional `localChangeNotifier`, which is the same "co-located node" idea). Both production constructions pass `node.peerId`; `buildNetworkTransactors` in the harness passes each node's peer id; `buildNetworkTransactor` (one transactor shared by every node) passes none, as today. When absent, the tie-break is first-seen, exactly the current behaviour.

# Multi-batch pends are now a production shape

With self no longer covering every block, a multi-block pend on a network wider than `clusterSize` can genuinely resolve to two or more coordinators. `processBatches` already runs batches concurrently, the pend already fails as a whole when any batch fails and then cancels every batch, and the commit already sweeps per batch and reports `torn` blocks. Nothing new is designed here; what changes is that these paths are reachable. The integration spec must therefore drive at least one multi-block pend and commit whose blocks the driver's key network places in disjoint cohorts, assert it went out as more than one batch (both coordinators' repos record a pend), and assert every block lands on exactly its cohort. The backlog ticket `debt-no-mesh-fixture-forces-two-coordinator-batches` already carries an arm saying the harness and production disagreed on this shape; this ticket adds an arm saying they now agree, so the remaining ask there is the unit-level fixture for the three partial-failure sites, not the shape itself.

# Harness parity

The mesh harness's `MockMeshKeyNetwork` ranks peers by XOR distance between the hashed key and the peer id. Production ranks by ring distance: FRET's `assembleCohort` walks successors and predecessors outward from the coordinate. The two orderings do not agree in general, so "the harness places a block where production places it" can only be made true by construction: have the harness rank with `assembleCohort` from `p2p-fret` over a `DigitreeStore` holding every mesh node at `hashPeerId(peerId)`. The unit divergence spec's `ringOf` already does exactly this to model the servers, so the harness and that spec share the primitive. `findCluster` returns the nearest `responsibilityK` in that order, with no self appended; `findCoordinator` returns the first non-excluded entry of the full-ring order, which mirrors production's connected-fallback tier (an out-of-cohort pick is a hop, not a placement).

The per-node wrapper `makeNodeKeyNetwork` keeps the partition filter and drops the "add self if missing" clause. Its doc comment and the two nearby comments saying `findCluster` always includes self are rewritten. The empty-view guard in `admitMembership` stays: a member outside the cohort is never sent the record, and the crafted-record outsider case in `mesh-partition-admission.spec.ts` is refused by the self-membership predicate before any view is derived.

Add a parity spec: build a seeded mesh (`keySeed`) and a seeded `DigitreeStore` over the same peer ids; for a few hundred block ids at widths of one, two and four out of sixteen nodes, the harness cohort equals the production rule's cohort (the first ticket's shared assembly, applied over the same store) as an ordered list, and a node is in its own per-node view exactly when it is in that cohort.

# Specs that assumed every node is responsible

`createMesh(3, { responsibilityK: 1 })` appears in `mesh-sanity.spec.ts` and `coordinator-repo-integration.spec.ts`, and several of those cases call `mesh.nodes[0].coordinatorRepo.pend(...)` regardless of which node the block belongs to. They pass today only because the harness adds self, which makes node 0 believe it is responsible and run a two-member consensus with the real holder. After this ticket node 0's view of such a block is the holder alone, and the third ticket turns the responsibility check into a refusal. Migrate each case to pick the responsible node through `mesh.keyNetwork.findCluster(routingKeyForBlock(id))` (the harness's `nonResponsibleNodes` helper is the model), or to drive the write through a transactor built by `buildNetworkTransactors`. Cases already labelled "on responsible node" or "solo" keep their meaning. A case titled "pend + commit through different nodes independently" should choose one block per node such that each node is that block's sole responsible peer.

# Edge cases & interactions

- Tie-break must not change batching on a wide network: with cohorts `[A, self]` and `[A, B]` for two blocks, A covers two and wins outright; self is not preferred. Pin in the transactor spec alongside the existing consolidation cases.
- Tie-break with self absent from every cohort: first-seen, one remote batch. Pin.
- No `localPeerId`: identical assignments to today's first-seen rule. The existing consolidation cases already pin that; keep them green without changes.
- Retries: `processBatches` re-picks through `findCoordinator` with the failed peer excluded. If the failed peer was self (its local coordinated repo threw), the retry goes remote; if it was remote and self is in the cohort, `findCoordinator` may pick self. No change needed, but state it in the spec that covers a failed local batch.
- The per-transaction coordinator cache seeded after pend (`txnCoordinatorsFor`) records whichever peer pended each block, so commit follows the same tie-break decision without re-running it.
- Harness under partition: `partitionSides` filters a node's cohort view to its side; with the self-append gone, a node whose side holds none of the block's cohort sees an empty view and is not responsible. All current partition specs run meshes whose responsibility width equals the node count, so every side keeps its members. Confirm by running them.
- `findClusterFails` in the harness still returns an empty map; unchanged.
- `keySeed` makes ring geometry reproducible; the parity spec must use it, and any migrated case that asserts on which node is responsible should either use it or ask the key network.
- The read side of the integration spec already pins zero redirects and zero out-of-cohort replicas; keep those pins. The writer node reading its own recent writes still hits the collection's cache (`CacheSource.transformCache` folds each commit in), so a write-then-read in one session costs no round trip; a fresh collection instance reads from the cohort, which now holds the block on every responsible peer.

# Tests

- Transactor spec: the three tie-break cases above.
- Harness parity spec as described.
- Migrated mesh-sanity and coordinator-repo-integration cases green with the responsible node chosen through the key network.
- Integration spec: `pendHandledLocally` equals `driverInCohort`; the multi-block disjoint-cohort case goes out as two batches and lands on exactly its cohorts; the read pins hold. Run once, paste the summary.

# TODO

- Add `localPeerId` to `NetworkTransactorInit` and the self-preferring tie-break in `consolidateCoordinators`; pass it from the two production constructions and from `buildNetworkTransactors`.
- Rewrite `MockMeshKeyNetwork` on `assembleCohort` over a `DigitreeStore`; drop the self-append from the per-node wrapper; rewrite the affected comments.
- Add the parity spec.
- Migrate the narrow-width mesh cases in `mesh-sanity.spec.ts` and `coordinator-repo-integration.spec.ts`.
- Extend and re-pin the integration spec; run it once.
- Append the arm to `tickets/backlog/debt-no-mesh-fixture-forces-two-coordinator-batches.md`.
- Build, lint, db-core and db-p2p unit suites, the Quereus plugin suite (it constructs the transactor); hand off with any gap stated plainly.
