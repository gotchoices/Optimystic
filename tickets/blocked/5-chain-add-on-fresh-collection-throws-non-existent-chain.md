description: "First write on a freshly-created Tree throws `Cannot add to non-existent chain` (chain.ts:102) in sereus-health mobile, but **cannot be reproduced** in this repo's test suite — including against a real libp2p node with clusterSize=1 + arachnode + enableRingZulu, matching the sereus-health production wiring. Blocked pending a deterministic repro from the failing environment."
dependencies: prior ticket `5-get-block-throws-on-pending-only-metadata` (complete) unmasked this; Phase 4 split into `5-coordinator-repo-pend-blockid-extraction` (review).
files:
  - packages/db-core/src/chain/chain.ts (throw site: line 102)
  - packages/db-core/src/collection/collection.ts (syncInternal: 149-190)
  - packages/db-core/src/transform/tracker.ts (apply-over-insert)
  - packages/db-core/src/transform/helpers.ts (copyTransforms)
  - packages/db-p2p/src/repo/coordinator-repo.ts (get path + fetchBlockFromCluster)
  - packages/db-p2p/src/libp2p-node-base.ts (clusterLatestCallback wiring)
  - packages/db-core/test/transform.spec.ts (new regression: "apply-over-insert survives copyTransforms")
  - packages/db-p2p/test/fresh-node-ddl.spec.ts (3 tests, solo mesh — all pass on main)
  - packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts (real libp2p solo node — passes on main)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (reproduction entry point)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (real wiring)
----

## What was done this pass

1. **Phase 4 fix split out** — `CoordinatorRepo.pend` was calling `Object.keys(request.transforms)` (returning the literal `['inserts','updates','deletes']`) instead of the actual affected block ids. Fixed in `coordinator-repo.ts` to use `blockIdsForTransforms`, with a new regression test at `coordinator-repo-proximity.spec.ts`. See `tickets/review/5-coordinator-repo-pend-blockid-extraction.md`. This does not appear to fix the chain.add throw — on clusterSize=1 the buggy `allBlockIds` never flowed through `verifyResponsibility` (peerCount<=1 fast path) — but it is a real latent bug found during this investigation.

2. **Phase 1 regression tests added** (`packages/db-core/test/transform.spec.ts` → `apply-over-insert survives copyTransforms`). Models Collection.syncInternal's snapshot path:
   - Insert header block.
   - Apply `headId`, `tailId` ops via `apply()` (which mutates the stored insert in place via Tracker.update's "already inserted" branch).
   - Insert tail block.
   - `copyTransforms` → open a fresh Tracker on the snapshot.
   - Assert header has `headId`/`tailId`/`rootId` and tail is retrievable.
   - Passes on main — confirms this code path is not the bug. Kept as regression.

3. **Two end-to-end forcing-function integration tests** (kept for regression protection and as a "this is known-good on solo nodes" baseline):
   - `packages/db-p2p/test/fresh-node-ddl.spec.ts` — solo mesh with full production stack (StorageRepo → CoordinatorRepo → NetworkTransactor). 3 scenarios (single replace, schema-manager read-then-write, two sequential DDLs).
   - `packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts` — real `createLibp2pNode({ clusterSize: 1, arachnode: { enableRingZulu: true } })` with the identical wiring the quereus plugin uses in production. Solo, no bootstrap, fresh memory storage.
   - **All pass on main.** The chain.add throw does not reproduce here.

4. **Type safety / build** — fixed the cross-package `PeerId` type incompatibility in the new specs (tsc was failing on the main branch; now builds clean).

## What was ruled out during research

Traced by reading the code end-to-end and verified with focused tests:

- **copyTransforms losing apply ops** — Tracker.update mutates the stored insert in place, so the two apply() calls in Chain.open that set `headId`/`tailId` persist on the inserted header. `copyTransforms` does a shallow copy of inserts but shares the block references, so the snapshot sees both fields. Verified by the new Phase 1 test.
- **Tail block insert dropped** — `Chain.open` calls `store.insert(tailBlock)` directly on the tracker (not inside an Atomic wrapper), so the insert persists.
- **Tree-vs-Chain header double-duty** — Tree's `createHeaderBlock` returns `{header, rootId}` and Chain.open adds `headId`/`tailId` via `apply()` onto the same inserted block. All three fields coexist.
- **NetworkTransactor "not found" second-chance retry** — the merge logic in `network-transactor.ts:118-133` stores the original `{state:{}}` response in `resultEntries`, so `distinctBlockIds.filter(bid => !resultEntries.has(bid))` is empty and no "missing" error is raised. The response flows back as `{state:{}}`, which `TransactorSource.tryGet` correctly treats as "block not found".
- **CoordinatorRepo.get branching on `clusterLatestCallback`** — on a solo node with empty storage, `queryClusterForLatest` calls `findCluster`, gets back just self, calls the callback which uses SyncClient to loopback-request — the local SyncService returns `undefined` archive for a missing block, callback returns undefined, `fetchBlockFromCluster` is a no-op. `localResult` stays as `{[blockId]: {state:{}}}`.
- **arachnode / ring-zulu wrapping** — the only thing enableRingZulu changes for reads is injecting a `restoreCallback` into `BlockStorage` via `StorageRepo.createBlockStorage`. For a fresh block, `BlockStorage.getBlock` returns `undefined` before any restore callback fires (metadata is absent), so StorageRepo.get returns the canonical `{state:{}}` either way.
- **Two Tree instances on same id (schema-manager pattern)** — `Tree.createOrOpen` twice on the same id and same transactor, first read-only (`find`), then write (`replace`). Passes in `fresh-node-ddl.spec.ts`.
- **clusterSize=1 vs the default clusterSize=10** — both reproduction attempts used clusterSize=1 (matching sereus-health). Also covered.

## Open questions — this is why the ticket is blocked

1. **What is different about the failing device?** A fresh-install Android (or iOS) app with cleared data, running the exact same code, triggers the throw. But the equivalent wiring in this repo does not. Possibilities:
   - Persistent storage implementation on device (React Native file-system-backed blockStorage) differs from `MemoryRawStorage`. Does it leave stale metadata across "clear app data"? Does any operation run asynchronously after a prior session was killed mid-DDL?
   - Async scheduling / microtask ordering on the React Native runtime exposes a race that Node's event loop does not.
   - The app actually wires additional hooks (validation hook on StorageRepo, a different keyNetwork, custom restoration callbacks) that the test harness does not replicate.
2. **What is the exact stack trace on the device?** The ticket says the throw is `chain.ts:102`, but the line above it is `getTail`. Is it:
   - `getTail` returning `undefined` because `headerBlock.tailId` is undefined? → Header never got `tailId` set.
   - `getTail` returning `undefined` because `tryGet(tailId)` returned undefined? → Tail block not retrievable.
   - Different? → We need the actual error chain on-device.
3. **Does the error occur on the very first `tree.replace` of the first `CREATE TABLE`, or on the second CREATE TABLE in the same session?** The ticket says "first `create table`" — but sereus-health's cadre service may make multiple calls (`getSchema` before `storeSchema`, index-tree creation after) which could perturb state between them.
4. **Does adding device-side instrumentation at TransactorSource.tryGet / CacheSource.tryGet / Tracker.tryGet / Chain.getTail show the same "undefined return" that the ticket hypothesizes?** Without this we are guessing at the shape.

## Recommended unblock path

The cheapest way to unblock is to add temporary logging at the four layers below and run the failing flow on-device **once**, then share the log:

- `TransactorSource.tryGet` (transactor-source.ts:28): log `{ id, hasResult: !!result, hasBlock: !!result?.[id]?.block, hasLatest: !!result?.[id]?.state?.latest }` on every call.
- `CacheSource.tryGet` (cache-source.ts:20): log `{ id, cacheHit, sourceReturnedBlock: !!block }`.
- `Tracker.tryGet` (tracker.ts:14): log `{ id, sourceBlock: !!block, hasInsert: !!this.transforms.inserts?.[id], hasDelete: this.transforms.deletes?.includes(id), returnedBlock }`.
- `Chain.getTail` (chain.ts:303): log `{ headerId: header?.header?.id, tailId: headerBlock?.tailId, tailBlock: !!tail, nextChain: tail?.nextId }`.

Alternatively, capture an Android/iOS reproduction bundle (app's actual Optimystic storage directory after the failure) and attach the files to this ticket — that lets someone replay against the real persisted data in-repo without the device.

## What is NOT blocked

The Phase 4 coordinator-repo blockId extraction fix (`tickets/review/5-coordinator-repo-pend-blockid-extraction.md`) is ready to ship.

The Phase 1 regression + the fresh-node-ddl integration tests are valuable independent of the outcome here — they pin the core-layer behavior against future regressions.
