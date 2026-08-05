description: A read that asks for "only already-committed data" can currently change its answer halfway through, because it shares a block cache with the writer that is publishing new data. Pin such a read to a fixed point in time so it returns one consistent answer from start to finish.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/test/
difficulty: hard
----

# Pin the committed read view to a fixed revision

## What is broken

`Collection.createReadTracker(transforms)` (`collection.ts:326`) builds the
read-only view that backs every "committed" read:

```ts
createReadTracker(transforms: Transforms): Tracker<IBlock> {
    return new Tracker(this.sourceCache, copyTransforms(transforms));
}
```

`Tree.readView(snapshot)` (`tree.ts:199`) wraps that tracker in a `BTree`, and
the Quereus plugin uses it to answer `committed.<Table>` reads
(`optimystic-module.ts:578`, `committedTreeView`).

The isolation this provides is **transform-level only**. The tracker gets its own
private copy of the transform set, so it does not see rows staged into the live
tracker after the snapshot — that part works and is what
`test/committed-read.spec.ts` pins today. But every block id **not** in that
transform set is read straight from `this.sourceCache`, which is the *same*
`CacheSource` instance the live collection reads and writes through. Two sites
mutate that cache in place:

- `CacheSource.transformCache(transform, revision)` (`cache-source.ts:127`) —
  overwrites cached blocks with just-committed content and bumps each id's
  generation. Called from `Collection.applyCommittedToCache` (used by
  `TransactionCoordinator.commitOnce` at `coordinator.ts:338` and `:383`, i.e.
  session-mode commit) and from `Collection.syncInternal` (`collection.ts:477`,
  i.e. legacy-mode `tree.sync()`).
- `CacheSource.clear(blockIds?)` (`cache-source.ts:108`) — drops cached blocks so
  the next read refetches. Reached from `Collection.updateInternal`'s
  revert/replay path, which every *live* read runs via `collection.update()`.

In the normal case the pre-stage snapshot's transform set is **empty** (the tree
was clean before the transaction), so the committed view shadows nothing and
reads essentially everything through the shared cache.

Consequences, in order of severity:

1. **Mid-scan tear.** A committed scan that is part-way through iteration when a
   commit folds into the cache starts returning post-commit blocks for the rest
   of the walk. The `Tracker`'s materialized-block memo is keyed on
   `CacheSource.getGeneration(id)`, which `transformCache` bumps, so even
   memoized reads flip. The scan's output is then a mixture of two states — a row
   set that never existed at any single point in time.
2. **Publishing rows that later roll back.** In legacy mode
   `TransactionBridge.commitDirtyTreesLegacy` (`txn-bridge.ts:396`) flushes trees
   one at a time; each `tree.sync()` folds that tree's blocks into the cache as it
   goes. A committed read taken between tree 3 and tree 4 sees trees 1–3's rows.
   If tree 4's flush then fails, the sweep throws `PartialCommitError` and trees
   4..N never land — so the committed view already published a state the
   transaction never reached as a whole.
3. **Cross-tree disagreement.** The main table's tree and each secondary-index
   tree are separate `Collection`s with separate caches, folded at separate
   moments during one commit. An index-driven committed read and a full committed
   scan can therefore straddle the same commit in opposite directions and return
   different row sets.

Reachability: `static` — established by reading the code above, not by running a
repro. Under Quereus's current execution mutex a committed read only happens
inside a deferred CHECK, which drains *before* `connection.commit()`, so a commit
is not normally in flight during one. The `update()`-clears-the-cache arm (2nd
bullet of the mutation list) may be reachable today when a live scan and a
committed scan interleave within one statement; **build that repro first** (see
TODO) and report in the handoff whether it reproduces on unmodified code — if it
does, this is a live defect and not merely readiness work.

Fixing it here rather than in the plugin is deliberate: all three consequences
resolve at the one site, `createReadTracker`, and any consumer of
`Tree.readView` inherits the fix.

## Design

Give each read view a **private, revision-pinned read path** instead of the
collection's shared one.

```
Collection
  ├─ source: TransactorSource      (live; actionContext advances on commit)
  ├─ sourceCache: CacheSource      (shared, mutated by transformCache/clear)
  └─ tracker: Tracker              (live staged transforms)

createReadTracker(transforms, opts?)  ──►  Tracker
                                             └─ CacheSource (PRIVATE, seeded)
                                                  └─ TransactorSource (PRIVATE,
                                                     actionContext FROZEN at
                                                     view-creation time)
```

Three properties, each doing distinct work:

- **Frozen `ActionContext`.** `TransactorSource.tryGet` already forwards its
  `actionContext` as `transactor.get({ blockIds, context })`, and the transactor
  materializes at `context.rev` (`test-transactor.ts:97` →
  `latestMaterializedAt(blockState, context.rev)`). Deep-copy
  `this.source.actionContext` at view-creation time and hand the copy to the
  private source, so a block first read *after* a commit still resolves to the
  pinned revision rather than to head.
- **Private `CacheSource`.** Nothing else holds a reference, so
  `transformCache`/`clear` on the collection's shared cache cannot reach it.
- **Seed the private cache from the shared one at creation.** Copy the shared
  cache's current entries (and their per-id revisions) into the private cache in
  the same synchronous step that freezes the context. Without this, every
  committed read starts stone cold and refetches every block it touches over the
  network — a serious regression on the deferred-CHECK path, which today runs
  entirely out of the warm shared cache. The copy is bounded by the LRU size
  (`DefaultMaxSize = 128`) and the entries are `structuredClone`d on the way in,
  so the copy is genuinely private. This needs a new seeding entry point on
  `CacheSource` (e.g. `snapshotEntries()` / a seeding constructor argument);
  keep it narrow and document it as "for building a pinned read view".

  *Correctness of seeding:* the freeze and the seed happen in one synchronous
  block with no `await` between them, so the seeded blocks and the frozen
  `actionContext.rev` describe the same instant. Do not split them.

- **Read dependencies are NOT recorded from a pinned view.** Today the shared
  `sourceCache` carries the collection's shared `ReadDependencyCollector`, so a
  committed read adds entries to the *writer's* conflict set. Once concurrent
  committed reads exist (ticket `committed-read-snapshot-declaration`), an
  unrelated reader would then be able to fail the writer's commit validation.
  Construct the private `CacheSource` and `TransactorSource` with **no**
  collector, and expose the choice as an explicit option so the decision is
  visible at the call site:

  ```ts
  interface ReadViewOptions {
      /** Record read dependencies into the collection's shared collector.
       *  Default false — a pinned committed view is not part of any
       *  transaction's conflict set. */
      recordReads?: boolean;
  }
  createReadTracker(transforms: Transforms, options?: ReadViewOptions): Tracker<IBlock>
  ```

  `Tree.readView(snapshot, options?)` forwards it.

  Why dropping the dependency is safe for the `Monotonic`-style deferred CHECK
  this feature exists to serve: protection against a concurrent committer
  invalidating the CHECK does not come from the read set — validator peers
  **re-execute** the transaction's recorded statements against their own
  committed state (`packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts`,
  and see the statement-record note in `txn-bridge.ts:576`), so a constraint that
  no longer holds is caught at validation. This is a behavior change and must be
  stated in the handoff.

### Interfaces

```ts
// collection.ts
createReadTracker(transforms: Transforms, options?: ReadViewOptions): Tracker<IBlock>;

// tree.ts
readView(
  snapshot: CollectionSnapshot<TreeReplaceAction<TKey, TEntry>>,
  options?: ReadViewOptions,
): TreeReadView<TKey, TEntry>;

// cache-source.ts — new, narrow, for pinned-view construction only
snapshotEntries(): Array<[BlockId, T, number /* revision */]>;
```

Keep `readView`'s existing single-argument call sites working unchanged.

## Edge cases & interactions

- **Collection with no committed revision yet** (`actionContext` undefined — a
  brand-new tree whose header/root still live in the tracker). The pinned source
  gets `undefined` context, exactly as the live source has; the header/root come
  from the snapshot's transforms. Cover with a test: a committed read of a
  never-synced collection must still be readable, matching the guarantee
  `snapshotPending` was written to preserve (`collection.ts:294`).
- **Block genuinely absent at the pinned revision** must stay absent, not fall
  back to head. Assert the pinned source is consulted, not the live one.
- **`BlockUnavailableError`** from the pinned source (a revision the node cannot
  reconstruct) must propagate, not be swallowed into "absent" — this is the
  "degraded state must throw rather than answer" half of the upstream contract.
- **Fold-mid-scan.** Start a `readView` walk, pull a few rows, run
  `applyCommittedToCache` + `tracker.reset()` on the live collection, then finish
  the walk. Every row must come from the pinned state. This is the primary
  regression test.
- **`clear()`-mid-scan.** Same shape, with `sourceCache.clear()` (the
  `update()` path) instead of a fold.
- **LRU eviction under a scan larger than the cache.** Build a tree with more
  blocks than `DefaultMaxSize` (use `Tree.createOrOpen`'s `nodeCapacity` to force
  many small nodes), commit new content mid-scan, and confirm the refetch of an
  evicted block still resolves at the pinned revision. This is the case seeding
  alone does not cover and the frozen context does.
- **Two views of the same collection created at different revisions** must not
  interfere (each has its own cache and context).
- **Legacy partial-commit sweep.** A committed view created before
  `commitDirtyTreesLegacy` starts must not observe trees 1..N's rows as the sweep
  walks — and must be unaffected by the subsequent `PartialCommitError` restore.
- **Memory.** Each pinned view holds up to `DefaultMaxSize` cloned blocks plus
  whatever it faults in. Views are per-scan and dropped when the scan ends; note
  in a `NOTE:` comment that a very long-lived committed scan pins that much.

## Tests (db-core)

Add to `packages/db-core/test/`. Command: `yarn test` from
`packages/db-core` (mocha + chai, per AGENTS.md).

- `readView` walk is unchanged by a concurrent `applyCommittedToCache` — asserted
  row-for-row, not just by count.
- `readView` walk is unchanged by a concurrent `sourceCache.clear()`.
- Evicted-then-refetched block resolves at the pinned revision (tree larger than
  the cache).
- Committed view of a never-synced collection is still readable.
- `recordReads` defaults to false: after a `readView` walk, the collection's
  `getReadDependencies()` is unchanged; with `recordReads: true` it grows.
- Existing `committed-read.spec.ts` in the plugin still passes (build the plugin
  first — its specs import `../dist/plugin.js`).

Expected output shape: each mid-scan test collects the full row list from the
view and compares it against the list captured before the concurrent mutation;
any divergence is reported with the differing rows, not just a length mismatch.

## TODO

- Write the interleave probe FIRST, against unmodified code: within one plugin
  statement, drive a live scan (which calls `collection.update()`) and a
  committed scan over the same table so the `update()` cache-clear lands
  mid-committed-scan. Record in the handoff whether it reproduces.
- Add `ReadViewOptions` and thread it through `Collection.createReadTracker` and
  `Tree.readView` (default `recordReads: false`).
- Add `CacheSource` seeding support (`snapshotEntries()` or equivalent), cloning
  blocks and carrying per-id revisions.
- Rewrite `createReadTracker` to build a private `TransactorSource` (frozen
  deep-copied `actionContext`, no collector) + private seeded `CacheSource`, in
  one synchronous block.
- Confirm the network transactor honours `context.rev` on `get` the way
  `TestTransactor` does (`packages/db-p2p`); if it does not, say so explicitly in
  the handoff — the pinning guarantee is only as strong as that.
- Add the db-core tests above; run `yarn test` in `packages/db-core` and
  `packages/quereus-plugin-optimystic` (build the plugin first).
- Update `packages/db-core/src/collections/tree/readme.md` and any prose in
  `docs/` describing what a committed read view guarantees.
- Handoff must state the read-dependency behavior change and the interleave-probe
  result.
