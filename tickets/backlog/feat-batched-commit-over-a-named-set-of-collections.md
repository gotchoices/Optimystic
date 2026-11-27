description: An application that creates many empty collections at once, like Sereus founding a new party, commits each one as its own transaction. Letting it commit a set of collections it names as one transaction would let that work share the single disk wait per step that the storage change ahead of this one makes possible.
prereq: a-batch-of-collections-is-applied-to-storage-under-one-flush
architecture: docs/internals.md#one-commit-round-when-one-coordinator-covers-every-block
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`TransactionBridge.commitBatchLegacy`, `TransactionBridge.legacyBatch`), packages/db-core/src/transaction/coordinator.ts (`TransactionCoordinator`)
tradeoffs: Sereus has accepted the current cost and pinned it with a budget, and the reusable win is the storage change this depends on; a public named-set commit is new API surface to keep correct (partial-commit recovery, collections with nothing but an invented header staged) for one caller.
----

Decided n8allan, 2026-11-27: not now — parked in backlog. The flush cost Sereus measured is addressed in storage first (`a-batch-of-collections-is-applied-to-storage-under-one-flush`); this API is what lets Sereus's founding step reach that path.

Filed from Sereus (`tickets/blocked/report-control-genesis-commits-one-collection-at-a-time` there).

# A batched commit over a named set of collections

## What the consumer does

Before a Sereus party has an owner, the founding machine gives every control table, index and uniqueness check an empty collection, so later reads of a table nobody has written are answered from local storage instead of asking other machines to prove it empty. Today that is 35 collections. Each is committed by its own `collection.sync()`, so each is a separate transaction with its own pend and commit. Strand founding runs the same step for app schemas.

## What it costs

Measured by Sereus 2026-11-23 against npm Optimystic 1.29.1, idle developer machine, file-backed storage, one genesis per run: about 2.0–2.9 s on file storage, 0.1–0.35 s in memory; 1,010 raw-storage operations over 105 blocks, plus 183 `flush` calls. Of a 2,124 ms run, the flushes at the end of `StorageRepo.pend` (37 calls, 405 ms) and `StorageRepo.commit` (37 calls, 1,030 ms) were two thirds. 35 of those 37 pairs are the empty collections. On phone flash under launch contention it is tens of seconds in total.

## Why the API alone would not help, and what does

Sereus's original estimate (74 flushes becoming 4) assumed that a batched commit flushes once per step. It did not: a batch travels as one pend record and one commit record, but storage applied each collection in it as a separate `StorageRepo.pend` / `commit` call with its own flush (`CoordinatorRepo.applyPendsInOrder`, `applyCommitsInOrder`, and the cluster member's equivalents). So this API on its own would have saved the per-collection refresh and round trips and kept about 70 flushes.

The prereq ticket makes storage apply a whole record under one flush. That helps every multi-collection write by itself (every SQL transaction over a table with indexes). Sereus's founding step benefits only once its 35 collections travel as one batch, which is this ticket.

## The ask

`TransactionBridge.commitBatchLegacy` builds a `TransactionCoordinator` over the collections of one commit, pends them all, then commits them all, including partial-commit recovery. `legacyBatch` reaches it only through the bridge's dirty-tree set, which a collection that was created but never written never joins. Make that path callable with a caller-named set of collections, from the plugin or from db-core.

To check before designing: whether `TransactionCoordinator` commits a collection whose only staged state is its created-but-never-written header, log block and root (no actions in its open segment); `getPendingActions` and the coordinator's "has staged changes" test may skip it.

## Already tried in Sereus, and why not

- **Issuing the syncs concurrently** with `Promise.all`: no improvement, because the file store's write group serializes them.
- **A private batching path over `TransactionCoordinator`** in Sereus: possible, but it would duplicate the bridge's partial-commit recovery in a repository that does not own those invariants.
- **Making the empty collections look dirty** so an ordinary SQL commit sweeps them: needs a write and an undo per table, which costs more than it saves.

## Sereus side, once it exists

`syncInventedCollections` in `@serfab/quereus-plugin-sereus` replaces its per-collection loop with one call, and the genesis storage budget in Sereus is re-measured.
