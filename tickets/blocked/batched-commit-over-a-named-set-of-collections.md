description: A consumer that must create many empty collections at once, like Sereus founding a new party, pays a separate transaction and two disk barriers for each one, because the batched commit the SQL bridge already performs is reachable only from the bridge's own dirty-tree set. Sereus asks for that batch to be callable with a set of collections the caller names. Waiting on the maintainer to decide whether to expose it.
architecture: packages/db-p2p/docs/storage.md
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/src/transaction/coordinator.ts
difficulty: easy
----

**Blocked: a maintainer decision.** Filed from Sereus (`tickets/blocked/report-control-genesis-commits-one-collection-at-a-time` there). Unblocks when the maintainer accepts the API below, or declines it; Sereus has accepted the current cost and pinned it with a budget, so declining is a reasonable outcome.

# A batched commit over a named set of collections

## What the consumer does

Before a Sereus party has an owner, the founding machine gives every control table, index and uniqueness check an empty collection, so later reads of a table nobody has written are answered from local storage instead of asking other machines to prove it empty. Today that is 35 collections. Each one is committed by its own `collection.sync()`, so each is a separate transaction with its own pend and commit. Strand founding runs the same step for app schemas.

## What it costs

Measured 2026-11-23 against npm Optimystic 1.29.1, idle developer machine, file-backed storage, one genesis per run:

- About 2.0–2.9 s on file storage, 0.1–0.35 s in memory. The operation count is identical across runs and backends: 1,010 raw-storage operations over 105 blocks, plus 183 `flush` barriers.
- Of a 2,124 ms run, the barriers from `StorageRepo.pend` → `endGroup` (37 calls, 405 ms) and `StorageRepo.commit` → `endGroup` (37 calls, 1,030 ms) are two thirds of the whole. 35 of those 37 pairs are the empty collections.
- The commit-proof store is not the cost: `saveProofEntry`, `saveCommitProof` and `getCommitProof` together are under 30 ms.
- Two barriers per commit are the write-order invariant, not waste. The lever is fewer commits.

Each added collection costs about 60 ms on a desktop disk. On phone flash under launch contention it is tens of seconds in total.

## The ask

`TransactionBridge.commitBatchLegacy` already builds a `TransactionCoordinator` over the collections of one commit, pends them all, then commits them all, including partial-commit recovery. `legacyBatch` reaches it only through the bridge's dirty-tree set, which a collection that was created but never written never joins. Make that path callable with a caller-named set of collections, from the plugin or from db-core.

Expected effect, by arithmetic and not yet measured: 74 barriers become 4, and founding drops from about 2.1 s to about 0.5 s.

## Already tried in Sereus, and why not

- **Issuing the syncs concurrently** with `Promise.all`: no improvement, because the file store's write group serializes them.
- **A private batching path over `TransactionCoordinator`** in Sereus: possible, since the pieces are exported, but it would duplicate the bridge's partial-commit recovery in a repository that does not own those invariants.
- **Making the empty collections look dirty** so an ordinary SQL commit sweeps them: needs a write and an undo per table, which costs more than it saves.

## Sereus side, once it exists

`syncInventedCollections` in `@serfab/quereus-plugin-sereus` replaces its per-collection loop with one call, and the genesis storage budget in Sereus is re-measured.
