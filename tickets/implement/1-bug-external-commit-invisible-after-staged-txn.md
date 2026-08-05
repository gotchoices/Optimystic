description: When one database node has a transaction open with unsaved changes and another node commits new data at the same time, the first node permanently stops seeing that new data — even after it cancels its own transaction. A one-line reordering fixes it.
files: packages/db-core/src/collection/collection.ts, packages/db-core/test/collection.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-interleave.spec.ts, docs/internals.md
difficulty: easy
repro: verified
----

# `Collection.updateInternal` replays conflicts against the revision it is about to leave

## Root cause (verified — a fix was applied, run, and reverted)

`Collection.updateInternal` (`packages/db-core/src/collection/collection.ts`)
does its conflict replay **before** advancing the revision cursor:

```
312    if (anyConflicts) {
313        await this.replayActions();      // ← re-reads blocks HERE
314    }
...
319    Collection.advanceContext(this.source, this.id, latest?.context);   // ← cursor moves HERE
```

`replayActions()` calls `tracker.reset()` and re-applies the pending actions.
Those re-applications read blocks through `this.sourceCache` — which the loop
above just cleared for every block id named in the newly-consumed log entries —
so each read is a cache MISS that falls through to `this.source`
(`TransactorSource`). `TransactorSource.tryGet` passes `context: this.actionContext`
to `transactor.get`, and the repo honours it: `StorageRepo.get` calls
`blockStorage.getBlock(context?.rev)`, which materialises the block at
`targetRev = rev` (`packages/db-p2p/src/storage/block-storage.ts:60-62`).

At that moment `this.actionContext` is still the **old** revision. So the replay
refills the cache with **pre-commit content**, and only afterwards does the
cursor advance past the log entry that would have justified clearing it again.
Nothing ever re-clears those blocks: `sourceCache.clear` is driven by log
entries, and that entry has been consumed. The divergence is permanent for those
blocks until an unrelated commit happens to touch them again.

This also explains every row of the ticket's observation table — including the
in-transaction one. It is **not** snapshot isolation (see below).

## The fix

Move the `advanceContext` call above the `if (anyConflicts)` block, so the replay
re-reads at the revision the collection is adopting rather than the one it is
leaving. `advanceContext` is already monotonic-guarded and depends on nothing the
replay produces; the invalidation handling above it reads the `actionContext`
local captured at line 271, so it is unaffected by the move.

Measured with that reorder in place:

| Read | Before | After |
| --- | --- | --- |
| A in-txn, after B's external commit | `[1,3,4,100]` | `[1,3,4,6,100]` |
| A after `rollback` | `[1,3,4]` | `[1,3,4,6]` |
| A after `rollback`, second read | `[1,3,4]` | `[1,3,4,6]` |

Full suites run with the reorder applied, both green:
`yarn test` in `packages/db-core` → 1345 passing;
`yarn test` in `packages/quereus-plugin-optimystic` → 359 passing, 11 pending.
Notably the committed-read pinning specs (`committed-read-interleave`,
`committed-read-isolation`, `committed-read-conformance`) still pass — the
reorder does not disturb the pinned-snapshot machinery, which pins via
`CollectionSnapshot.context` and is independent of the live cursor.

## Answering the source ticket's first question: no, this was not intended isolation

In-transaction invisibility of a concurrent external commit was **not** a
deliberate snapshot-isolation choice; it was this same bug. A plain
`select ... from Item` is a LIVE read, and the vtab read path deliberately pulls
first (`optimystic-module.ts` calls `tree.update()` before serving rows —
see `packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts`).
Snapshot semantics live in the *separate* `committed.<Table>` path, which builds
a pinned view via `Collection.createReadTracker`. So a live read seeing `6`
mid-transaction is the correct semantics, and that is what the fix produces.

## Write-path corollary (same site, no extra change needed)

`syncInternal` calls `updateInternal()` after a stale failure and then retries
with `newRev = actionContext.rev + 1`. Under the old order the retry's transforms
were rebuilt against the **stale** base while being submitted at the new
revision. The same reorder corrects that resubmission too; no separate change is
required, but a test that exercises a losing sync retry is worth having.

## Not in scope

A second, independent defect surfaced during this investigation — a block
materialised at a pinned revision is reported with the node's *newest* revision,
so read dependencies claim a freshness they do not have. Different package,
different site, no shared code with this fix. Filed separately as
`bug-pinned-get-reports-latest-revision`. Neither ticket blocks the other.

## TODO

- Move `Collection.advanceContext(this.source, this.id, latest?.context)` in
  `updateInternal` to just above the `if (anyConflicts) { await this.replayActions(); }`
  block. Keep the existing explanatory comment with it, and add a sentence naming
  the ordering constraint (replay must read at the adopted revision) so the two
  statements are not re-swapped later.
- Add a db-core unit regression test in `packages/db-core/test/collection.spec.ts`
  (the multi-collection conflict tests around lines 133-160 and 325-355 are the
  model): collection A stages a pending action, collection B commits a change to
  an overlapping block, A calls `update()`, and A's subsequent reads must observe
  B's committed content. Assert on the read *after* the update, not just the
  revision cursor — the cursor advanced correctly even while the bug was present.
- Add an end-to-end regression test in `packages/quereus-plugin-optimystic/test/`
  covering the ticket's exact shape: two `Database` instances over one
  `StorageRepo`/`MemoryRawStorage` transactor, A opens a transaction and stages a
  row, B commits a row, A rolls back, A's next read must include B's row. Copy the
  transactor/registration wiring verbatim from
  `test/committed-read-interleave.spec.ts` (lines 33-61); note the specs import the
  built plugin from `../dist/plugin.js`, so `yarn build` must run first. Assert the
  post-rollback read *twice* — the persistence of the loss is the interesting half.
- Add a test that a losing `sync()` retry (stale failure → `updateInternal()` →
  resubmit) rebuilds its transforms against the adopted revision, covering the
  write-path corollary above.
- Update `docs/internals.md` (it already discusses the live read's `update()`
  clearing the shared cache, around line 60) to state the ordering rule plainly:
  the revision cursor advances before conflict replay, because replay re-reads
  through the transactor and the transactor materialises at `context.rev`. State
  the live-vs-committed read rule explicitly while there — a live read pulls and
  therefore sees concurrent external commits, including inside an open
  transaction; only `committed.<Table>` is snapshot-pinned.
- Run `yarn test` in both `packages/db-core` and
  `packages/quereus-plugin-optimystic` (the plugin suite takes ~2 minutes; stream
  output rather than redirecting it silently).
