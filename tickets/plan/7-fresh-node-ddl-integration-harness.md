description: Build an end-to-end cold-start DDL/DML integration harness that composes StorageRepo + CoordinatorRepo + NetworkTransactor + Collection/Tree/Log + quereus-plugin-optimystic against a real (or realistically-stubbed) node. Catch the next layer of bugs the sereus-health mobile canary has been finding before they ship.
dependencies:
  - tickets/complete/4-solo-node-schema-ddl-deadlock.md (mesh-sanity Suite 0 is the seed)
  - tickets/complete/5-get-block-throws-on-pending-only-metadata.md
  - tickets/fix/5-chain-add-on-fresh-collection-throws-non-existent-chain.md (the bug this harness would have caught)
files:
  - packages/db-p2p/test/mesh-harness.ts (seed — extend, don't fork)
  - packages/db-p2p/test/mesh-sanity.spec.ts (Suite 0 — extend to Collection/Tree layer)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (lines 185-208 — the `createTestTransactor()` shortcut that's hiding bugs)
  - packages/quereus-plugin-optimystic/test/schema-support.spec.ts (currently uses `default_transactor: 'test'` which bypasses the production path)
  - packages/db-core/src/collection/collection.ts (createOrOpen / syncInternal — target of the harness)
  - packages/db-core/src/log/log.ts + chain.ts (Log.open / Chain.open — target of the harness)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (storeSchema — real first-DDL entry point)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (doInitialize — real table-creation entry point)
  - new: packages/db-p2p/test/fresh-node-ddl.spec.ts OR a new `packages/integration-tests/` workspace (decide during plan)
----

## Why

All three recently-completed/pending tickets (ticket solo-node deadlock, ticket get-block-throws, ticket chain-add-on-fresh-collection) were found by the sereus-health mobile canary running first-launch DDL, not by this repo's CI. Each fix added a narrow regression test after the fact. The next latent bug beneath ticket 5-chain is almost certainly already there.

The root cause of the gap, in concrete terms:

1. **`quereus-plugin-optimystic`'s test transactor is a StorageRepo pass-through.**
   `createTestTransactor()` (collection-factory.ts:185-208) wraps a raw `MemoryRawStorage → BlockStorage → StorageRepo` and drops it into an `ITransactor` shim. The production path — `NetworkTransactor → batch-coordinator → CoordinatorRepo → savePendingTransaction → StorageRepo` — is entirely skipped. Every `schema-support.spec.ts` / `engine-execution.spec.ts` test uses this shortcut. So the code path that *produces* pending-only metadata (the trigger for ticket 5-get) and the code path that *consumes* it (the trigger for ticket 5-chain once 5-get was fixed) have no joint coverage.

2. **`db-p2p`'s mesh-harness mocks the network.**
   `MockPeerNetwork` + `MockMeshKeyNetwork` in `mesh-harness.ts` bypass libp2p. `mesh-sanity.spec.ts` Suite 0 is the closest we have to a solo-node integration test, and it only drives raw `coordinatorRepo.pend / commit / get` with synthetic `Transforms`. Nothing drives the `Collection / Tree / Log / Chain` stack on top of it.

3. **No test exercises cold-start `Collection.createOrOpen` + `syncInternal` against a real `IRepo`.**
   The `collection.spec.ts` / `tree.spec.ts` / `log.spec.ts` unit tests in `db-core` use `test-transactor.ts` / `test-block-store.ts` in-memory fakes. These may or may not reproduce the exact `Tracker` / `Transforms` shape that `StorageRepo` returns on pending-only metadata. Ticket 5-chain's hypothesis is a `copyTransforms` fidelity issue — exactly the kind of layer-contract drift that only an integration test catches.

4. **"Fresh / first-run" state is a one-shot path.**
   Once a Collection has been written once, subsequent tests see a non-empty tracker. The "empty tracker, no header, no tailId" path fires exactly once per node lifetime and is trivially missed by fixture-seeded tests.

## What to build

A harness that exercises the **real** production stack end-to-end on a solo (and later multi-node) cold-start scenario. Non-negotiable: it must go through `NetworkTransactor` + `CoordinatorRepo`, not a StorageRepo shim.

### Scope — Phase 1 (solo-node, in-process)

A single spec file (working title `packages/db-p2p/test/fresh-node-ddl.spec.ts`) that composes:

```
MemoryRawStorage
  → BlockStorage
  → StorageRepo
  → ClusterMember + CoordinatorRepo  (same construction path as mesh-harness)
  → NetworkTransactor               (real, over the mock key network but with 1 node)
  → Collection / Tree / Log / Chain (real, from db-core)
  → SchemaManager + OptimysticVirtualTable  (real, from quereus-plugin-optimystic)
  → Quereus Database               (real)
```

The mesh-harness's `MockMeshKeyNetwork` + `responsibilityK: 1` already gives a working 1-node "network" — the harness just needs to plug `NetworkTransactor` on top of it and then expose an `ITransactor` that the Quereus plugin can consume.

Tests in this file drive, in order, on a freshly-constructed mesh:

- `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) USING optimystic('tree://test/t')` — the exact path sereus-health hit.
- `INSERT INTO t VALUES (1, 'a')` on the fresh table (first DML after first DDL).
- `SELECT * FROM t` — verify round-trip.
- `CREATE TABLE t2 (...)` after `t` — exercise the "second DDL" code path (schema-block is no longer a pending-only insert; it has a committed revision).
- Cold-restart: tear down everything except `MemoryRawStorage`, reconstruct the full stack over the same storage, and run `SELECT * FROM t` again. Catches bugs in the "open existing Collection" path that fresh-only tests miss.
- `SELECT * FROM sys_empty_table_that_doesnt_exist` / read-before-first-write — verify empty-state contract at the plugin layer.

Every test asserts **no hang** via an explicit per-test timeout (e.g. 5s). Ticket 4's original symptom was a hang that went unnoticed because mocks turned it into a silent no-op; explicit timeouts are the antidote.

### Scope — Phase 2 (plug the plugin-test shortcut)

`quereus-plugin-optimystic`'s `default_transactor: 'test'` should have a sibling `'mesh-test'` (or the `'test'` mode should be rebuilt) that uses the same harness — real `NetworkTransactor` over a 1-node mock mesh. Migrate `schema-support.spec.ts`, `engine-execution.spec.ts`, `schema-migration.spec.ts`, and `distributed-quereus.spec.ts` to use it. The pure-StorageRepo shortcut stays available only for tests that *explicitly* target `StorageRepo`-only behavior.

### Scope — Phase 3 (multi-node cold-start)

Extend the harness to 3-node and 5-node cold-start scenarios. First DDL on node A, read from node B. Covers the restoration-coordinator + cluster-consensus paths on first-write-ever, which mesh-sanity Suites 1/2 exercise only with synthetic transforms.

### Scope — Phase 4 (explicit empty-state contract tests)

A new `packages/db-p2p/test/empty-state-contract.spec.ts` that, for every layer pair (`BlockStorage ↔ StorageRepo`, `StorageRepo ↔ CoordinatorRepo`, `CoordinatorRepo ↔ NetworkTransactor`, `NetworkTransactor ↔ Collection`), asserts the round-trip of "this block does not exist" and "this block has pending-only metadata". Prevents future contract-drift bugs of the ticket 5-get flavor.

## Deliberate non-goals

- Real libp2p transport in Phase 1. Real libp2p is the next ticket (separate gap) and would turn these tests into slow, flaky CI. The mesh-harness's mock key network is sufficient to exercise every `db-core` / `db-p2p` / `quereus-plugin-optimystic` code path that the canary is currently finding bugs in.
- Replacing the pure-unit tests. Keep them; they're fast and debugging aids. Add integration coverage on top, don't delete what's there.
- Performance/scale. This harness is for correctness on cold-start paths, not throughput.

## Expected outcomes

- The pending ticket 5-chain (chain-add-on-fresh-collection) reproduces deterministically in Phase 1 without needing a mobile device.
- At least one additional latent bug surfaces in Phase 1 or Phase 2 (high confidence, given the pattern).
- Future bugs matching this profile are caught in optimystic CI, not by sereus-health's first-launch.

## TODO

Phase 1 — solo-node Collection/Tree/quereus cold-start harness
- [ ] Extend `mesh-harness.ts` to optionally construct a `NetworkTransactor` on top of the existing `CoordinatorRepo`, returning an `ITransactor` the plugin can consume.
- [ ] Write `packages/db-p2p/test/fresh-node-ddl.spec.ts` with the test cases listed under Phase 1 scope.
- [ ] Verify it reproduces ticket 5-chain on `main` *before* the chain-add fix lands; use that as the forcing function to make sure the harness is real.
- [ ] Add a per-test timeout so hangs fail loud.

Phase 2 — plug the plugin-test shortcut
- [ ] Add `'mesh-test'` (or rebuild `'test'`) transactor factory in `collection-factory.ts` that uses the Phase 1 harness.
- [ ] Migrate `schema-support.spec.ts`, `engine-execution.spec.ts`, `schema-migration.spec.ts`, `distributed-quereus.spec.ts` to it.
- [ ] Confirm the migrated suites still pass; if any now fail, file fix tickets per failure.

Phase 3 — multi-node cold-start
- [ ] 3-node cold-start DDL-on-A / SELECT-on-B spec.
- [ ] 5-node cold-start with one peer down at boot.

Phase 4 — empty-state contract tests
- [ ] `empty-state-contract.spec.ts` covering the four layer pairs.

Phase 5 — CI / canary
- [ ] Decide whether a smoke-test subset of the sereus-health mobile first-launch flow should run in optimystic's CI (likely: a minimal JS harness that mimics `CadreService.doStart`). File a separate ticket.
