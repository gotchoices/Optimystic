description: A transaction that reads a block already sitting in its local cache now records that read, so it can no longer read stale data and be wrongly accepted; verify the read path records every read — cached or not.
files:
  - packages/db-core/src/transaction/read-dependency-collector.ts (NEW — shared per-txn read-dependency accumulator, max-revision-wins)
  - packages/db-core/src/transactor/transactor-source.ts (records via shared collector; new getReadRevision; records only for blocks that exist)
  - packages/db-core/src/transform/cache-source.ts (per-id revision map; records deps on hit AND miss; transformCache/clear maintain revisions)
  - packages/db-core/src/collection/collection.ts (wires one shared collector; applyCommittedToCache/syncInternal thread the committed revision)
  - packages/db-core/src/transaction/coordinator.ts (passes recordCommitted's rev into applyCommittedToCache, both success + partial-commit paths)
  - packages/db-core/src/transaction/index.ts (exports ReadDependencyCollector)
  - packages/db-core/test/read-dependency-cache-hit.repro.spec.ts (NEW — cross-boundary cache-hit repro)
  - packages/db-core/test/cache-source.spec.ts (new read-dependency + collector cases; existing transformCache calls updated for new signature)
  - packages/db-core/test/transactor-source.spec.ts (asserts absent read records no dependency)
  - packages/db-core/docs/collections.md (transformCache call updated)
----

# Review: read-dependency capture on cache hits

## What was wrong (confirmed, reproduced)

Reads flow `Tracker → CacheSource → TransactorSource`. A read dependency
(`{ blockId, revision }` — "this transaction observed block X at revision R", the
input to the optimistic-concurrency stale-read check) was recorded in exactly one
place: `TransactorSource.tryGet`, only on an actual source fetch. `CacheSource`
serves a cache hit **without touching the source**, so any block served from cache
recorded **no dependency**. Because the cache persists across transactions on a
`Collection` instance while dependencies are cleared at each transaction boundary,
the headline failure is cross-transaction: txn 1 reads X (miss → dep recorded, X
cached), commits (deps cleared); txn 2 reads X (cache hit → source never consulted →
**no dep**). The validator never learns txn 2 depends on X, so it can read a
superseded revision of X and still pass. Snapshot isolation was holding only by the
luck of cache misses.

## What the fix does

One `ReadDependencyCollector` (new, `src/transaction/read-dependency-collector.ts`)
is owned by `Collection.createOrOpen` and injected into **both** the
`TransactorSource` (direct structural reads — bootstrap, header) and the
`CacheSource` (every cache hit/miss). The collector keys by block id and keeps the
**highest** revision seen (never downgrades). Because both layers feed the same
collector, a cache miss records the same id@rev from each layer and max-wins
collapses them to a single entry.

The revision has to travel with the cache because only `TransactorSource` knows it
(from `state.latest?.rev`) while the cache is what persists. So `CacheSource` keeps a
per-id `revisions` map: learned on a miss-load from the source (via a duck-typed
`getReadRevision`, mirroring how `Tracker` probes `getGeneration`), re-emitted on
every hit, and advanced by `transformCache` when a commit folds new content in
(otherwise a later read would record a dependency at the *old* revision for *new*
content and spuriously fail validation). `transformCache(transform, revision)` now
takes the committed revision; `Collection.syncInternal` passes `newRev`,
`applyCommittedToCache` gained a `revision` param, and the coordinator threads
`recordCommitted`'s return value into it (both the success and partial-commit paths).

## Deviations from the ticket — review these

1. **Repro spec uses a shared collector.** The ticket's literal snippet built
   `new CacheSource(source)` with no collector and asserted via
   `source.getReadDependencies()`. That construction would **not** pass — a
   collector-less CacheSource records nothing on a hit, and the source's own default
   collector never sees the hit (the source isn't consulted). The realistic wiring —
   and what `Collection.createOrOpen` actually does — is to pass one shared collector
   to both layers; `source.getReadDependencies()` then works because it delegates to
   that shared instance. The ticket explicitly left this to implementer's discretion
   ("whether you assert via `source.*` or via the collector directly is your call").
   The cross-boundary assertion is preserved.

2. **`TransactorSource` now records a dependency ONLY for a block that exists**
   (guarded on `block` being defined, not merely on the response entry being
   present). This is a **pre-existing-behavior change** worth a close look. A
   transactor can return a *populated* entry with `block: undefined` for a
   genuinely-missing block (`TestTransactor` does this; the comment notes the Network
   transactor always populates the key). The old code recorded a phantom `id@0`
   dependency in that case, which is inconsistent with the sparse-entry case (entry
   omitted → nothing recorded) that `transactor-source.spec.ts` already asserts. The
   ticket's stated invariant is "absent reads record nothing (hit and miss)", so this
   makes the contract uniform. **Tradeoff:** it drops any phantom-read protection for
   absent blocks (reading "X does not exist" no longer creates a dependency that would
   invalidate the txn if X is later created). The current validator only checks stale
   reads of existing revisions, so this is not a regression against today's validator
   — but if phantom protection is ever wanted, it needs deliberate design, not this
   incidental `id@0` record. Flagging for a decision.

## Use cases / validation

Build: `cd packages/db-core && yarn build` — clean.
Tests: `yarn test` — **1180 passing, 0 failing** (streamed).

Covered by new/updated tests:
- **Cache hit records a dep across a txn boundary** (repro spec — the headline bug).
- **Miss records the block exactly once** (source + cache collapse to one entry).
- **Cache hit re-emits the revision learned on miss** (`cache-source.spec.ts`).
- **Revision monotonicity**: `transformCache(_, 2)` after a load at rev 1 → a later
  read records rev 2, not 1; and `ReadDependencyCollector` never downgrades a higher
  revision.
- **Absent blocks record nothing** — at the CacheSource layer, and at the
  TransactorSource layer (populated-but-blockless entry).
- **`transformCache` delete** drops the stored revision (later read re-learns).
- **No-collector construction** (log-walk caches) still works — hit and miss.
- Existing `transformCache` content/generation/LRU behavior unchanged.

## Known gaps (treat tests as a floor)

- **No end-to-end validator test.** The new tests prove the dependency is *captured*;
  none drives a full `TransactionSession`/coordinator/validator path proving that a
  cross-transaction cache-hit read of a superseded block is now *rejected* at commit.
  That is the ultimate behavioral guarantee and is the highest-value test to add —
  consider whether the review should require it.
- **`getReadRevision` is only implemented by `TransactorSource`.** In the real
  `Collection` wiring CacheSource wraps TransactorSource directly, so a miss always
  learns the true revision. But any other `BlockSource` layered under CacheSource
  would miss-load at rev 0 (the duck-typed fallback). No test guards that layering
  because it does not occur in production wiring.
- **Multi-collection revision threading** through the coordinator is exercised only
  indirectly by the existing (passing) coordinator suite; no new test asserts each
  collection's cache advances to its own committed rev after a multi-collection
  commit.

## Tripwires (parked, not tickets)

- **LRU eviction leaves a stale `revisions` entry in `CacheSource`.** Benign — the
  next read of an evicted id is a miss that re-learns and overwrites before recording.
  Recorded as a `// NOTE:` on the `revisions` field in `cache-source.ts`.
- **`CacheSource.revisions` and `TransactorSource.readRevisions` are never pruned**
  (one small `id → number` entry per distinct id ever seen), exactly like the existing
  `generations` map which already carries this NOTE. Bounded by distinct blocks a
  collection sees; only worth acting on if that set grows large.

## TODO for reviewer

- Adversarially probe deviation #2 (absent-read recording change) — is dropping the
  phantom `id@0` dependency acceptable, or should a follow-up preserve phantom-read
  protection deliberately?
- Decide whether an end-to-end "stale cache-hit read is rejected at commit" test is
  required before complete/, or acceptable as a follow-up.
- Confirm no dependent package (db-p2p) breaks on the `transformCache` /
  `applyCommittedToCache` signature changes — repo-wide search found no external
  callers, but a `db-p2p` build confirms it.
