description: The client and the storage servers now turn a block's name into a network position the same way, through one shared helper whose type rejects anything else, so on networks wider than one replica group the client no longer asks the wrong machines for a block. Review the change, its test pins, and the one sibling-repository type break it causes.
files:
  - packages/db-core/src/network/routing-key.ts (new: `RoutingKey` brand + `routingKeyForBlock`, raw utf8, synchronous)
  - packages/db-core/src/utility/block-id-to-bytes.ts (deleted; was `sha256(utf8(id))`)
  - packages/db-core/src/network/i-key-network.ts (`findCoordinator`, `findCluster`, `recordCoordinator` take `RoutingKey`)
  - packages/db-core/src/transactor/network-transactor.ts (every routing site)
  - packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/repo/service.ts (retyped key parameters; `checkRedirect` uses the helper)
  - packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts (server-side cohort lookups)
  - packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/storage/ring-shift-coordinator.ts, packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/spread-on-churn.ts (hash a block id into a ring coordinate themselves; now via the helper, bytes unchanged)
  - packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/cluster/client.ts (redirect coordinator hints)
  - packages/db-p2p/src/reactivity/topic-bytes.ts (`reactivityTailBytes` delegates to the helper; bytes unchanged)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MockMeshKeyNetwork` takes `RoutingKey` and hashes it once before ranking)
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts, packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (flipped to pin agreement)
  - packages/db-p2p/test/coordinator-cache-hint.spec.ts, packages/db-p2p/test/reactivity/topic-bytes-encoding.spec.ts, packages/db-p2p/test/redirect.spec.ts (assertions rewritten for one encoding)
  - docs/internals.md (§Block Identity), packages/db-core/docs/network.md, packages/db-p2p/docs/repo.md, docs/reactivity.md
----

# What landed

Arm A of `blocked/writer-and-servers-disagree-on-where-a-block-lives`: a block's routing key is the raw utf8 of its id, the servers' convention.

- **One helper, one type.** `routingKeyForBlock(blockId): RoutingKey` in `packages/db-core/src/network/routing-key.ts`. `RoutingKey` is `Uint8Array` with a phantom brand, so a bare byte array no longer type-checks as an argument to `IKeyNetwork.findCoordinator`, `findCluster` or `recordCoordinator`. The old async `blockIdToBytes` is deleted, and every `await` on it is gone. The key network hashes the key once (`hashKey`); nothing else on the path hashes.
- **Retyped implementers:** `Libp2pKeyPeerNetwork`, `NetworkManagerService` (`getCluster`, `getCoordinator`, `recordCoordinator`), `RepoService`'s `NetworkManagerLike`, and the mesh harness's `MockMeshKeyNetwork`. Test doubles declaring `key: Uint8Array` were left alone: a wider parameter is still a valid implementation, and only callers are constrained.
- **Every routing site goes through the helper.** That covers `NetworkTransactor` (reads, pend consolidation and fallback, the coordinator hint write-back, commit resolution, cancel, `queryClusterNominees`) and `CoordinatorRepo`'s `isResponsibleForBlock` and `fetchBlockFromCluster`. It also covers `ClusterCoordinator.getClusterForBlock`, `RepoService.checkRedirect`, and `deriveExpectedCluster` in both `libp2p-node-base` and the mesh harness. Four more sites hash a block id into a ring coordinate without the key network: restoration, ring-shift, rebalance, spread-on-churn. They were already raw utf8 and now use the helper, so the bytes are provably the same.
- **Coordinator hints.** The caches live in `Libp2pKeyPeerNetwork` and `NetworkManagerService`, keyed by base64url of the key bytes, and are in-memory `Map`s only (neither is persisted). `RepoClient` and `ClusterClient` now call a shared `ProtocolClient.recordCoordinatorHint(blockId, peer)` that keys on `routingKeyForBlock`, so a redirect-learned hint is found by the next `findCoordinator`. The `any` cast and the async digest are gone.
- **Mesh harness.** `MockMeshKeyNetwork` now hashes the routing key before XOR ranking, as production does. It used to rank raw key bytes, right-aligned against 38-byte peer multihashes. That was sensible for the transactor's 32-byte digest, but a short raw utf8 key was ranked almost entirely by the peer ids' own bytes. Transactor-driven placement in existing harness specs is unchanged, since hashing utf8 inside yields what the transactor used to pass in. Server-side harness placement moved to match it. The full db-p2p suite passed unchanged apart from the specs listed in `files:`.
- **Reactivity.** `reactivityTailBytes(tail)` returns `routingKeyForBlock(tail)`. The bytes are unchanged and pinned by `topic-bytes-encoding.spec.ts`, which also now pins that a sha256 digest of the tail resolves a different coordinate.

**Migration:** nothing durable was keyed by the double hash. The only consumers of the old helper's output were routing calls, the two in-memory TTL coordinator caches, and tests.

# How it was verified

- `yarn build` (all workspaces), `yarn lint`, `yarn lint:docs`, `yarn lint:deps`, and `quereus-plugin-optimystic` typecheck: all clean.
- **Unit tests:**
  - db-core: 1640 passing.
  - db-p2p: 2734 passing, 62 pending.
  - quereus-plugin-optimystic: 800 passing, 13 pending.
  - db-p2p-storage fs / ns / rn / web: 76 / 58 / 53 / 52.
  - quereus-plugin-crypto: 125.
  - substrate-simulator: 258.
  - reference-peer: 6.
  - demo: 12.
  - `test:harness`: clean.
  - No failures anywhere, so no pre-existing-error report.
- **`routing-key-convention-divergence.spec.ts` (unit, now pins agreement):**
  - The writer's coordinate equals an independently computed `sha256(utf8(id))` for every id.
  - FRET ring-width sweep (n = 1, 2, 3, 4, 5, 6, 8, 12, 16, 32; cohort 4; 200 ids): 0 divergent cohorts and 0 coordinator-outside-cohort at every width.
  - 16-node mesh harness: coordinator outside cohort 0/200.
  - Direct pend+commit: the coordinator is in the cohort and the holders are exactly the 4 cohort members.
  - Diary: every committed block sits on exactly its cohort.
- **`routing-key-convention-divergence.integration.spec.ts`** (`OPTIMYSTIC_INTEGRATION=1`, six real nodes, `clusterSize` 2). Two runs; the ring is random each run.

  | Summary | Field | Run 1 | Run 2 |
  |---|---|---|---|
  | write | failures | 0 | 0 |
  | write | pends coordinated locally | 24 | 24 |
  | write | driver in cohort | 10 | 5 |
  | write | redirects | 0 | 0 |
  | write | blocks with phantom holder | 14 | 19 |
  | write | blocks with cohort gap | 14 | 19 |
  | write | writer pick outside cohort | **1** | 0 |
  | read | reads OK | 24 | 24 |
  | read | gets handled remotely | 17 | 21 |
  | read | redirect checks | 17 | 21 |
  | read | **get redirects** | **0** | **0** |
  | read | blocks grown by reads | 0 | 0 |
  | read | replicas added inside / outside cohort | 0 / 0 | 0 / 0 |

  Run 1 failed on a `writerPickOutsideCohort === 0` pin I had added; the pin was then removed (see gap 2), and run 2 passed.
- **Other integration specs** whose key call sites changed mechanically (same bytes): multi-coordinator-write, multi-coordinator-write-relay, multi-coordinator-cross-network-write, two-node-convergence and real-libp2p gave 16 passing; quereus two-node-secondary-index-libp2p gave 2 passing. The rest of `yarn test:integration` was **not** run.

Reproduce:

```
yarn workspace @optimystic/db-p2p test -- --grep "routing-key convention"
cd packages/db-p2p && OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js test/routing-key-convention-divergence.integration.spec.ts --reporter spec --exit
```

# Known gaps — start here

1. **Sereus no longer type-checks against this checkout.** It symlinks `@optimystic/db-core` and `db-p2p` to this repository. `tsc -p tsconfig.typecheck.json` in `../sereus/packages/integration-tests` now reports exactly 3 errors, all this change:
   - `src/harness/control-cohort.ts` line 139: `CONTROL_COHORT_PROBE_KEY: Uint8Array` is passed to `findCluster`.
   - `src/harness/control-cohort.ts` line 277 and `src/harness/forced-cluster.ts` line 244: patch wrappers declare `key: Uint8Array` and forward it via `inner.call(this, key)`.

   The same-bytes fix belongs in sereus:
   - Define `CONTROL_COHORT_PROBE_KEY = routingKeyForBlock('sereus-control-cohort-probe')`.
   - Type both wrapper parameters as `RoutingKey`.

   Runtime behaviour is unaffected. The ticket's "no sereus change should be needed" held for behaviour but not for types. Sereus was not edited, since it is outside this repository, and `strand-membership-closed-strand-e2e` was not run. A human needs to land the three-line fix in sereus, or decide the brand should not reach its harness.
2. **`findCoordinator` can pick a peer just outside the cohort `findCluster` reports.** This is not an encoding issue:
   - `findCoordinator` ranks FRET `getNeighbors`, which lists successors first; cohorts come from `assembleCohort`, which alternates successor and predecessor.
   - When self is the nearest successor and is not picked on a write, the pick is the second successor.

   It was seen for 1 of 24 blocks in run 1. The cost today is at most one redirect, on write paths that consult `findCoordinator`. I recorded it as an arm of `plan/self-in-cohort-only-when-nearest` (item 3 already owns that method). The integration spec reports `writerPickOutsideCohort` but does not pin it.
3. **Arm B is still open, as designed.** The writer's node coordinates every pend itself. Whenever it is not responsible, it keeps a copy nobody looks for, and one responsible peer never gets the block: 14/24 and 19/24 in the two runs. The integration spec pins this as still-wrong, and `self-in-cohort-only-when-nearest` must flip those pins.
4. **The first mesh assertion in the unit divergence spec is now close to tautological.** Both sides go through the same mock with the same key. I kept it as a cheap guard; the load-bearing pins are the independent-coordinate check, the ring sweep, and the placement assertions.
5. **Deliberately untouched encoders.** `libp2p-node-base`'s `sampleArbitrators` input still encodes the block id itself: it seeds dispersed arbitrator sampling (`hash(blockId ‖ round ‖ epoch ‖ i)`) and is not a cohort routing key. `NetworkManagerService`'s `seedKeys` stay `Uint8Array`, since they are FRET warm-up keys, not block keys.
6. **Noticed, not touched (pre-existing, unrelated).** In `packages/db-core/test/network-transactor.spec.ts`, "should handle node failures by falling back to other nodes" never awaits `network.findCluster(key)`, so its `if` body never runs and the test asserts nothing about fallback. Awaiting it would also need the body to find the `NetworkNode` by peer id, because the map values are `ClusterPeers` entries, not nodes. Worth a reviewer's call on whether it earns a ticket.
