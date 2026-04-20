description: "First write on a freshly-created Tree throws `Cannot add to non-existent chain` (chain.ts:102). Bug does NOT reproduce with TestTransactor or local StorageRepo — reproduction requires the NetworkTransactor/CoordinatorRepo path, so it is most likely in that layer rather than in core copyTransforms."
dependencies: prior ticket 5-get-block-throws-on-pending-only-metadata (complete) unmasked this
files:
  - packages/db-core/src/chain/chain.ts (getTail line 303; add throw at line 102; open line 76)
  - packages/db-core/src/log/log.ts (addActions line 45-47)
  - packages/db-core/src/collection/collection.ts (createOrOpen line 41-63; syncInternal line 149-190)
  - packages/db-core/src/transform/tracker.ts (Tracker.insert/update/tryGet)
  - packages/db-core/src/transform/helpers.ts (copyTransforms line 61-67)
  - packages/db-core/src/collections/tree/tree.ts (createOrOpen line 15-52)
  - packages/db-p2p/src/repo/coordinator-repo.ts (get line 151-185; pend line 239-282 — **also has a separate bug at lines 240 and 276: `Object.keys(request.transforms)` returns `['inserts','updates','deletes']` instead of block ids; use `blockIdsForTransforms(request.transforms)`**)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (storeSchema line 73-79)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (createOrGetCollection line 27-63 — note: no cache across calls outside a transaction, so getSchema+storeSchema create two independent Tree instances for the same collection id)
  - packages/db-p2p/test/mesh-harness.ts (for constructing a reproducing libp2p test)
----

## What is NOT the cause (verified during research)

- **TestTransactor**: `npm test --grep Tree` — 44 passing. First-write on a fresh tree works.
- **Local StorageRepo** (`createLocalTransactor` path from `collection-factory.ts:158`): wrote a throwaway spec that creates a tree with local StorageRepo and does a first replace — passes. So the `{state: {}}` contract from the prior-ticket fix is correct, and the core copyTransforms / Chain.open / chain.add path is not broken on a single-process store.
- **copyTransforms losing the apply ops** (ticket's hypothesis #1): traced through the code. `Tracker.insert` stores a `structuredClone(block)`. `Tracker.update` for an already-inserted block applies the op **in place on that stored clone** (tracker.ts:48-54). `apply(store, block, op)` (blocks/helpers.ts:10-13) calls `store.update(...)`, which for the snapshot's shared insert reference is a no-op against the snapshot (since the in-place mutation already happened on the main tracker's stored object, which the snapshot shallow-copies). So after Chain.open's `apply(..., headId$, ...)` and `apply(..., tailId$, ...)`, the stored insert has both fields, and a `copyTransforms` shallow copy carries both fields because it's the same object reference.
  - Worth asserting with a focused unit test before discarding entirely — see phase 1 — but the code path reads consistent.
- **Tail block insert dropped** (hypothesis #2): `Chain.open` calls `store.insert(tailBlock)` directly on the tracker, not inside an Atomic wrapper. The insert persists.
- **Tree-vs-Chain header double-duty** (hypothesis #3): Tree's `createHeaderBlock` returns `{header, rootId}` and Chain.open adds `headId`/`tailId` via `apply()`. All three fields coexist on the same inserted block; no mismatch.

## What IS likely the cause

The bug only reproduces against the real `NetworkTransactor` + `CoordinatorRepo` on a solo node. Two plausible mechanisms:

1. **CoordinatorRepo.get returns an unexpected shape or side effect for a brand-new collection header**. `CoordinatorRepo.get` (coordinator-repo.ts:151-185) calls `storageRepo.get` first (returns `{state:{}}` for a fresh collection — good), then if `!localEntry?.state?.latest` it calls `fetchBlockFromCluster` which may call back through `clusterLatestCallback` and `storageRepo.get` with a synthetic `context: {committed: [clusterLatest], rev}`. On a solo node with no peers, `queryClusterForLatest` returns undefined and the second `storageRepo.get` is skipped. But verify this in the failing environment — if `SyncClient.requestBlock` or `findCluster` returns stale/partial metadata from a prior incomplete session (the app is a mobile app, cold-start with whatever was on disk), `storageRepo.get` could be invoked with a `context.committed` for an action that isn't actually committed here, triggering a spurious read that shapes subsequent calls.
2. **CoordinatorRepo.pend blockId bug (coordinator-repo.ts:240, 276)** passes `['inserts','updates','deletes']` to `verifyResponsibility` and `getClusterSize`. For a solo node the `peerCount <= 1` shortcut at line 245 skips cluster coordination, so this doesn't affect the chain-add throw directly, but it is a latent bug that should be fixed in the same pass.
   - Use `blockIdsForTransforms(request.transforms)` instead.

Note that the chain.add throw occurs **before** any pend is called (syncInternal: `Log.open` → `log.addActions` → `chain.add` throws; `transact` is never reached). So the trigger must be in the **read path** during syncInternal — most likely in `sourceCache.tryGet → transactorSource.tryGet → transactor.get`.

A promising lead: `TransactorSource.tryGet` (transactor-source.ts:28-38) does `return block as TBlock` after destructuring. If `this.transactor.get(...)` returns a non-null result **without** the requested key (e.g., NetworkTransactor retry logic under second-chance retry returning a partial/merged object that doesn't contain the block id for this request), then `result[id]!` throws TypeError. But we get the "non-existent chain" error, not a TypeError, so that's probably not it either.

The most suspicious code path is NetworkTransactor's second-chance retry for "not found" responses (network-transactor.ts:63-80) — when the local repo returns `{state:{}}` for the fresh header (not-found-ish), the transactor may retry other coordinators and merge results, potentially producing a response that lacks the block id entry or has a shape `TransactorSource.tryGet` mishandles.

## TODO

Phase 1 — quick hypothesis checks (confirm my reasoning before moving on):

- Add a focused unit test in `packages/db-core/test/transform.spec.ts` (or tracker-specific spec): insert a block with fields {a, b}, apply two updates setting {c} and {d}, insert a second block, `copyTransforms`, then via a new Tracker on the copy + the same source assert:
  - `tryGet(block1.id)` returns a block with a, b, c, d (confirms apply-over-insert survives copy).
  - `tryGet(block2.id)` returns the second block.
  - `transformedBlockIds()` includes both ids (no updates entry for block1 because update went into the insert).
- Add a unit test in `packages/db-p2p/test/` that mirrors the failing flow with `createLocalTransactor`-style StorageRepo: `Tree.createOrOpen` → `tree.replace([[k, v]])` → `tree.get(k)`. Expect no throw. (Already verified manually during research; codify it.)

Phase 2 — reproduce against the real path:

- Use `packages/db-p2p/test/mesh-harness.ts` to spin up a 1-node mesh. Construct a NetworkTransactor + CoordinatorRepo and perform the same `Tree.createOrOpen + tree.replace` flow. Expect `Cannot add to non-existent chain` to reproduce there. If it does, that confirms the bug is in `CoordinatorRepo.get` or `NetworkTransactor.get`'s second-chance retry.
- If it does NOT reproduce in mesh-harness with clusterSize 1, stand up a clusterSize 1 libp2p node via `createLibp2pNode` (same path as `collection-factory.ts:createNetworkTransactor`) and run the same scenario. The clusterSize 1 + arachnode ring-zulu configuration is what sereus-health uses.

Phase 3 — root cause and fix:

- Instrument `TransactorSource.tryGet`, `CacheSource.tryGet`, `Tracker.tryGet`, and `Chain.getTail` with logs showing block id and whether each layer returned a block or undefined. Run the repro. Identify which layer returns undefined for the tail block id after `chain.add` starts.
- Fix at the identified layer:
  - If it's NetworkTransactor's second-chance retry shape: normalize the return so missing keys get `{state:{}}` entries.
  - If it's CoordinatorRepo.get: ensure the "fetch from cluster" branch doesn't mutate `localResult` in a way that replaces a legitimate `{state:{}}` with `undefined`.
  - If it's elsewhere: address at source.

Phase 4 — ancillary cleanup (same PR if small):

- `packages/db-p2p/src/repo/coordinator-repo.ts:240` and `:276`: replace `Object.keys(request.transforms)` with `blockIdsForTransforms(request.transforms)`. Import from `@optimystic/db-core`. Add a regression test at the `CoordinatorRepo.pend` level with a multi-block insert to confirm the responsibility check sees real block ids.

Phase 5 — validation:

- All `packages/db-core` tests pass (including the new Phase 1 tests).
- All `packages/db-p2p` tests pass (including the new Phase 2 test).
- Manual repro in sereus-health mobile: fresh install, first `CREATE TABLE` completes without `Cannot add to non-existent chain`.

## Reproduction (sereus-health)

- App: `C:/projects/sereus-health/apps/mobile`
- Clear app data, launch with `USE_QUEREUS=true` / `USE_OPTIMYSTIC=true`, no bootstrap nodes.
- First `create table App.types (...)` triggers the error at `CadreService.ts:117`.

## Out of scope

- Prior tickets 4-solo-node-schema-ddl-deadlock and 5-get-block-throws-on-pending-only-metadata are complete (v0.11.1 / v0.11.2). This is the next-layer error they unmasked.
- Broad refactor of NetworkTransactor batching — scope is limited to the get-path shape bug that triggers chain.add failure.
