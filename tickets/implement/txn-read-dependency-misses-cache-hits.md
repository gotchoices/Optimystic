description: A transaction that reads data already sitting in its local cache forgets to record that it read it, so it can read stale data and still be wrongly accepted; fix the read path so every read — cached or not — is recorded.
files:
  - packages/db-core/src/transactor/transactor-source.ts (records the read dependency today, only on a source fetch)
  - packages/db-core/src/transform/cache-source.ts (serves cache hits without touching the source — where the read is currently lost)
  - packages/db-core/src/collection/collection.ts (wires source + cache, exposes getReadDependencies/clearReadDependencies, folds committed transforms into the cache)
  - packages/db-core/src/transaction/transaction.ts (ReadDependency type)
  - packages/db-core/test/cache-source.spec.ts (existing cache tests to extend)
difficulty: medium
----

# Fix: read-dependency capture misses cache hits

## Confirmed bug (reproduced)

Reads flow `Tracker → CacheSource → TransactorSource`. A `ReadDependency`
(`{ blockId, revision }` — the record that "this transaction observed block X at
revision R") is written in exactly one place: `TransactorSource.tryGet`
(`transactor-source.ts:37`). `CacheSource.tryGet` returns a cached block **without
calling the underlying source** (`cache-source.ts:41-43`), so any block served from
the cache produces **no read dependency**.

The collected dependencies are cleared at each transaction boundary
(`Collection.clearReadDependencies` → `TransactorSource.clearReadDependencies`,
called from `session.ts:143` after commit) — but the **cache persists across
transactions** on the same `Collection` instance (and is refreshed by
`applyCommittedToCache`). So the headline failure is cross-transaction:

1. Transaction 1 reads block X → cache miss → dependency recorded, X cached.
2. Transaction 1 commits → dependency set cleared.
3. Transaction 2 reads block X → **cache hit** → source never consulted → **no
   dependency recorded**. The optimistic-concurrency validator never sees that
   txn 2 depends on X, so its stale-read check cannot fire. Txn 2 can read a
   now-superseded revision of X and still pass validation.

Snapshot isolation is currently only "enforced" by the luck of cache misses.

### Reproducing test (was run red before hand-off; recreate it)

Add `packages/db-core/test/read-dependency-cache-hit.repro.spec.ts`. The second
case fails on today's code (`expected [] to include 'blk'`) and must pass after the
fix:

```ts
import { expect } from 'chai'
import { TransactorSource } from '../src/transactor/transactor-source.js'
import { CacheSource } from '../src/transform/cache-source.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import type { ActionId, BlockId, IBlock } from '../src/index.js'

describe('repro: read-dependency capture misses cache hits', () => {
	const collectionId = 'coll' as BlockId
	const blockId = 'blk' as BlockId

	async function seedBlock(transactor: TestTransactor) {
		await transactor.pend({
			actionId: 'seed' as ActionId,
			transforms: { inserts: { [blockId]: { header: { id: blockId, type: 'T' as any, collectionId } } as IBlock }, updates: {}, deletes: [] },
			policy: 'c',
		})
		await transactor.commit({ actionId: 'seed' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })
	}

	it('records a dependency on a cache HIT across a transaction boundary', async () => {
		const transactor = new TestTransactor()
		await seedBlock(transactor)
		const source = new TransactorSource<IBlock>(collectionId, transactor, undefined)
		const cache = new CacheSource<IBlock>(source /*, maxSize, collector */)

		await cache.tryGet(blockId)          // txn 1: miss -> records dep
		source.clearReadDependencies()       // txn 1 commits -> clears deps
		expect(source.getReadDependencies()).to.be.empty

		await cache.tryGet(blockId)          // txn 2: cache HIT
		expect(source.getReadDependencies().map(d => d.blockId)).to.include(blockId)
	})
})
```

(Note: in the recommended design `getReadDependencies`/`clearReadDependencies`
delegate to a shared collector; whether you assert via `source.*` or via the
collector directly is your call — keep the cross-boundary assertion.)

## Why the revision has to travel with the cache

The dependency's `revision` is known **only** at `TransactorSource` (from
`state.latest?.rev`). The cache is what persists across transactions. So to record a
dependency on a cache hit, the cache must **store the revision** it observed when it
first loaded the block, and re-emit it on every subsequent read. Recording deps
"above" the cache alone is not enough — the layer above still has to obtain the
revision from below, and it must survive the per-transaction `clear()`.

Capturing in `Tracker.tryGet` was considered and rejected: the Tracker's
`materialized` memo (`tracker.ts:45-48`) returns before reaching the source, and the
Tracker has no revision to record. The memo is cleared on `reset()` at every
transaction boundary, so it is *safe* today, but it makes the Tracker the wrong
capture layer. `CacheSource` is the layer where every committed-block read converges
**and** where a persistent per-id revision can live.

## Recommended design

A single **read-dependency collector**, owned by `Collection`, injected into **both**
`TransactorSource` (covers direct `source.tryGet` structural reads — bootstrap,
header) and `CacheSource` (covers all cache hits and misses). Both feed one
collector; de-dup is max-revision-wins so a block loaded once from source and later
re-read from cache never loses or downgrades its recorded revision (per the ticket's
explicit requirement).

```ts
// new: packages/db-core/src/transaction/read-dependency-collector.ts
import type { BlockId } from "../blocks/index.js";
import type { ReadDependency } from "./transaction.js";

/** Accumulates the read dependencies of one transaction. Keyed by block id, keeping
 *  the HIGHEST revision observed for each id (never downgrades — a re-read from cache
 *  must not overwrite a higher revision seen earlier). Cleared at each txn boundary. */
export class ReadDependencyCollector {
	private revisions = new Map<BlockId, number>();
	record(blockId: BlockId, revision: number): void {
		const prev = this.revisions.get(blockId);
		if (prev === undefined || revision > prev) this.revisions.set(blockId, revision);
	}
	getReadDependencies(): ReadDependency[] {
		return [...this.revisions].map(([blockId, revision]) => ({ blockId, revision }));
	}
	clear(): void { this.revisions.clear(); }
}
```

### `TransactorSource`
- Constructor gains an **optional** `collector?: ReadDependencyCollector`; when
  absent, own a private default (preserves the many internal call sites —
  `network-transactor.ts`, `invalidation-client.spec.ts`, etc. — that build a
  `TransactorSource`/`CacheSource` pair just to walk a log and never need deps).
- In `tryGet` (found branch): compute `rev = state.latest?.rev ?? 0`, then
  `this.collector.record(id, rev)` (replacing the current `readDependencies.push`)
  **and** stash the observed revision so the cache can retrieve it.
- Add `getReadRevision(id: BlockId): number | undefined` returning the
  last-observed revision for `id` (backed by a small `Map<BlockId, number>`).
- `getReadDependencies()` / `clearReadDependencies()` delegate to the collector.

### `CacheSource`
- Constructor gains an **optional** `collector?: ReadDependencyCollector`.
- Track a per-id revision: `private revisions = new Map<BlockId, number>()`.
- `tryGet`:
  - **hit**: `const rev = this.revisions.get(id); if (rev !== undefined) this.collector?.record(id, rev);`
  - **miss → loaded**: after `this.source.tryGet(id)` returns a block, learn the
    revision from the source via the same optional-duck-typing pattern Tracker uses
    for `getGeneration` (`tracker.ts:24-27`): call a helper
    `getReadRevision(this.source, id)`, default `0` if the source can't report one;
    store it in `this.revisions` and `this.collector?.record(id, rev)`.
  - Absent block: record nothing (matches TransactorSource, which skips missing
    blocks — see the sparse-result test at `transactor-source.spec.ts:435-458`).
- **`transformCache` must thread the new revision.** After a commit folds new
  content into the cache, the stored revision must advance to the committed rev —
  otherwise a later read records a dependency at the *old* revision for content that
  is actually the *new* revision, producing a spurious stale-failure. Change the
  signature to `transformCache(transform: Transforms, revision: number)` and, for
  each inserted/updated id, set `this.revisions.set(id, revision)`; for each deleted
  id, `this.revisions.delete(id)`.
- `clear(blockIds?)`: drop the matching `revisions` entries too.
- LRU eviction: a silently-evicted id leaves a stale `revisions` entry, but the next
  read is a miss that re-learns and overwrites it, so this is benign. Add a
  `// NOTE:` at the eviction/`revisions` site so the invariant is greppable.

### `Collection`
- In `createOrOpen`, construct one `ReadDependencyCollector` and pass it to both
  `new TransactorSource(id, transactor, undefined, collector)` and
  `new CacheSource(source, maxSize, collector)`.
- `getReadDependencies()` / `clearReadDependencies()` delegate to the collector (or
  keep delegating through `this.source`, which now shares the same collector
  instance — either works).
- `syncInternal` (line ~351) and `applyCommittedToCache` (line ~246): pass the known
  committed revision into `transformCache`. In `syncInternal` that is `newRev`; in
  `applyCommittedToCache` the caller commits at `getNextRev()`/`recordCommitted`'s
  rev — thread that rev in (add a `revision` parameter to `applyCommittedToCache` and
  update its coordinator caller).
- The throwaway `TransactorSource`/`Tracker` built inside `updateInternal` (log-walk
  only) should **not** share the user's collector — let it default to its own, so
  internal update reads don't pollute the transaction read set.

## Watch-outs / verification

- **Don't double-count wrongly.** On a cache miss the block loads through
  `source.tryGet` (records via collector) *and* `CacheSource` records it — same id,
  same rev, max-wins collapses to one entry. Confirm `getReadDependencies()` returns
  one entry per id.
- **Revision monotonicity.** Test: load X@rev1 from source, then bump the cache to
  rev2 via `transformCache(_, 2)`, read X again → dependency revision is 2, not 1.
  And the reverse ordering never downgrades a recorded higher revision.
- **Absent blocks record nothing** (hit and miss).
- **Internal log-walk reads don't leak** into a user transaction's read set.
- Run the full `@optimystic/db-core` suite — `collection.ts`, `session`,
  `coordinator`, and `log` all consume `getReadDependencies`, so a signature or
  ownership slip surfaces there.

## TODO

- Add `ReadDependencyCollector` (new file under `src/transaction/`), export it from
  the package index if other modules need the type.
- Rework `TransactorSource` to use the injected/optional collector; add
  `getReadRevision(id)`; keep `getReadDependencies`/`clearReadDependencies` as
  delegating shims.
- Add per-id revision tracking + collector reporting to `CacheSource.tryGet`
  (hit and miss); add the optional-duck-typed `getReadRevision` helper mirroring
  `sourceGeneration`.
- Change `CacheSource.transformCache` (and `clear`) to maintain `revisions`; thread
  the committed revision through `Collection.syncInternal`,
  `Collection.applyCommittedToCache`, and the coordinator caller of
  `applyCommittedToCache`.
- Wire one shared collector into `Collection.createOrOpen`; keep `updateInternal`'s
  internal source/tracker on a throwaway collector.
- Recreate `test/read-dependency-cache-hit.repro.spec.ts` (above) and add
  `cache-source.spec.ts` cases: cache-hit records a dep, revision monotonicity
  (no downgrade), `transformCache` advances the recorded revision, absent blocks
  record nothing.
- `yarn build` + run the db-core test suite (stream with `tee`); confirm green.
