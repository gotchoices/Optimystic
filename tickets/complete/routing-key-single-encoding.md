description: The client and the storage servers now turn a block's name into a network position the same way, through one shared helper whose type rejects anything else, so on networks wider than one replica group the client no longer asks the wrong machines for a block.
files:
  - packages/db-core/src/network/routing-key.ts (`RoutingKey` brand + `routingKeyForBlock`, raw utf8, synchronous)
  - packages/db-core/src/network/i-key-network.ts (`findCoordinator`, `findCluster`, `recordCoordinator` take `RoutingKey`)
  - packages/db-core/src/transactor/network-transactor.ts (every routing site)
  - packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/repo/service.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/storage/ring-shift-coordinator.ts, packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/spread-on-churn.ts
  - packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/cluster/client.ts
  - packages/db-p2p/src/reactivity/topic-bytes.ts, packages/db-p2p/src/testing/mesh-harness.ts
  - packages/db-core/test/routing-key.spec.ts (added in review)
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts, packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts
  - docs/internals.md (§Block Identity), packages/db-core/docs/network.md, packages/db-p2p/docs/repo.md, docs/reactivity.md
----

# What landed

This is Arm A of `writer-and-servers-disagree-on-where-a-block-lives`. A block's routing key is now the raw utf8 of its id, which was already the servers' convention.

`routingKeyForBlock(blockId): RoutingKey` in `packages/db-core/src/network/routing-key.ts` is the only producer of a routing key. `RoutingKey` is a branded `Uint8Array`, so `IKeyNetwork.findCluster` / `findCoordinator` / `recordCoordinator` reject bare byte arrays at compile time. The key network hashes the key exactly once into a ring coordinate.

The old async `blockIdToBytes` (`sha256(utf8(id))`, which was then hashed again inside the key network) is deleted. Every routing site in db-core and db-p2p now goes through the helper, including:
- the transactor;
- the coordinator responsibility checks;
- `RepoService.checkRedirect`;
- the restoration, ring-shift, rebalance and spread-on-churn coordinate derivations;
- the redirect-learned coordinator hints (now a shared `ProtocolClient.recordCoordinatorHint`);
- the reactivity tail bytes.

The mesh harness's mock key network now hashes the key before ranking, as production does. Nothing durable was keyed by the old double hash: the only consumers were routing calls and two in-memory time-limited coordinator caches, so no migration is needed.

Implement-stage verification: full build, all lints, and unit suites in every workspace, all green. The routing-key divergence unit spec now pins agreement at every ring width (0 divergent cohorts, 0 coordinators outside the cohort). The six-node real-libp2p integration spec pins zero read redirects and zero out-of-cohort read replicas across two runs, plus four other integration specs whose call sites changed mechanically.

# Review findings

**Read first:** the full implement diff (`git show 1e3bfd96`), covering source, tests, docs and tickets, before the handoff.

**Correctness / completeness: checked, nothing missed.**
- `blockIdToBytes` / `block-id-to-bytes` has zero remaining references outside tickets.
- Every `findCluster` / `findCoordinator` / `getCluster` / `getCoordinator` / `recordCoordinator` call in every package's `src/` is handed `routingKeyForBlock(...)` or a `RoutingKey` parameter.
- Every `hashKey(` call in `src/` falls into one of three groups:
  - block ids via the helper;
  - key-network internals;
  - FRET warm-up seed keys (`NetworkManagerService.seedKey`, correctly left `Uint8Array`).

  `substrate-simulator`'s `RingModel.coordOf` hashes synthetic peer keys, not block ids. `routing/simple-cluster-coordinator.ts` has no importers.
- `libp2p-node-base`'s `sampleArbitrators` input still encodes the id itself. As the handoff says, it seeds arbitrator sampling, not a cohort lookup, so leaving it is correct.
- `Libp2pKeyPeerNetwork.findCoordinator`'s cache read/write and FRET tier all key on the same `RoutingKey`, so a redirect-learned hint is found by the next lookup.

**Type safety: gap closed in review.** The brand was the invariant the change relied on, but nothing pinned it; a future widening back to `Uint8Array` would have passed every test. Added `packages/db-core/test/routing-key.spec.ts`:
- It pins raw utf8, including a non-ASCII id.
- It has two `@ts-expect-error` calls (hand-encoded bytes into `findCluster`, a 32-byte digest into `findCoordinator`).

db-core's `tsconfig.json` includes `test/`, so `yarn build` / `typecheck` fail if either line ever type-checks. `tsc` passed with them, which confirms both lines really do error today.

**Tests: one pre-existing hollow test fixed in review (handoff gap 6).** `network-transactor.spec.ts` "should handle node failures by falling back to other nodes" never awaited `findCluster`, so its body never ran, and a catch-all accepted either outcome. It now:
- awaits the cluster;
- takes the node down by peer id;
- asserts the pend succeeds by falling back past it;
- restores the node in `finally`.

It passes.

Other test changes checked:
- The integration spec's reads-side split (inside vs outside cohort) is sound.
- The coordinator-hint specs still distinguish the commit anchor (`blockIds[0]`) from `tailId`, and pend's real block id from the `inserts` field name.

**DRY / modularity: considered, no change.**
- Four db-p2p sites compute `hashKey(routingKeyForBlock(id))`. A `ringCoordForBlock` helper can't live in db-core, because `no-fret-import.spec.ts` keeps FRET out of it, and four one-liners in db-p2p don't justify a new module.
- `RepoClient.coordinatedBlockId` and `ClusterClient.recordCoordinatorForRecordIfSupported` extract the anchor block from different message shapes (repo ops vs cluster records), so they are not duplicates.

**Performance / resource cleanup: improved, nothing to act on.**
- Every routing call drops one async sha256 and one await.
- The mesh harness now hashes per lookup, but that is test-only.
- No new state, listeners or caches.

**Error handling: checked, unchanged.** The redirect hint is now synchronous. `recordCoordinator` throwing would propagate exactly as the old awaited call did. The transactor's hint write-back keeps its try/catch.

**Tripwire parked.** `NetworkManagerService.getCluster`'s fallback for a node with no FRET ranks the raw key against peer multihashes, a placement no FRET node shares. It was already raw before this change, and it is unreachable while FRET is always registered. Parked as a `NOTE:` at that fallback in `packages/db-p2p/src/network/network-manager-service.ts`.

**Docs: checked.**
- `docs/internals.md` §Block Identity, `packages/db-core/docs/network.md`, `packages/db-p2p/docs/repo.md` and `docs/reactivity.md` all reflect the single encoding.
- `docs/transactions.md` line 1384 is pseudocode for a different API (`transactor.getCluster(blockId)`), so it is unaffected.
- `docs/review.html` is a historical report whose `hashKey(blockIdBytes)` wording is still accurate.
- `yarn lint:docs` resolves every citation.

**Source hygiene: fine.** `routing-key.ts` is 27 lines, and its doc comment says why the brand exists and why the helper must not hash. The removed async `extractKeyFromOperations` / `recordCoordinatorForOpsIfSupported` pair and its `any` casts are a net simplification.

**Handed-off gaps: dispositions.**
- Gap 1 (sereus no longer type-checks: three bare-`Uint8Array` sites in its integration-test harness): the code is outside this repository, so it is filed as `blocked/sereus-harness-passes-bare-bytes-as-routing-key` with the exact same-bytes fix.
- Gap 2 (`findCoordinator` can pick a peer just outside `findCluster`'s cohort): confirmed recorded as an arm of `plan/self-in-cohort-only-when-nearest`. It is not an encoding issue, so it gets no new ticket.
- Gap 3 (the writer's node self-coordinates pends it isn't responsible for): owned by `self-in-cohort-only-when-nearest`, and the integration spec pins the still-wrong behaviour for that ticket to flip.
- Gap 4 (the first mesh assertion in the unit divergence spec is near-tautological): accepted as a cheap guard. The load-bearing pins are the independent raw-`TextEncoder` coordinate check, the ring sweep, and the placement assertions.
- Gap 5 (arbitrator sampling and FRET seed keys left untouched): verified correct, see above.
- Gap 6: fixed, see Tests.

**Validation run in review:**
- `yarn build`: clean.
- `yarn lint`, `yarn lint:docs`, `yarn lint:deps`: clean.
- `yarn workspace @optimystic/db-core typecheck`: clean.
- db-core unit tests: 1642 passing (1640 plus the 2 new specs).
- db-p2p unit tests: 2734 passing, 62 pending.
- No failures, so no pre-existing-error report.
- Not re-run in review: the real-libp2p integration specs (review changed no source they exercise, only a comment) and the other workspaces' suites (untouched by review edits).
