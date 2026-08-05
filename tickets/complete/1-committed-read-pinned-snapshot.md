description: A read that asks for "only already-committed data" could change its answer (or crash) halfway through, because it shared a block cache with the writer publishing new data. Such reads are now pinned to a fixed point in time, on every path.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/test/read-view-pinned.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/committed-read-interleave.spec.ts, packages/db-core/src/collections/tree/readme.md, docs/internals.md
difficulty: medium
----

# Complete: pinned committed read view

## What shipped

`Collection.createReadTracker(transforms, options?)` no longer hands a committed read
view the collection's SHARED block cache. In one synchronous block (so all three legs
describe the same instant) it builds:

- a private `TransactorSource` whose `actionContext` is a `structuredClone` frozen at
  view-creation time — the transactor honours `context.rev` on `get`, so a block first
  fetched after a later commit still materializes at the pinned revision;
- a private `CacheSource` nothing else references, so the live collection's
  `transformCache`/`clear` cannot reach it;
- that private cache seeded from the shared one via `CacheSource.snapshotEntries()`
  (cloned blocks + per-id revisions, in LRU order) through a new optional `seed`
  constructor argument, so the common warm-cache committed read does not refetch.

By default the view records NO read dependencies; `ReadViewOptions { recordReads?: boolean }`
opts back in, wiring the collection's shared collector (exposed via
`TransactorSource.getCollector()`). `Tree.readView(snapshot, options?)` forwards the options.

The review pass added the missing consumer-side leg: the plugin's `committedTreeView`
now routes **every** committed read through `readView`, including a tree with nothing
staged this transaction (see findings below).

## Behavior change

**Committed views no longer feed the writer's conflict set.** Previously a committed
scan recorded read dependencies into the collection's shared collector, so it could fail
the writer's commit validation. Default is now `recordReads: false`. Deferred-CHECK
safety does not rest on those reads: validator peers re-execute the transaction's
recorded statements against their own committed state (`quereus-validator.ts`), so a
constraint that no longer holds is caught at validation. No in-repo caller passes
`recordReads: true`.

## Review findings

### Major — found, reproduced, fixed in this pass

**The committed read of a tree with nothing staged this transaction was still
unpinned.** `OptimysticVirtualTable.committedTreeView` returned the *live tree* whenever
`txnBridge.getDirtySnapshot(tree)` was undefined, on the reasoning that "a clean tree
already reflects committed state". That is true at scan start and false across the scan:
the live tree reads through the shared cache and live action context, so an interleaved
live read of the same table (which runs `collection.update()`, clearing cached blocks
when another writer has committed) makes the committed walk finish against post-commit
blocks. The implement pass's own probe deliberately staged a row first, so it never
exercised this arm.

Verified, not inferred: re-running that probe with the staging removed failed on the
fixed code with the *same* symptom the ticket was filed for —
`Query failed: Missing block (bueM-e_BouYtp3KvHz5PBq5Gdyx7sTkiOCEbJTSec6k)` out of
`queryCommitted`.

Fix: `committedTreeView` now always calls `tree.readView(...)`, falling back to
`tree.snapshot()` when the bridge has no captured snapshot — the same transforms the
live tree would have read, but through the private pinned stack. The interleave spec was
refactored into a shared probe helper and now runs both arms (STAGED and CLEAN); the
CLEAN arm fails without the fix.

### Verified as sound — the load-bearing claims, re-checked from the code

- **Pinning atomicity.** `createReadTracker` is fully synchronous, so nothing can
  interleave inside it. Both sites that fold a commit into the shared cache pair that
  fold with the matching context advance with no `await` between them
  (`syncInternal` :513-516; `TransactionCoordinator` :337-338 and :382-383), so the seed
  can never carry content newer than the pinned context. `update()` only *clears* cache
  entries, which can at worst force a refetch — at the pinned revision.
- **The seed clone is load-bearing, not defensive noise.** `transformCache` mutates
  cached blocks in place through `applyOperation` (`cache-source.ts:166`), so without
  `snapshotEntries`' `structuredClone` a later fold on the shared cache would reach into
  a live view.
- **LRU claims hold.** `LruMap` delegates iteration to its backing `Map`, so
  `snapshotEntries` yields oldest-first and replay preserves eviction order; it iterates
  the map directly rather than through `get`, so snapshotting does not perturb the
  *shared* cache's LRU order.
- **`recordReads: true` cannot lower a recorded revision.**
  `ReadDependencyCollector.record` is max-wins on revision and value-wins on purpose, so
  a pinned (older) read merges harmlessly with a higher live read.
- **Nothing can reach the private cache after construction.** `Tracker.reset` clears only
  its own memo; the tracker never calls `clear`/`transformCache` on its source.
- **`revisions.get(id) ?? 0`** in `snapshotEntries` is unreachable — every `cache.set`
  site pairs with a `revisions.set`. Harmless as written.
- **Legacy partial-commit sweep** (the handoff's own listed gap): agreed, no test filed.
  Both mutation paths it goes through are covered per-tree, and with each view's cache
  *and* source private there is no remaining mechanism for cross-tree exposure. A test
  would assert the absence of a mechanism that no longer exists.

### Recorded as tripwires, not tickets

- **Invented collections pin to no revision.** A collection whose header probe found
  nothing has `actionContext === undefined`, so its pinned source asks the transactor for
  the latest. Harmless today because such a collection's blocks all live in the tracker
  transforms and a view never reaches storage. `NOTE:` at
  `Collection.createReadTracker`.
- **Pinning a clean tree is no longer free.** It costs a transforms copy plus a clone of
  the cached blocks (LRU budget, currently 128) per committed scan, where returning the
  live tree cost nothing. Not measured — flagged conditionally, since committed reads are
  per-statement today. `NOTE:` at `committedTreeView`.

### Already claimed by an open ticket — deliberately not filed

- **Main-tree and index-tree views are pinned at different instants.**
  `resolveMainRead` builds the main view; `executeIndexScan` builds the index view later,
  so an index-driven committed read can disagree with a full scan. The window is only a
  couple of microtask ticks (no commit fits in it), and `committed-read-connection-isolation`
  (`tickets/implement/2-…`) already owns the fix — its TODO is to build all committed
  views in one synchronous block. That ticket's edge-case list also carried the
  clean-tree hole as an open question; that bullet is now marked closed with what was
  found, so the next agent does not redo it.
- **`optimystic-module.ts` is 2255 lines** (`wc -l`). Real size debt, but that file is the
  restructure target of the same in-flight ticket; splitting it from here would collide.

### Nothing found

- **Resource cleanup / leaks:** views hold no handles, no timers, no subscriptions; they
  are plain object graphs dropped with the scan.
- **Type safety:** no new `any`; the one cast (`Parameters<Tree['readView']>[0]`) narrows
  the bridge's deliberately-opaque `unknown` snapshot at the single site that owns the
  pairing.
- **Error handling:** `BlockUnavailableError` still propagates from the pinned source
  rather than reading as absent (covered by test).

## Validation

- `yarn lint` at root — clean.
- `packages/db-core`: `yarn test` — **1344 passing**.
- `packages/quereus-plugin-optimystic`: `yarn build` + `yarn test` — **338 passing**,
  11 pending (one more than the implement pass: the new CLEAN interleave arm).
- `packages/db-p2p`: `yarn test` — **1515 passing**, 44 pending.
- Env-gated integration specs (`OPTIMYSTIC_INTEGRATION=1`) were **not** run.

## Network-path confirmation (carried from implement)

`NetworkTransactor.get` forwards `context` to each peer's `IRepo.get`; `StorageRepo.get`
calls `BlockStorage.getBlock(context?.rev)`, which resolves the highest committed rev ≤
the requested one; `CoordinatorRepo` forwards the same context. One asymmetry vs
`TestTransactor`: a node holding ONLY revisions newer than the pinned one answers
`unavailable` (→ `BlockUnavailableError`) rather than "absent". That errs loud, and a
pinned walk cannot normally reach such a block — pinned interior nodes only reference
pinned-era children.
