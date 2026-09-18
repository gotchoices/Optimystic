description: A change staged in memory now records which version of the block it was computed from and keeps that number until the change is committed or re-made, so the version a write later declares to storage is always the one its edits were really built on.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/base-pins.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/atomic.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/test/refresh-below-floor.spec.ts, packages/db-core/test/digest.spec.ts, packages/db-core/test/cache-source.spec.ts, docs/internals.md, packages/db-core/docs/collections.md
difficulty: hard
repro: verified
----

# A staged edit keeps the version it was computed against — review handoff

First of the three tickets split from `bug-a-pended-transform-does-not-carry-its-base`. No wire or storage format changed. The next ticket (`2-bug-a-pended-transform-does-not-carry-its-base`, in `implement/`) consumes `Tracker.stagedBaseRevs(blockIds)` from here; it returns `Record<BlockId, number>`, the shape that ticket puts on the pend.

## What was built

Three invariants, one site each, exactly as the ticket laid out. Read the doc bullet first: `docs/internals.md` § *Staged Edits Keep Their Base* is the summary; the code comments carry the reasoning.

**Invariant A — read cache (`CacheSource`, `packages/db-core/src/transform/cache-source.ts`).** What a read returns for a block is what the cache then describes for it. The miss path now goes through one `admit` step that decides the returned content and the cache's description together. A keepable, still-wanted answer is kept and returned. Any other answer (below floor, or overtaken in flight) is returned only when the cache holds nothing for the id; when it holds something, the reader gets the *held* content and its revision, and the answer leaves no trace. With nothing held, the answer is handed through (`unkept`: returned, described by `peek` and `getCachedRevision`, not kept). The read dependency recorded is the revision actually returned. The `revisions` NOTE was rewritten: the entry that outlives an LRU eviction is load-bearing (it is the revision of the content last served, which a rev-only pin carries). `handThrough`'s early return is gone; `admit` makes the held-content decision before it.

**Invariant B — tracker (`Tracker`, `BasePins`).** The base of a block's staged updates is fixed at the first update and never replaced while updates remain staged.
- `PinnedBase.block` is optional (a **rev-only pin**: read, evicted, then updated), and `PinnedBase.moved` marks a base the source no longer describes at the pinned revision.
- `Tracker.update` pins only on the first op for the id in *this* tracker (`pinBase`); later ops re-judge the pin (`revalidatePin`): a generation change at the same revision refreshes the clone and generation, a different or absent revision marks it moved. A moved pin is never repaired by re-pinning or by falling back to the live cache.
- `peekMaterialized` returns nothing for a moved or rev-only pin; otherwise `baseRev` is always the pin's revision. Over a drift-aware base source an *unpinned* update (blind, or read-then-cleared-then-updated) now declares nothing even if the cache holds the block by declare time. Only a drift-blind source keeps the live-peek fallback.
- New readers: `stagedBaseRevs(blockIds)` (pinned revision per update-only id, moved or not), `movedBases()` (re-judges every pin of an id this tracker stages as an update and returns the moved ones), `unretainedBases()` (pinned ids the cache describes but does not retain, i.e. handed through unkept).
- `BasePins.adopt` keeps the parent's pin and marks it moved when the atomic brings the same id at a different revision; same revision overwrites (later observation, possibly filling a rev-only pin). `reset(transforms)` retains moved marks for still-staged ids; `reset()` clears everything.

**Invariant C — collection (`Collection`, `TransactionCoordinator`).** A pending action is never pended over a moved base.
- `mustReplay` gained the third reason: `pending.length > 0 && tracker.movedBases().length > 0`.
- `Collection.restageIfBasesMoved()` (public, latch-free by contract like `snapshotPending`): one `sourceCache.tryGet` per *unretained* pinned id, then `movedBases()`, then `replayActions()` if any moved. Logs `collection:restage-moved-base id=… tag=… block=… pinnedRev=… currentRev=…` per moved block.
- Called in `syncAttempts` at the top of every loop iteration (first attempt and retries), and in both coordinator commit spans: `commitOnceLatched` (before the pre-commit snapshots and the log-append loop) and `execute` (after the latches, before the append loop).

## Deviations from the ticket text, with reasons

1. **Re-validation reads only unkept ids, not evicted ones.** The ticket says "for an id the cache does not retain (handed through unkept, or evicted), one `tryGet`". An evicted-but-kept base met every floor the handle knows, so storage cannot have moved it without a log entry the retry refresh will walk (and the pend would be refused as stale on revision alone), while a large transaction (2x or 4x cache capacity, the `digest-cache-coverage` shapes) would otherwise pay one network read per evicted pinned id before *every* attempt. Unkept ids are the ones where storage can have caught up with no log movement; those are read. Documented in `restageIfBasesMoved`'s comment.
2. **Where the coordinator calls it.** "Before `pendPhase`" is too late: the log append has already staged the log-tail transforms into the tracker and captured a live reference to them, and a replay resets the tracker. It runs before the snapshots and the append in both spans; the comment there explains. The snapshot-then-restore bracket on a failed attempt therefore restores transforms that agree with the pins.
3. **Reads of a moved base.** The ticket's "served in the meantime as the pin's block plus operations when the pin has a block" was read as describing what the *digest pass* sees, not what `tryGet` returns. `tryGet` still serves live content plus staged ops (the existing "a staged update over the block does not freeze the too-old base beneath it" test pins that), and never throws for a moved base. If the author meant reads should come from the pinned snapshot, that is a separate change with a different test expectation.
4. **A first-op pin keeps an existing same-revision pin.** Not in the ticket: `Atomic.commit` adopts the atomic's pins into the parent and then replays the atomic's ops through the parent's `update`, so the parent's "first op" would have re-probed a cache that had by then evicted the early bases and overwritten full pins with rev-only ones (the oversized-atomic case in `digest.spec.ts` and the one-act case in `digest-cache-coverage.spec.ts` caught it). `pinBase` keeps an existing unmoved pin whose revision equals the cache's current revision; anything else (an abandoned attempt tracker's stale log-block pin, say) is replaced or dropped.
5. **`peekMaterialized` is no longer strictly state-neutral**: it may record that a pinned base moved (a discovery, not a content change). The doc comment says so.

## Existing tests whose expectations changed

- `cache-source.spec.ts`: "the older of two concurrent answers, arriving second" — the late reader now gets the held content (was: the older answer). "an answer asked for before the id was cleared" — `peek` now describes it as last served (was: undefined); still not retained.
- `refresh-below-floor.spec.ts`: "of two concurrent reads, the too-old answer arriving second" — both readers get `NEW` (was `[NEW, OLD]`).
- `digest.spec.ts`: "stale pin after transformCache(): recomputed from the folded live base" is now the opposite: a base folded to a new revision under a staged update is **moved**, undeclared, and `stagedBaseRevs` still names the old revision. This is the ticket's point; the old test asserted the very re-description being removed.

## New tests

- `cache-source.spec.ts`: overtaken older answer returns held content and records the held revision; unkeepable answer over held content returns it; keepable-but-overtaken over nothing held is handed through; `getCachedRevision` after `tryGet` equals the returned content's revision on the cached, unkept, and evicted-then-reloaded paths.
- `digest.spec.ts` (new describe "the base of a staged update is fixed at the first update"): same-revision bump keeps the digest; different-revision bump marks moved with the pinned revision still reported and a later op never re-pinning; a clear marks moved and stays moved after a same-revision re-read; `stagedBaseRevs` excludes inserted, deleted, and unpinned ids; rev-only pin names its base and declares no digest, and declares once the same revision is re-read; `Atomic` adopt at a different revision marks moved, at the same revision overwrites; `reset(transforms)` keeps the moved mark and `reset()` clears; blind update over a drift-aware source declares nothing.
- `refresh-below-floor.spec.ts` "under staged changes": a `BaseCheckingTransactor` that refuses a commit whose declared base is not the block's latest (mirroring `StorageRepo.internalCommit`) and records requests and refusals. The ticket's scenario through `Tree.stage` then `sync`: (a) with a second read after storage catches up — one `restage-moved-base` line naming the block, the pinned and the current revision; no refusal; the commit declares the current revision; the committed leaf reads `[1, 5, 9]`; (b) with no read in between — the first attempt declares the old revision and is refused, storage catches up on that refusal, the log does not move, the retry re-stages once, the leaf reads `[1, 5, 9]`, no `SyncRetryExhaustedError`; (c) storage never catches up — refused on every attempt, `SyncRetryExhaustedError`, storage holds `[1, 5]` alone; (d) a handle's own commits (two `replace`, two `stage` + `sync`, one more `replace`) produce no `restage-moved-base` line and no refusal.

## What was measured

| Check | Result |
|---|---|
| `yarn workspace @optimystic/db-core test` | 1822 passing |
| `yarn workspace @optimystic/db-p2p test` (after `yarn build`) | 3023 passing, 63 pending (env-gated, pre-existing) |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` + smoke | 997 passing, 13 pending, smoke ok |
| `yarn typecheck` (root, after `yarn build`) | clean |
| `yarn lint:docs` | all resolve |
| Perf guards `tracker-read-perf.spec.ts`, `refresh-read-cost.spec.ts`, plugin `cold-apply-cost.spec.ts` / `index-backfill-cost.spec.ts` | unchanged budgets, green |

## What was not measured, and where to push

- The new scenario tests were **not** run against the pre-change code to prove they would have failed. By analysis, variant (a) is the fork (`[1, 9, 5]` with no refusal, since the old re-pin declared the new revision); variants (b) and (c) already refused before, and (d) is a guard against spurious replays.
- **`TransactionCoordinator.execute`'s restage call has no dedicated test.** The plugin suite drives `commit()`; `execute()` is covered only by existing coordinator specs that stage over stable bases. A multi-collection commit where one participant's base moved (re-stages that participant only; snapshot/restore still bracket the replay) is reasoned about in the coordinator comment, not tested.
- The `restorePending` NOTE now also says that a mid-transaction savepoint restored across a moved boundary leaves the pins describing the replay's bases while the restored ops were computed on the snapshot's. Pre-existing, out of scope, and now visibly named — the pend would declare the wrong base for those ops. If a reviewer thinks that should be a ticket rather than a NOTE, the fix is for `snapshotPending` to carry the pins.
- The narrowing in `peekMaterialized` (an unpinned update over a drift-aware source declares nothing even once the cache holds the block) trades a little digest coverage for never naming a base the operations were not built on. `digest-cache-coverage.spec.ts`'s blind-update carve-out still passes; no production caller updates without reading first, but a reviewer may want to grep for one.
- Concurrent unlatched reads between `restageIfBasesMoved` and the pend can still move a base after the check; the pend then declares the pin's revision, storage refuses, the retry re-validates. Not exercised by a test.
- Memory: `unkept` can now also hold a keepable answer that was overtaken over an id nothing is held for (previously dropped). Bounded by unmet floors plus ids caught mid-flight by a clear or a fold; the map's doc comment says so. Not measured.
