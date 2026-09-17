description: Now that a machine is in a block's group only when it is genuinely nearest, the writer sends a write to its own machine whenever that machine is one of the equally good choices, and the fake network the tests use places blocks by exactly the rule the real network uses, so tests model the world production lives in.
files:
  - packages/db-core/src/transactor/network-transactor.ts (`NetworkTransactorInit.localPeerId`; `consolidateCoordinators` now calls `bestCoveringPeer`, a module-level function holding the greedy round and the tie-break)
  - packages/db-core/test/network-transactor.spec.ts (§cluster intersection consolidation → describe "tie-break toward the local peer", 5 cases)
  - packages/reference-peer/src/cli.ts and packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (pass `localPeerId: node.peerId`)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MockMeshKeyNetwork` on `assembleCohort` over a `DigitreeStore`; per-node wrapper `makeNodeKeyNetwork` no longer adds self; new `MeshNode.keyNetwork`; new exports `responsibleNodes`, `blockIdsInCohortOf`; `buildNetworkTransactors` passes each node's `localPeerId` through the private `meshTransactor`)
  - packages/db-p2p/test/mesh-harness-cohort-parity.spec.ts (new)
  - packages/db-p2p/test/util/seeded-ring.ts (new: `ringPeersOf`, `ringOf`, `ringKeyNetworkOf`, moved out of the divergence spec)
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts (uses the util; behaviour unchanged)
  - packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (both transactors pass `localPeerId`; `pendHandledLocally` pinned equal to `driverInCohort`; new two-block disjoint-cohort write)
  - packages/db-p2p/test/mesh-sanity.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts (narrow-width cases migrated)
  - packages/db-p2p/test/util/node-count-mesh.ts (`transactorDrivenBy` steers pends with `localPeerId` instead of reordering cohorts)
  - packages/db-p2p/test/util/two-machine-lifecycle.ts, packages/quereus-plugin-optimystic/test/{distributed-quereus,distributed-transaction-validation}.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/manual-mesh-test.ts, packages/reference-peer/test/{distributed-diary.spec,quick-test}.ts (production-shaped multi-node transactors pass `localPeerId`)
  - docs/optimystic.md (§Wire up a transactor snippet rewritten; MeshHarness paragraph), packages/db-p2p/docs/cluster.md (§Network-Membership Scoping, one added passage)
  - tickets/backlog/debt-no-mesh-fixture-forces-two-coordinator-batches.md (arm appended)
difficulty: medium
----

# What was built

Second of the three tickets from the maintainer's 2026-09-14 decision (arm B). The first made cohorts proximity-ordered with self present only when nearest; the third (`coordinator-refuses-blocks-it-is-not-responsible-for`) turns responsibility into a hard server-side refusal.

**Writer tie-break.** `NetworkTransactorInit` takes an optional `localPeerId`: the node whose `getRepo` answer is a co-located repo. `consolidateCoordinators`' greedy cover now picks each round's winner through `bestCoveringPeer`: most still-uncovered blocks wins; on a tie, `localPeerId` wins when it is among the tied peers, else first-seen (the nearest). A peer covering zero blocks never wins. Absent `localPeerId`, assignments are identical to before. Both production constructions pass `node.peerId`.

**Harness parity.** `MockMeshKeyNetwork` no longer ranks by XOR. It builds (lazily, once per node count) a `DigitreeStore` of every node at `hashPeerId`, and ranks with FRET's `assembleCohort`, the same walk production asks FRET for. `findCluster` returns the nearest `responsibilityK`; `findCoordinator` returns the first non-excluded entry of the whole-ring walk. The per-node wrapper keeps the partition filter and no longer appends self, so a node's coordinator is responsible only for blocks whose cohort includes it. The wrapper is now exposed as `MeshNode.keyNetwork` (replacing an internal map), the analogue of a real node's `keyNetwork` attachment.

**Multi-batch pends.** Nothing new designed; the integration spec now drives one.

# Deviations and additions beyond the ticket text, for the reviewer to weigh

- **`localPeerId` is also passed in production-shaped multi-node test transactors** (two-machine lifecycle helper, the plugin's distributed specs, reference-peer's distributed diary, two manual scripts). They are copies of the production wiring; without it they would now send about half their writes to the partner, which is not what production does. Solo-node constructions (`fresh-node-ddl-libp2p`, `host-node-activation`, `plugin-first-launch-libp2p`) were left alone: a one-member cohort cannot tie.
- **`transactorDrivenBy` (node-count sweep helper) changed mechanism.** It used to reorder `findCluster` to put the driver first, which relied on the old first-seen tie-break. It now passes `localPeerId: driver.peerId` and leaves the cohort untouched; its `findCoordinator` override (reads and retries) is unchanged. Equivalent at every size the sweep runs (all nodes in every cohort); the sweep and `member-leaves-and-returns` pass.
- **New harness exports** `responsibleNodes(mesh, blockId)` (cohort in proximity order) and `blockIdsInCohortOf(mesh, node, count, prefix)` (scans `${prefix}-${i}` ids, throws after 10 000). The migrated specs use them. They are on the published `@optimystic/db-p2p/testing` entry, which only imports runtime dependencies (`p2p-fret` already was one).
- **Seeded-ring helpers extracted** to `test/util/seeded-ring.ts` rather than copied into the parity spec. The ring seed `(n, i)` is the same byte layout as the harness's `keySeed`, so `createMesh(16, { keySeed: 16 })` holds exactly `ringPeersOf(16)`; the parity spec asserts that rather than assuming it.
- **Two extra transactor cases** beyond the three the ticket named: "no local peer id → first-seen" and "a failed local batch is retried remotely" (the ticket asked for the retry behaviour to be stated in a spec; there was no existing spec covering a failed local batch, so this is it).
- **Parity spec has a partition case** (width 2, two sides of 8): each node's view equals the cohort filtered to its side, and some views are empty.
- **`docs/optimystic.md` snippet was stale** (it listed a `peerNetwork` field `NetworkTransactorInit` does not have and omitted the required timeouts). Rewritten around the real wiring including `localPeerId`.
- Removed an unused `ActionRev` type import in `mesh-harness.ts` (pre-existing).

# Migrated specs

`mesh-sanity.spec.ts` Suite 1 (3 nodes, width 1): every write goes through `responsibleNodes(...)[0]`; the reader in "non-responsible node discovers revision" is `nonResponsibleNodes(...)[0]` (its comment no longer needs the "not the writer" caveat); "pend + commit through different nodes independently" picks a block per node with `blockIdsInCohortOf`. Suite 3 "findCluster returns subset" (width 2) coordinates from inside the two-member cohort, which is what the case's title always claimed.

`coordinator-repo-integration.spec.ts`: the width-1 cancel, sequential, multi-block (all blocks one node owns), cross-node discovery and commit-after-cancel cases migrated the same way. The solo-mesh cancel twin's comment is rewritten (the case above it is no longer "solo only 1 run in 3"). The stale-coordinator case's comment now says ring proximity rather than XOR. Before migration 10 cases failed with `Not responsible for block(s)`, exactly as the ticket predicted; after, the two files passed 10 consecutive runs with fresh random keys.

# Use cases for testing and validation

- Transactor unit (`yarn test -- --grep "tie-break toward the local peer"` in db-core): cohort `[A, self]` → local; same without `localPeerId` → A; cohorts `[A, self]` + `[A, B]` → one batch to A carrying both blocks; self in no cohort → A; local pend throws → retried on A (the mock's `findCoordinator` always answers A).
- Parity (`test/mesh-harness-cohort-parity.spec.ts`): for 300 block ids at widths 1, 2 and 4 of 16 seeded nodes, the harness cohort equals `Libp2pKeyPeerNetwork.findCluster` over the same ring as an ordered list, the harness coordinator is its first entry, and each of the 16 nodes is in its own view exactly when production's cohort includes it (total self-inclusions = 300 × width).
- Integration, one run on 2026-09-16 (`OPTIMYSTIC_INTEGRATION=1`, six real nodes, `clusterSize` 2):

```
write summary  { blocks: 24, failures: 0, writerPickOutsideCohort: 0, pendHandledLocally: 4, driverInCohort: 4,
                 blocksRedirected: 0, totalRedirects: 0, blocksWithPhantomHolder: 0, blocksWithCohortGap: 0 }
multi-block    conv-it-multi-a   cohort H5exup,CQYPCb  pended by H5exup  holders H5exup,CQYPCb
               conv-it-multi-b-0 cohort MT4Z8D,Rrhiwj  pended by MT4Z8D  holders Rrhiwj,MT4Z8D
read summary   { readOk: 24, readMiss: 0, readThrew: 0, getsHandledRemotely: 24, getChecks: 24, getRedirects: 0,
                 blocksGrownByReads: 0, replicasAddedInsideCohort: 0, replicasAddedOutsideCohort: 0 }
```

  Two of the driver's four blocks had it second in the cohort (`Merif3,ABX151`) and were still coordinated locally, which is the tie-break at work.
- Also run: db-core `yarn test` (1700 passing); db-p2p `yarn test` (2923 passing, 63 pending, 0 failing), which includes every partition-admission spec; quereus-plugin-optimystic `yarn test` (966 passing, 13 pending); reference-peer `yarn test` (6 passing); gated `small-deployment-lifecycle.integration.spec.ts` and `two-node-convergence.integration.spec.ts` (10 passing, they use the changed `transactorFor`); root `yarn build`, `yarn lint`, `yarn typecheck`, `yarn lint:docs`.

# Gaps the reviewer should treat as a floor

- **The two-batch write is happy-path only.** No batch fails, so the partial-failure sites (`cancelAbandonedSweepBlocks`, the cancel seed round, partial-commit aggregation) are still unexercised on a real shape; that remains `debt-no-mesh-fixture-forces-two-coordinator-batches`, whose arm now says the shape itself is settled.
- **The integration equality pin compares against the servers' `NetworkManagerService.getCluster`**, not the writer's `findCluster`. The two agree while every ring member serves this network (and every other pin in that spec depends on the same agreement); the third ticket moves `checkRedirect` off `getCluster`. The spec was run once, as asked; ring geometry differs per run, so a second run exercises different cohorts.
- **Parity is proven for an all-serving, equal-reputation ring.** The harness has no notion of a non-serving member or of reputation, so neither production behaviour is modelled there; the unit specs from the first ticket cover them on the production key network only.
- **`buildNetworkTransactors`' transactors read the shared `mesh.keyNetwork`**, not the node's partition-aware view, so under `partitionSides` a transactor still sees the unpartitioned cohort. Unchanged from before; noted because the per-node view is now public as `MeshNode.keyNetwork` and a reviewer may reasonably ask whether the transactor should read it.
- **Sereus was not run.** A grep of `../sereus/packages` finds no `new NetworkTransactor` of its own; `cadre-core`'s control database loads the Quereus plugin, whose `collection-factory.ts` now passes `localPeerId`, so a sereus writer should regain local coordination on small networks with no change there. Not verified by running it.
- No new tripwires or `NOTE:`s recorded.
